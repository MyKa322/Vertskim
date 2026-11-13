import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseJsonc } from "./extract/languages/javascript.js";
import { Project } from "./project.js";
import { copyFixture, edge, removeTempDirs, tempDir, write } from "./testing/helpers.js";

after(removeTempDirs);

const MAIN = "src/main.ts#main";

describe("import aliases", () => {
  test("follow tsconfig paths and baseUrl, package imports and the exports of workspace packages", async () => {
    const root = copyFixture("aliases");
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      const calls = (dst: string) => edge(project, MAIN, "calls", dst)?.confidence;
      // \`@lib/*\` from tsconfig.json, on a baseUrl that tsconfig.base.json sets
      assert.equal(calls("lib/helpers.ts#helper"), "resolved");
      // an exact alias
      assert.equal(calls("src/app/index.ts#startApp"), "resolved");
      // \`#internal/*\` from package.json, pointing at the .js name of a .ts file
      assert.equal(calls("src/internal/thing.ts#thing"), "resolved");
      // a workspace package whose exports point at built files: traced back to its sources
      assert.equal(calls("packages/shared/src/index.ts#shared"), "resolved");
      assert.equal(calls("packages/shared/src/format.ts#format"), "resolved");
      // a bare path resolved against baseUrl
      assert.equal(calls("components/button.ts#button"), "resolved");
      // a real dependency stays one
      assert.ok(edge(project, "src/main.ts", "imports", "ext:npm/zod"));
      assert.equal(project.node("ext:npm/@lib"), null);
      assert.equal(project.node("ext:npm/#internal"), null);

      // Changing an alias re-links the files that use it.
      const config = readFileSync(join(root, "tsconfig.json"), "utf8").replace(
        '"@lib/*": ["lib/*"]',
        '"@lib/*": ["third/lib/*"]',
      );
      write(root, "tsconfig.json", config, 1);
      await project.sync();
      assert.equal(calls("lib/helpers.ts#helper"), undefined);
      write(root, "third/lib/helpers.ts", "export function helper(): number {\n  return 2;\n}\n", 2);
      await project.sync();
      assert.equal(calls("third/lib/helpers.ts#helper"), "resolved");
    } finally {
      await project.close();
    }
  });

  test("tsconfig files are read with comments and trailing commas", () => {
    assert.deepEqual(parseJsonc('{\n  // a comment\n  "a": [1, 2,],\n  /* another */ "b": "x // not a comment",\n}'), {
      a: [1, 2],
      b: "x // not a comment",
    });
  });
});
