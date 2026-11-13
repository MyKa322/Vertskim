import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Project } from "../project.js";
import { copyFixture, removeTempDirs, tempDir } from "../testing/helpers.js";

after(removeTempDirs);

describe("analysing the sample project", () => {
  let project: Project;
  const node = (id: string) => {
    const found = project.node(id);
    assert.ok(found, `missing node ${id}`);
    return found;
  };

  before(async () => {
    project = Project.open({ root: copyFixture(), dataDir: tempDir("data") });
    await project.sync();
  });
  after(() => project.close());

  describe("impact", () => {
    test("follows dependents outward, nearest first", () => {
      const result = project.impact([node("src/auth/tokens.ts#rotate")]);
      const at = (id: string) => result.impacted.find((i) => i.node.id === id);
      assert.equal(at("src/auth/session.ts#SessionStore.refresh")?.distance, 1);
      const middleware = at("src/api/middleware.ts#requireAuth");
      assert.equal(middleware?.distance, 2);
      assert.equal(middleware?.confidence, "resolved");
      assert.equal(middleware?.via, "src/auth/session.ts#SessionStore.refresh");
      assert.equal(at("src/api/routes.ts#routes")?.distance, 3);
      assert.deepEqual(
        result.impacted.map((i) => i.distance),
        [...result.impacted.map((i) => i.distance)].sort((a, b) => a - b),
      );
      // nothing that merely imports the file without using the function
      assert.equal(at("src/auth/index.ts"), undefined);
    });

    test("respects depth and can leave tests out", () => {
      const shallow = project.impact([node("src/auth/tokens.ts#rotate")], { depth: 1 });
      assert.deepEqual(
        shallow.impacted.map((i) => i.node.id),
        ["src/auth/session.ts#SessionStore.refresh"],
      );
      const withTests = project.impact([node("src/auth/tokens.ts#rotate")]);
      assert.ok(withTests.impacted.some((i) => i.isTest));
      assert.deepEqual(
        withTests.tests.map((t) => t.path),
        ["tests/session.test.ts"],
      );
      const without = project.impact([node("src/auth/tokens.ts#rotate")], { includeTests: false });
      assert.ok(without.impacted.every((i) => !i.isTest));
      assert.deepEqual(without.tests, []);
    });

    test("a file stands for everything inside it", () => {
      const result = project.impact([node("src/utils/log.ts")], { depth: 1 });
      const ids = result.impacted.map((i) => i.node.id);
      assert.ok(ids.includes("src/auth/session.ts")); // imports the file
      assert.ok(ids.includes("src/db/redis.ts#RedisClient.put")); // calls warn()
      assert.equal(result.impacted.find((i) => i.node.id === "src/index.ts#main")?.via, "src/utils/log.ts#info");
      assert.ok(ids.every((id) => !id.startsWith("src/utils/log.ts")));
    });

    test("lists tests that import the file and docs that mention the target", () => {
      const result = project.impact([node("tools/formatting.py#INDENT")]);
      // reached through build_report -> bullet -> INDENT
      assert.ok(result.tests.some((t) => t.path === "tools/tests/test_report.py"));
      const docs = project.impact([node("src/auth/tokens.ts#rotate")]).docs.map((d) => d.node.id);
      assert.deepEqual(docs.sort(), ["README.md#layout", "docs/architecture.md#session-lifecycle"]);
    });
  });

  describe("path", () => {
    test("finds the dependency chain between two symbols", () => {
      const result = project.path(node("src/index.ts#main"), node("src/auth/tokens.ts#rotate"));
      assert.equal(result?.mode, "depends");
      assert.equal(result?.start.id, "src/index.ts#main");
      assert.deepEqual(
        result?.steps.map((s) => s.node.id),
        [
          "src/api/routes.ts#routes",
          "src/api/middleware.ts#requireAuth",
          "src/auth/session.ts#SessionStore.refresh",
          "src/auth/tokens.ts#rotate",
        ],
      );
      assert.ok(result?.steps.every((s) => s.direction === "out"));
    });

    test("starts from a member when given a file, and stops inside the target file", () => {
      const result = project.path(node("src/index.ts"), node("src/utils/log.ts"));
      assert.equal(result?.mode, "depends");
      assert.equal(result?.steps.length, 1);
      assert.ok(result?.steps[0]?.node.id.startsWith("src/utils/log.ts"));
    });

    test("says when only the opposite direction exists", () => {
      const result = project.path(node("src/auth/tokens.ts#rotate"), node("src/index.ts#main"));
      assert.equal(result?.mode, "reverse");
      assert.equal(result?.start.id, "src/index.ts#main");
      assert.equal(result?.steps.at(-1)?.node.id, "src/auth/tokens.ts#rotate");
    });

    test("falls back to any connection, then to none", () => {
      const related = project.path(node("tools/report.py"), node("src/auth/session.ts"));
      assert.equal(related?.mode, "related");
      assert.ok(related?.steps.some((s) => s.direction === "in"));
      assert.equal(project.path(node("package.json"), node("src/auth/tokens.ts#rotate")), null);
      assert.equal(
        project.path(node("src/index.ts#main"), node("src/auth/tokens.ts#rotate"), { maxHops: 2 })?.mode,
        undefined,
      );
    });
  });

  describe("overview", () => {
    test("summarises the whole project", () => {
      const map = project.overview();
      assert.equal(map.files, 18);
      assert.equal(map.testFiles, 2);
      assert.equal(map.languages[0]?.language, "typescript");
      assert.deepEqual(map.looseFiles, ["README.md", "package.json"]);
      const src = map.tree.find((d) => d.id === "src/");
      assert.equal(src?.files, 8);
      assert.deepEqual(src?.children.map((c) => c.id).sort(), ["src/api/", "src/auth/", "src/db/", "src/utils/"]);
      assert.equal(map.hubFiles[0]?.node.id, "src/auth/session.ts");
      assert.equal(map.hubSymbols[0]?.node.id, "src/auth/session.ts#Session");
      assert.ok(map.entryPoints.some((e) => e.node.id === "src/index.ts"));
      assert.ok(map.externals.some((e) => e.node.id === "ext:node/crypto"));
      assert.equal(map.docs[0]?.id, "README.md");
    });

    test("can be limited to a directory and a depth", () => {
      const map = project.overview(node("tools/"), 1);
      assert.equal(map.files, 5);
      assert.deepEqual(
        map.tree.map((d) => d.id),
        ["tools/tests/"],
      );
      assert.ok(map.hubSymbols.every((h) => h.node.path.startsWith("tools/")));
      assert.deepEqual(
        project.overview(undefined, 1).tree.flatMap((d) => d.children),
        [],
      );
    });
  });

  describe("context", () => {
    test("ranks the code a task is about above its surroundings", () => {
      const result = project.context({ task: "session refresh" });
      const ids = result.items.map((i) => i.node.id);
      assert.equal(ids[0], "src/auth/session.ts#SessionStore.refresh");
      assert.ok(result.items[0]?.seed);
      // callees pulled in through the graph, not through the words of the task
      const rotate = result.items.find((i) => i.node.id === "src/auth/tokens.ts#rotate");
      assert.ok(rotate && !rotate.seed);
      assert.ok(ids.includes("src/auth/session.ts#SessionStore.persist"));
      // the unrelated Python side stays out
      assert.ok(ids.every((id) => !id.startsWith("tools/")));
      assert.deepEqual(
        result.items.map((i) => i.score),
        [...result.items.map((i) => i.score)].sort((a, b) => b - a),
      );
    });

    test("picks up names written in the task", () => {
      const result = project.context({ task: "why does `build_report` indent bullets wrongly?" });
      assert.equal(result.seeds[0]?.id, "tools/report.py#build_report");
      assert.ok(result.items.some((i) => i.node.id === "tools/formatting.py#bullet"));
    });

    test("starts from explicit seeds and reports unknown ones", () => {
      const result = project.context({ seeds: ["src/db/redis.ts#RedisClient", "src/nope.ts#Nope"] });
      assert.deepEqual(result.missingSeeds, ["src/nope.ts#Nope"]);
      assert.deepEqual(
        result.seeds.map((s) => s.id),
        ["src/db/redis.ts#RedisClient"],
      );
      const ids = result.items.map((i) => i.node.id);
      assert.ok(ids.includes("src/db/redis.ts#RedisClient.put")); // member
      assert.ok(ids.includes("src/db/redis.ts#KeyValueStore")); // implemented interface
    });

    test("returns nothing when there is nothing to start from", () => {
      assert.deepEqual(project.context({ task: "zzzz qqqq" }).items, []);
    });
  });
});
