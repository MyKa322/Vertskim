import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Project } from "./project.js";
import { copyFixture, dump, edge, linkTo, removeTempDirs, snapshot, tempDir, write } from "./testing/helpers.js";

after(removeTempDirs);

describe("indexing the sample project", () => {
  let root: string;
  let project: Project;
  let before_: string[];

  before(async () => {
    root = copyFixture();
    before_ = snapshot(root);
    project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
  });
  after(() => project.close());

  test("creates nodes for files, directories, symbols and doc sections", () => {
    const kind = (id: string) => project.node(id)?.kind;
    assert.equal(kind("src/auth/session.ts"), "file");
    assert.equal(kind("src/auth/"), "directory");
    assert.equal(kind("src/auth/session.ts#SessionStore"), "class");
    assert.equal(kind("src/auth/session.ts#SessionStore.refresh"), "method");
    assert.equal(kind("src/auth/session.ts#Session"), "interface");
    assert.equal(kind("src/api/middleware.ts#Handler"), "type");
    assert.equal(kind("src/auth/tokens.ts#TOKEN_TTL_SECONDS"), "variable");
    assert.equal(kind("tools/models.py#WeightedRecord.scaled"), "method");
    assert.equal(kind("docs/architecture.md#session-lifecycle"), "section");
    assert.equal(kind("assets/logo.svg"), "file");
    assert.equal(project.node("tests/session.test.ts")?.subkind, "test");
    assert.equal(kind("README.md#this-heading-inside-a-fence-must-not-become-a-section"), undefined);
  });

  test("records signatures, doc comments and line spans", () => {
    const refresh = project.node("src/auth/session.ts#SessionStore.refresh")!;
    assert.equal(refresh.signature, "async refresh(token: string): Promise<Session>");
    assert.equal(refresh.doc, "Rotates the refresh token and extends the session TTL.");
    const source = project.readSource(refresh)!;
    assert.match(source.text, /^\s*\/\*\*/);
    assert.match(source.text, /return next;\s*\n\s*}$/);

    const describe_ = project.node("tools/models.py#Record.describe")!;
    assert.equal(describe_.signature, "def describe(self) -> str");
    assert.equal(describe_.doc, "Human-readable summary of the row.");
    assert.equal(project.node("src/auth/session.ts#SessionStore")!.exported, 2);
    assert.equal(project.node("tools/formatting.py#_private_helper")!.exported, 0);
  });

  test("resolves calls through imports, namespaces, re-exports and base classes", () => {
    const refresh = "src/auth/session.ts#SessionStore.refresh";
    assert.equal(edge(project, refresh, "calls", "src/auth/tokens.ts#rotate")?.confidence, "resolved");
    assert.equal(edge(project, refresh, "calls", "src/utils/log.ts#warn")?.confidence, "resolved");
    assert.equal(edge(project, refresh, "calls", "src/auth/session.ts#SessionStore.persist")?.confidence, "resolved");
    // inherited through `extends BaseStore`
    assert.ok(edge(project, refresh, "calls", "src/auth/session.ts#BaseStore.loadSession"));
    // imported from the barrel file, defined in tokens.ts
    assert.ok(edge(project, "src/api/routes.ts#login", "calls", "src/auth/tokens.ts#issueToken"));
    // default import
    assert.ok(edge(project, "src/api/routes.ts#store", "calls", "src/auth/session.ts#SessionStore"));
    assert.ok(edge(project, "src/auth/session.ts#SessionStore", "extends", "src/auth/session.ts#BaseStore"));
    assert.ok(edge(project, "src/db/redis.ts#RedisClient", "implements", "src/db/redis.ts#KeyValueStore"));
    assert.equal(edge(project, "src/auth/session.ts", "imports", "src/auth/tokens.ts")?.confidence, "exact");
    assert.ok(edge(project, "src/auth/tokens.ts", "imports", "ext:node/crypto"));
  });

  test("marks name-only matches as heuristic and skips ambiguous ones", () => {
    // `record.label()`: nothing says what `record` is, and one method is called label
    assert.equal(
      edge(project, "tools/report.py#build_report", "calls", "tools/models.py#Record.label")?.confidence,
      "heuristic",
    );
    // `record.describe()`: two methods are called describe, so no edge is guessed
    const guesses = project.store.db
      .prepare("SELECT COUNT(*) AS c FROM edges WHERE src = ? AND dst LIKE '%.describe'")
      .get("tools/report.py#build_report");
    assert.equal(guesses?.c, 0);
  });

  test("uses the types written on parameters, fields and variables", () => {
    // `store.refresh(token)` with `store: SessionStore`
    assert.equal(
      edge(project, "src/api/middleware.ts#requireAuth", "calls", "src/auth/session.ts#SessionStore.refresh")
        ?.confidence,
      "resolved",
    );
    // `this.db.fetch(...)`, where `db` is a constructor parameter property typed as an interface
    assert.equal(
      edge(project, "src/auth/session.ts#BaseStore.loadSession", "calls", "src/db/redis.ts#KeyValueStore.fetch")
        ?.confidence,
      "resolved",
    );
    assert.equal(
      edge(project, "src/auth/session.ts#BaseStore.loadSession", "calls", "src/db/redis.ts#RedisClient.fetch"),
      null,
    );
    // `const store = new SessionStore(...); store.refresh(...)`
    assert.equal(
      edge(project, "tests/session.test.ts#refreshRotatesToken", "calls", "src/auth/session.ts#SessionStore.refresh")
        ?.confidence,
      "resolved",
    );
  });

  test("resolves Python relative imports, aliases, module imports and super()", () => {
    const build = "tools/report.py#build_report";
    assert.equal(edge(project, build, "calls", "tools/formatting.py#bullet")?.weight, 2);
    assert.ok(edge(project, build, "calls", "tools/report.py#load_records"));
    assert.ok(edge(project, "tools/report.py#load_records", "calls", "tools/models.py#WeightedRecord"));
    assert.ok(edge(project, "tools/models.py#WeightedRecord", "extends", "tools/models.py#Record"));
    assert.ok(edge(project, "tools/models.py#WeightedRecord.describe", "calls", "tools/models.py#Record.describe"));
    assert.ok(
      edge(project, "tools/models.py#WeightedRecord.describe", "calls", "tools/models.py#WeightedRecord.scaled"),
    );
    assert.ok(edge(project, "tools/report.py", "imports", "ext:py/json"));
    assert.ok(edge(project, "tools/tests/test_report.py", "tests", "tools/report.py"));
  });

  test("links docs to files, sections and symbols", () => {
    assert.equal(
      edge(project, "README.md#layout", "links_to", "docs/architecture.md#session-lifecycle")?.confidence,
      "exact",
    );
    assert.ok(edge(project, "README.md#layout", "links_to", "assets/logo.svg"));
    assert.ok(edge(project, "docs/architecture.md#reporting", "links_to", "tools/"));
    assert.ok(edge(project, "README.md#layout", "mentions", "src/auth/session.ts"));
    assert.equal(
      edge(project, "docs/architecture.md#session-lifecycle", "mentions", "src/auth/session.ts#SessionStore.refresh")
        ?.confidence,
      "heuristic",
    );
  });

  test("search puts the best match first and honours filters", () => {
    const top = (query: string, extra = {}) => project.search({ query, ...extra }).hits[0]?.node.id;
    assert.equal(top("SessionStore"), "src/auth/session.ts#SessionStore");
    assert.equal(top("session refresh"), "src/auth/session.ts#SessionStore.refresh");
    assert.equal(top("rotate"), "src/auth/tokens.ts#rotate");
    assert.equal(top("auth/session.ts"), "src/auth/session.ts");
    assert.equal(top("describe", { path: "tools" }), "tools/models.py#Record.describe");
    const interfaces = project.search({ query: "session", kinds: ["interface"] }).hits;
    assert.equal(interfaces[0]?.node.id, "src/auth/session.ts#Session");
    assert.ok(interfaces.every((h) => h.node.kind === "interface"));
    assert.deepEqual(project.search({ query: "nothingmatchesthis" }), { hits: [], partial: false });
  });

  test("search says when it could only match some of the words", () => {
    assert.equal(project.search({ query: "session refresh" }).partial, false);
    const loose = project.search({ query: "rotate zebra" });
    assert.equal(loose.partial, true);
    assert.equal(loose.hits[0]?.node.id, "src/auth/tokens.ts#rotate");
  });

  test("suggests likely ids for a wrong one", () => {
    const ids = (input: string) => project.suggest(input).map((n) => n.id);
    assert.ok(ids("src/auth/sesion.ts#SessionStore").includes("src/auth/session.ts#SessionStore"));
    // right file, wrong symbol: the file itself comes first
    assert.equal(ids("src/auth/session.ts#SessionStore.refesh")[0], "src/auth/session.ts");
    assert.ok(ids("lib/tokens.ts").includes("src/auth/tokens.ts"));
    assert.deepEqual(ids("nope/zzzz.qq"), []);
  });

  test("neighbors of a file include relationships of its members", () => {
    const file = project.node("src/auth/session.ts")!;
    const incoming = project.neighbors(file, { direction: "in" });
    const caller = incoming.neighbors.find(
      (n) => n.kind === "calls" && n.node.id === "src/api/middleware.ts#requireAuth",
    );
    assert.equal(caller?.via, "src/auth/session.ts#SessionStore.refresh");
    assert.ok(incoming.neighbors.every((n) => n.node.path !== "src/auth/session.ts"));

    const warn = project.node("src/utils/log.ts#warn")!;
    const twoHops = project.neighbors(warn, { direction: "in", depth: 2, edgeKinds: ["calls"] });
    assert.ok(twoHops.neighbors.some((n) => n.depth === 2 && n.node.id === "src/api/middleware.ts#requireAuth"));
  });

  test("tolerates the ways ids get mangled", () => {
    assert.equal(project.node("src\\auth\\session.ts")?.id, "src/auth/session.ts");
    assert.equal(project.node("./src/auth")?.id, "src/auth/");
    assert.equal(project.node(join(root, "src", "index.ts"))?.id, "src/index.ts");
    assert.equal(project.node(".")?.id, "./");
    assert.equal(project.node("src/nope.ts"), null);
  });

  test("is the same project when reached through a link", async (t) => {
    const link = linkTo(root);
    if (!link) {
      t.skip("links cannot be made here");
      return;
    }
    const linked = Project.open({ root: link, dataDir: tempDir("data") });
    try {
      await linked.sync();
      assert.equal(linked.root, project.root);
      // An absolute path is understood in either spelling.
      assert.equal(linked.node(join(link, "src", "index.ts"))?.id, "src/index.ts");
      assert.equal(linked.node(join(root, "src", "index.ts"))?.id, "src/index.ts");
      assert.equal(linked.node(`${join(link, "src", "auth", "session.ts")}#SessionStore`)?.kind, "class");
      assert.equal(linked.node(join(link, "src", "auth"))?.id, "src/auth/");
      // A file that is not there is still not there, and a path outside the project still is outside.
      assert.equal(linked.node(join(link, "src", "nope.ts")), null);
      assert.equal(linked.node(join(link, "..", "elsewhere.ts")), null);
      assert.deepEqual(dump(linked), dump(project));
    } finally {
      await linked.close();
    }
  });

  test("leaves the project directory untouched", () => {
    assert.deepEqual(snapshot(root), before_);
  });
});

describe("incremental sync", () => {
  test("ends in the same state as indexing from scratch", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
    const refresh = "src/auth/session.ts#SessionStore.refresh";
    assert.ok(edge(project, refresh, "calls", "src/auth/tokens.ts#rotate"));

    // 1. rename a function that other files call and docs mention
    const tokens = readFileSync(join(root, "src/auth/tokens.ts"), "utf8");
    write(root, "src/auth/tokens.ts", tokens.replace("function rotate(", "function rotateToken("), 1);
    let result = await project.sync();
    assert.equal(result.changed, 1);
    assert.equal(edge(project, refresh, "calls", "src/auth/tokens.ts#rotate"), null);
    assert.equal(project.node("src/auth/tokens.ts#rotate"), null);
    assert.ok(project.node("src/auth/tokens.ts#rotateToken"));

    // 2. add a caller with an untyped receiver, add a doc, remove a module another file imports
    const poke = "src/utils/poke.ts#poke";
    write(root, "src/utils/poke.ts", "export function poke(target: any): void {\n  target.refresh();\n}\n", 2);
    write(root, "docs/notes.md", "# Notes\n\nSee `SessionStore` and [log](../src/utils/log.ts).\n", 2);
    rmSync(join(root, "tools/formatting.py"));
    result = await project.sync();
    assert.equal(result.added, 2);
    assert.equal(result.removed, 1);
    // only one method is called refresh, so the call is matched by name
    assert.equal(edge(project, poke, "calls", refresh)?.confidence, "heuristic");
    assert.ok(edge(project, "docs/notes.md#notes", "mentions", "src/auth/session.ts#SessionStore"));
    assert.ok(edge(project, "docs/notes.md#notes", "links_to", "src/utils/log.ts"));
    assert.equal(project.node("tools/formatting.py"), null);
    assert.equal(edge(project, "tools/report.py", "imports", "tools/formatting.py"), null);

    // 3. a second `refresh` appears elsewhere: the guess in the untouched file must go
    write(root, "src/utils/cache.ts", "export class Cache {\n  refresh(): void {}\n}\n", 3);
    await project.sync();
    assert.equal(edge(project, poke, "calls", refresh), null);
    // a caller that imports the defining file keeps its edge
    assert.ok(edge(project, "src/api/middleware.ts#requireAuth", "calls", refresh));

    // 4. undo: the original name returns and the second `refresh` goes away
    write(root, "src/auth/tokens.ts", tokens, 4);
    rmSync(join(root, "src/utils/cache.ts"));
    await project.sync();
    assert.ok(edge(project, refresh, "calls", "src/auth/tokens.ts#rotate"));
    assert.equal(edge(project, poke, "calls", refresh)?.confidence, "heuristic");
    assert.equal(project.node("src/utils/cache.ts"), null);

    const fresh = Project.open({ root, dataDir: tempDir("data") });
    await fresh.sync();
    assert.deepEqual(dump(project), dump(fresh));
    await project.close();
    await fresh.close();
  });

  test("does nothing when no file changed, and survives reopening", async () => {
    const root = copyFixture();
    const dataDir = tempDir("data");
    const first = Project.open({ root, dataDir });
    await first.sync();
    const state = dump(first);
    await first.close();

    const second = Project.open({ root, dataDir });
    const result = await second.sync();
    assert.deepEqual([result.added, result.changed, result.removed, result.resolvedFiles], [0, 0, 0, 0]);
    assert.deepEqual(dump(second), state);
    await second.close();
  });

  test("honours .gitignore and .vertskimignore", async () => {
    const root = copyFixture();
    write(root, ".gitignore", "assets/\n", 1);
    write(root, ".vertskimignore", "tools/tests/\n", 1);
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
    assert.equal(project.node("assets/logo.svg"), null);
    assert.equal(project.node("tools/tests/test_report.py"), null);
    assert.ok(project.node("tools/report.py"));
    await project.close();
  });

  test("skips vendored and generated code by default, unless asked to include it", async () => {
    const root = copyFixture();
    write(root, "vendor/github.com/acme/lib/lib.go", "package lib\n\nfunc Helper() {}\n", 1);
    write(root, "src/legacy.min.js", "function a(b){return b}\n", 1);
    write(root, "src/index.js.map", '{"version":3}\n', 1);
    write(root, ".svelte-kit/output/app.js", "export function app() {}\n", 1);
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      for (const path of [
        "vendor/github.com/acme/lib/lib.go",
        "src/legacy.min.js",
        "src/index.js.map",
        ".svelte-kit/output/app.js",
      ]) {
        assert.equal(project.node(path), null, path);
      }
      write(root, ".vertskimignore", "!vendor/\n", 2);
      await project.sync();
      assert.ok(project.node("vendor/github.com/acme/lib/lib.go#Helper"));
    } finally {
      await project.close();
    }
  });
});

describe("text quoted from the project", () => {
  test("loses its control characters before it is stored or shown", async () => {
    const root = copyFixture();
    write(root, "src/colour.ts", "/** Prints \u001b[31mred\u001b[0m text. */\nexport function colour(): void {}\n", 1);
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      const doc = project.node("src/colour.ts#colour")?.doc ?? "";
      assert.equal(doc, "Prints \u241b[31mred\u241b[0m text.");
      const note = project.addNote("src/colour.ts#colour", "a \u0007 bell and a \u009b CSI", "test");
      assert.equal(note.text, "a \u2407 bell and a \ufffd CSI");
    } finally {
      await project.close();
    }
  });
});
