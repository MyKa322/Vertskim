import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Project } from "../project.js";
import { copyFixture, removeTempDirs, snapshot, tempDir, write } from "../testing/helpers.js";
import { MAX_NOTE_LENGTH } from "./notes.js";

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
    assert.deepEqual(project.searchNotes("idempotent retries").map((n) => n.nodeId), [ROTATE]);
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
    const gone = project.listNotes().filter((n) => n.orphaned).map((n) => n.nodeId).sort();
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
