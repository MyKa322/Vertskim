import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Project } from "../project.js";
import { copyFixture, removeTempDirs, tempDir, write } from "../testing/helpers.js";
import type { GraphView } from "./view.js";

after(removeTempDirs);

function ids(view: GraphView): string[] {
  return view.nodes.map((n) => n.id).sort();
}

function link(view: GraphView, source: string, kind: string, target: string) {
  return view.links.find((l) => l.source === source && l.kind === kind && l.target === target);
}

describe("graph views", () => {
  let root: string;
  let project: Project;

  before(async () => {
    root = copyFixture();
    project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
  });
  after(() => project.close());

  test("everything collapsed shows the top level, with relationships rolled up", () => {
    const view = project.view({ expanded: [] });
    assert.deepEqual(ids(view), ["README.md", "assets/", "docs/", "ext:", "package.json", "src/", "tests/", "tools/"]);
    assert.deepEqual(view.expanded, []);
    assert.ok(view.nodes.every((n) => n.parent === null && !n.expanded));

    const src = view.nodes.find((n) => n.id === "src/")!;
    assert.equal(src.container, true);
    assert.equal(src.files, 8);
    assert.equal(src.symbols, 25);
    assert.ok(src.fanIn > 0);

    // tests/session.test.ts imports two files under src/ and calls three things there
    assert.equal(link(view, "tests/", "imports", "src/")?.weight, 2);
    assert.equal(link(view, "tests/", "tests", "src/")?.weight, 2);
    assert.ok(link(view, "tests/", "calls", "src/"));
    assert.ok(link(view, "README.md", "mentions", "tools/"));
    assert.ok(link(view, "src/", "imports", "ext:"));
    // nothing inside src/ shows as a link from src/ to itself
    assert.ok(view.links.every((l) => l.source !== l.target));
    assert.equal(view.truncated, false);
  });

  test("an opened group becomes a hub with its contents around it", () => {
    const view = project.view({ expanded: ["src/", "src/auth/", "src/auth/session.ts"] });
    const node = (id: string) => view.nodes.find((n) => n.id === id);
    assert.equal(node("src/")?.expanded, true);
    assert.equal(node("src/auth/")?.parent, "src/");
    assert.equal(node("src/auth/session.ts")?.expanded, true);
    assert.equal(node("src/auth/session.ts#SessionStore")?.parent, "src/auth/session.ts");
    assert.equal(node("src/auth/session.ts#SessionStore")?.container, true);
    assert.equal(node("src/api/")?.expanded, false);
    assert.ok(link(view, "src/auth/session.ts", "contains", "src/auth/session.ts#SessionStore"));

    // A caller inside the closed src/api/ is drawn as src/api/; the callee's class stands for its method.
    const call = link(view, "src/api/", "calls", "src/auth/session.ts#SessionStore");
    assert.ok(call);
    // The file's own symbols using each other do not show as links to the file hub.
    assert.ok(view.links.every((l) => l.kind === "contains" || !(l.source === "src/auth/session.ts" && l.target.startsWith("src/auth/session.ts#"))));
    // Every link joins two drawn nodes.
    const drawn = new Set(ids(view));
    assert.ok(view.links.every((l) => drawn.has(l.source) && drawn.has(l.target)));
    // Sending the reported state back gives the same picture.
    assert.deepEqual(ids(project.view({ expanded: view.expanded })), ids(view));
  });

  test("a guess stays marked as one until a certain relationship joins it", () => {
    const view = project.view({ expanded: ["src/", "src/api/", "src/api/middleware.ts", "src/auth/", "src/auth/session.ts", "src/auth/session.ts#SessionStore"] });
    const guess = link(view, "src/api/middleware.ts#requireAuth", "calls", "src/auth/session.ts#SessionStore.refresh");
    assert.equal(guess?.heuristic, true);
    const certain = link(view, "src/auth/session.ts#SessionStore.refresh", "calls", "src/auth/tokens.ts");
    assert.equal(certain?.heuristic, false);
  });

  test("with nothing asked for, it opens enough to be readable", () => {
    const view = project.view();
    assert.ok(view.nodes.length > 20 && view.nodes.length <= 220);
    assert.ok(view.expanded.includes("src/"));
    // a project this small is shown down to its symbols
    assert.ok(view.nodes.some((n) => n.kind === "function"));
    assert.equal(view.nodes.find((n) => n.id === "ext:")?.expanded, false);
  });

  test("areas follow the top-level directories", () => {
    const view = project.view();
    const group = (id: string) => view.nodes.find((n) => n.id === id)?.group;
    assert.equal(group("src/auth/session.ts"), "src/");
    assert.equal(group("tools/tests/"), "tools/");
    assert.equal(group("README.md"), "./");
    assert.equal(group("ext:"), "ext:");
  });

  test("respects the size limit and says so", () => {
    const view = project.view({ maxNodes: 10 });
    assert.ok(view.nodes.length <= 10);
    assert.equal(view.truncated, true);
  });

  test("can be rooted at a directory", () => {
    const view = project.view({ root: "tools/", expanded: [] });
    assert.equal(view.root, "tools/");
    assert.deepEqual(ids(view), ["tools/__init__.py", "tools/formatting.py", "tools/models.py", "tools/report.py", "tools/tests/"]);
    assert.ok(link(view, "tools/tests/", "imports", "tools/report.py"));
  });

  test("reveal lists what to open to reach a node", () => {
    assert.deepEqual(project.reveal("src/auth/session.ts#SessionStore.refresh"), [
      "src/",
      "src/auth/",
      "src/auth/session.ts",
      "src/auth/session.ts#SessionStore",
    ]);
    assert.deepEqual(project.reveal("README.md"), []);
    assert.deepEqual(project.reveal("ext:node/crypto"), ["ext:"]);
  });

  test("the version moves when the graph changes, and views follow", async () => {
    const before_ = project.graphVersion();
    await project.sync();
    assert.equal(project.graphVersion(), before_); // nothing changed, nothing moves
    write(root, "src/utils/clock.ts", "export function now(): number {\n  return Date.now();\n}\n", 1);
    await project.sync();
    assert.notEqual(project.graphVersion(), before_);
    const view = project.view({ expanded: ["src/", "src/utils/"] });
    assert.equal(view.version, project.graphVersion());
    assert.ok(view.nodes.some((n) => n.id === "src/utils/clock.ts"));
  });
});

describe("areas in a project dominated by one directory", () => {
  test("split that directory, so its parts get their own colour", async () => {
    const root = tempDir("mono");
    for (const pkg of ["api", "web", "shared"]) {
      for (const name of ["a", "b", "c"]) write(root, `packages/${pkg}/src/${name}.ts`, `export const ${name} = 1;\n`, 0);
    }
    write(root, "README.md", "# Mono\n", 0);
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
    const view = project.view({ expanded: ["packages/", "packages/api/", "packages/api/src/"] });
    const group = (id: string) => view.nodes.find((n) => n.id === id)?.group;
    assert.equal(group("packages/api/src/a.ts"), "packages/api/");
    assert.equal(group("packages/web/"), "packages/web/");
    assert.equal(group("README.md"), "./");
    await project.close();
  });
});
