import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Project } from "./project.js";
import { edge, removeTempDirs, tempDir, write } from "./testing/helpers.js";

after(removeTempDirs);

test("an edge that is both guessed and resolved counts as resolved, whichever is found first", async () => {
  const root = tempDir("root");
  write(root, "src/store.ts", "export class Store {\n  flushAll(): void {}\n}\n", 0);
  // The untyped call comes first: its guess must not decide what the typed call proves.
  write(
    root,
    "src/use.ts",
    'import { Store } from "./store";\n\nexport function f(s: Store, x: any): void {\n  x.flushAll();\n  s.flushAll();\n}\n',
    0,
  );
  const project = Project.open({ root, dataDir: tempDir("data") });
  try {
    await project.sync();
    const link = edge(project, "src/use.ts#f", "calls", "src/store.ts#Store.flushAll");
    assert.equal(link?.confidence, "resolved");
    assert.equal(link?.weight, 2);
  } finally {
    await project.close();
  }
});
