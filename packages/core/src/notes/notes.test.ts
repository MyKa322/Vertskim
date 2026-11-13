import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Project } from "../project.js";
import { copyFixture, removeTempDirs, snapshot, tempDir, write } from "../testing/helpers.js";
import { MAX_NOTE_LENGTH, NOTES_VERSION } from "./notes.js";

after(removeTempDirs);

describe("notes", () => {
  let root: string;
  let dataDir: string;
  let project: Project;
  const ROTATE = "src/auth/tokens.ts#rotate";
  const ISSUE = "src/auth/tokens.ts#issueToken";

  before(async () => {
    root = copyFixture();
    dataDir = tempDir("data");
    project = Project.open({ root, dataDir });
    await project.sync();
  });
  after(() => project.close());

  test("nothing is created until the first note is written", () => {
    assert.deepEqual(project.listNotes(), []);
    assert.deepEqual(project.noteCounts(), { notes: 0, nodes: 0 });
    assert.equal(existsSync(join(dataDir, "notes.db")), false);
  });

  test("are kept with their node, in the data folder and never in the project", () => {
    const before_ = snapshot(root);
    const note = project.addNote(ROTATE, "  Rotation must stay idempotent:\r\nretries call it twice.  ", "tester");
    assert.equal(note.id, 1);
    assert.equal(note.text, "Rotation must stay idempotent:\nretries call it twice.");
    assert.equal(note.author, "tester");
    assert.equal(note.stale, false);
    project.addNote(ISSUE, "Tokens are opaque; nothing may parse them.");
    project.addNote("src/auth/", "Everything about sessions and tokens lives here.");
    project.addNote("./src/auth/tokens.ts", "Second look: fine."); // ids are normalised like everywhere else

    assert.deepEqual(snapshot(root), before_);
    assert.equal(existsSync(join(dataDir, "notes.db")), true);
    assert.deepEqual(project.noteCounts(), { notes: 4, nodes: 4 });
    assert.deepEqual(
      project.listNotes().map((n) => n.nodeId),
      ["src/auth/tokens.ts", "src/auth/", ISSUE, ROTATE], // newest first
    );
    const byNode = project.notesFor([ROTATE, ISSUE, "src/index.ts"]);
    assert.equal(byNode.get(ROTATE)?.length, 1);
    assert.equal(byNode.get("src/index.ts"), undefined);
  });

  test("refuse a node that does not exist, and text that is empty or too long", () => {
    assert.throws(() => project.addNote("src/nope.ts", "x"), /no such node/);
    assert.throws(() => project.addNote(ROTATE, "   \n "), /empty/);
    assert.throws(() => project.addNote(ROTATE, "x".repeat(MAX_NOTE_LENGTH + 1)), /limit/);
    assert.equal(project.noteCounts().notes, 4);
  });

  test("can be found by their words", () => {
    assert.deepEqual(
      project.searchNotes("idempotent retries").map((n) => n.nodeId),
      [ROTATE],
    );
    assert.deepEqual(project.searchNotes("opaque"), project.searchNotes("OPAQUE"));
    assert.deepEqual(project.searchNotes("100%"), []); // a wildcard character is only a character
  });

  test("are flagged once the code they describe changes, and only then", async () => {
    const file = join(root, "src/auth/tokens.ts");
    // Change the body of `rotate` and nothing else.
    write(root, "src/auth/tokens.ts", readFileSync(file, "utf8").replace("token.length", "token.length + 1"), 1);
    await project.sync();
    const notes = project.notesFor([ROTATE, ISSUE, "src/auth/tokens.ts", "src/auth/"]);
    assert.equal(notes.get(ROTATE)?.[0]?.stale, true);
    assert.equal(notes.get(ISSUE)?.[0]?.stale, false); // same file, untouched function
    assert.equal(notes.get("src/auth/tokens.ts")?.[0]?.stale, true); // a note on the file follows the file
    assert.equal(notes.get("src/auth/")?.[0]?.stale, false); // a directory has no source to compare
  });

  test("survive a rebuild of the index, and outlive their node", async () => {
    await project.rebuild();
    assert.equal(project.noteCounts().notes, 4);
    rmSync(join(root, "src/auth/tokens.ts"));
    await project.sync();
    const gone = project
      .listNotes()
      .filter((n) => n.orphaned)
      .map((n) => n.nodeId)
      .sort();
    assert.deepEqual(gone, ["src/auth/tokens.ts", ISSUE, ROTATE].sort());
    assert.equal(project.listNotes().find((n) => n.nodeId === "src/auth/")?.orphaned, false);
  });

  test("another process sees them and can tell when they change", async () => {
    const other = Project.open({ root, dataDir });
    const stamp = other.noteStamp();
    assert.equal(other.noteCounts().notes, 4);
    const added = project.addNote("src/index.ts", "Entry point.");
    assert.notEqual(other.noteStamp(), stamp);
    assert.equal(other.notesFor(["src/index.ts"]).get("src/index.ts")?.[0]?.text, "Entry point.");
    assert.equal(other.removeNote(added.id)?.nodeId, "src/index.ts");
    assert.equal(other.removeNote(added.id), null);
    assert.equal(project.noteCounts().notes, 4);
    await other.close();
  });
});

describe("notes that outlive their code", () => {
  test("follow a file or symbol that moves, and stay behind when the code is gone", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      const onFile = project.addNote("src/auth/tokens.ts", "Token helpers; keep them free of I/O.", "test");
      const onSymbol = project.addNote("src/auth/session.ts#SessionStore.refresh", "Must stay idempotent.", "test");
      const onGone = project.addNote("src/utils/log.ts#info", "Only for the command line.", "test");

      // tokens.ts is renamed as it is; refresh moves, unchanged, into a new file; info is deleted.
      const tokens = readFileSync(join(root, "src/auth/tokens.ts"), "utf8");
      rmSync(join(root, "src/auth/tokens.ts"));
      write(root, "src/auth/token-utils.ts", tokens, 1);
      const session = readFileSync(join(root, "src/auth/session.ts"), "utf8");
      const start = session.indexOf("  /**\n   * Rotates");
      const end = session.indexOf("  private async persist");
      write(root, "src/auth/session.ts", session.slice(0, start) + session.slice(end), 2);
      write(root, "src/auth/refresh.ts", `export class SessionStore {\n${session.slice(start, end)}}\n`, 3);
      write(
        root,
        "src/utils/log.ts",
        readFileSync(join(root, "src/utils/log.ts"), "utf8").replace(/export function info[\s\S]*$/, ""),
        4,
      );
      await project.sync();

      const byId = new Map(project.listNotes().map((n) => [n.id, n]));
      assert.equal(byId.get(onFile.id)?.nodeId, "src/auth/token-utils.ts");
      assert.equal(byId.get(onFile.id)?.orphaned, false);
      assert.equal(byId.get(onFile.id)?.stale, false);
      assert.equal(byId.get(onSymbol.id)?.nodeId, "src/auth/refresh.ts#SessionStore.refresh");
      assert.equal(byId.get(onSymbol.id)?.stale, false);
      assert.equal(byId.get(onGone.id)?.nodeId, "src/utils/log.ts#info");
      assert.equal(byId.get(onGone.id)?.orphaned, true);
    } finally {
      await project.close();
    }
  });

  test("a notes file written by a newer version is shown but not changed", async () => {
    const root = copyFixture();
    const dataDir = tempDir("data");
    const project = Project.open({ root, dataDir });
    await project.sync();
    project.addNote("src/auth/tokens.ts#rotate", "Written by this version.", "test");
    await project.close();

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "notes.db"));
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, NOTES_VERSION);
    db.exec(`PRAGMA user_version = ${NOTES_VERSION + 1}`);
    db.close();

    const reopened = Project.open({ root, dataDir });
    try {
      await reopened.sync();
      assert.equal(reopened.listNotes()[0]?.text, "Written by this version.");
      assert.throws(
        () => reopened.addNote("src/auth/tokens.ts#rotate", "Another one.", "test"),
        /newer version of Vertskim/,
      );
    } finally {
      await reopened.close();
    }
  });
});
