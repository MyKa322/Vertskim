import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Project } from "./project.js";
import { copyFixture, edge, removeTempDirs, tempDir, write } from "./testing/helpers.js";

after(removeTempDirs);

const SESSION = "src/auth/session.ts";
const SYMBOLS = [
  "src/auth/session.ts#Session",
  "src/auth/session.ts#BaseStore",
  "src/auth/session.ts#BaseStore.loadSession",
  "src/auth/session.ts#SessionStore",
  "src/auth/session.ts#SessionStore.refresh",
  "src/auth/session.ts#SessionStore.persist",
];

describe("files that do not parse", () => {
  test("keep the symbols of their last good version until they parse again", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      const good = readFileSync(join(root, SESSION), "utf8");
      // An edit in progress: a function being written at the top, with an unclosed parenthesis.
      // The parser then wraps the whole file in one error and recognises none of its declarations.
      const broken = `export function draft(): number {\n  if (ready( {\n    return 1;\n  }\n  return 0;\n}\n\n${good}`;
      write(root, SESSION, broken, 1);
      await project.sync();

      for (const id of SYMBOLS) assert.ok(project.node(id), `${id} is still there`);
      assert.equal(project.node("src/auth/session.ts#draft"), null);
      assert.equal(
        edge(project, "src/api/middleware.ts#requireAuth", "calls", "src/auth/session.ts#SessionStore.refresh")
          ?.confidence,
        "resolved",
      );
      const [error] = project.status().syntaxErrors;
      assert.equal(error?.path, SESSION);
      assert.equal(error?.keptSymbols, true);
      assert.ok(error!.line <= 6, `error reported at line ${error?.line}`);
      assert.deepEqual(project.syntaxError(SESSION), error);
      // Nothing to do while the file stays as it is.
      assert.equal((await project.sync({ full: true })).changed, 0);

      // Fixed again: the new version replaces the old, and the error is gone.
      write(root, SESSION, good.replace("async refresh(", "async renew("), 2);
      await project.sync();
      assert.deepEqual(project.status().syntaxErrors, []);
      assert.ok(project.node("src/auth/session.ts#SessionStore.renew"));
      assert.equal(project.node("src/auth/session.ts#SessionStore.refresh"), null);
    } finally {
      await project.close();
    }
  });

  test("a new file that does not parse is indexed as far as it goes, and flagged", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      write(
        root,
        "src/draft.ts",
        "export function first(): number {\n  return 1;\n}\n\nexport function second( {\n",
        1,
      );
      await project.sync();
      assert.ok(project.node("src/draft.ts#first"));
      const error = project.syntaxError("src/draft.ts");
      assert.equal(error?.keptSymbols, false);
      assert.equal(error?.line, 5);
    } finally {
      await project.close();
    }
  });

  test("an edit that breaks nothing it loses is taken as it is", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      // A stray character inside a function body: every symbol still parses.
      const text = readFileSync(join(root, "src/auth/tokens.ts"), "utf8");
      write(root, "src/auth/tokens.ts", text.replace("return randomUUID();", "return randomUUID();)"), 1);
      await project.sync();
      const error = project.syntaxError("src/auth/tokens.ts");
      assert.ok(error);
      assert.equal(error.keptSymbols, false);
      assert.ok(project.node("src/auth/tokens.ts#rotate"));
    } finally {
      await project.close();
    }
  });
});

describe("text encodings", () => {
  test("files saved as UTF-16 or with a UTF-8 byte-order mark are read correctly", async () => {
    const root = copyFixture();
    const source = "export function wide(): void {}\n\nexport class Narrow {\n  run(): void {}\n}\n";
    writeFileSync(
      join(root, "src/wide-le.ts"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]),
    );
    const be = Buffer.from(source, "utf16le");
    be.swap16();
    writeFileSync(join(root, "src/wide-be.ts"), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    writeFileSync(
      join(root, "src/bom.ts"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, "utf8")]),
    );
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      for (const file of ["src/wide-le.ts", "src/wide-be.ts", "src/bom.ts"]) {
        assert.ok(project.node(`${file}#wide`), `${file}: function found`);
        assert.ok(project.node(`${file}#Narrow.run`), `${file}: method found`);
        assert.equal(project.syntaxError(file), null);
        const slice = project.readSource(project.node(`${file}#wide`)!);
        assert.equal(slice?.text, "export function wide(): void {}");
      }
    } finally {
      await project.close();
    }
  });
});
