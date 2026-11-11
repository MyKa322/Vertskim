import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Project } from "../project.js";
import { copyFixture, dump, edge, removeTempDirs, tempDir, write } from "../testing/helpers.js";
import type { SyncResult } from "../types.js";
import { withFileLock } from "./lock.js";

after(removeTempDirs);

/** Index `root` from scratch and return the resulting graph. */
async function freshDump(root: string): Promise<ReturnType<typeof dump>> {
  const fresh = Project.open({ root, dataDir: tempDir("data") });
  await fresh.sync();
  const state = dump(fresh);
  await fresh.close();
  return state;
}

describe("targeted sync", () => {
  test("examining only the changed paths gives the same graph as a full index", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();

    // edit, add and delete single files
    const tokens = readFileSync(join(root, "src/auth/tokens.ts"), "utf8");
    write(root, "src/auth/tokens.ts", tokens.replace("function rotate(", "function rotateToken("), 1);
    write(root, "src/utils/clock.ts", "export function now(): number {\n  return Date.now();\n}\n", 1);
    rmSync(join(root, "assets/logo.svg"));
    let result = await project.sync({ paths: ["src/auth/tokens.ts", "src/utils/clock.ts", "assets/logo.svg"] });
    assert.deepEqual([result.added, result.changed, result.removed], [1, 1, 1]);
    assert.ok(project.node("src/utils/clock.ts#now"));
    assert.equal(project.node("assets/logo.svg"), null);
    assert.equal(project.node("assets/"), null); // the emptied directory goes too
    assert.equal(edge(project, "src/auth/session.ts#SessionStore.refresh", "calls", "src/auth/tokens.ts#rotate"), null);
    assert.deepEqual(dump(project), await freshDump(root));

    // a directory appears with files in it, another is renamed, a third is deleted
    write(root, "src/jobs/cleanup.ts", 'import { now } from "../utils/clock.js";\nexport const startedAt = now();\n', 2);
    renameSync(join(root, "docs"), join(root, "guide"));
    rmSync(join(root, "tools"), { recursive: true });
    result = await project.sync({ paths: ["src/jobs", "docs", "guide", "tools"] });
    assert.equal(result.added, 2); // cleanup.ts and guide/architecture.md
    assert.equal(result.removed, 6); // docs/architecture.md and the five files under tools/
    assert.ok(edge(project, "src/jobs/cleanup.ts#startedAt", "calls", "src/utils/clock.ts#now"));
    assert.ok(project.node("guide/architecture.md#session-lifecycle"));
    assert.equal(project.node("tools/"), null);
    assert.deepEqual(dump(project), await freshDump(root));
    await project.close();
  });

  test("applies the ignore rules to reported paths", async () => {
    const root = copyFixture();
    write(root, ".gitignore", "generated/\n", 0);
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();

    write(root, "node_modules/pkg/index.js", "export const x = 1;\n", 1);
    write(root, "generated/out.ts", "export const y = 2;\n", 1);
    write(root, "src/generated/out.ts", "export const z = 3;\n", 1);
    const result = await project.sync({
      paths: ["node_modules/pkg/index.js", "generated/out.ts", "src/generated/out.ts", "node_modules"],
    });
    assert.equal(result.added, 0);
    assert.equal(project.node("node_modules/pkg/index.js"), null);
    assert.equal(project.node("generated/out.ts"), null);
    assert.equal(project.node("src/generated/out.ts"), null);

    // changing the rules themselves triggers a full re-scan
    write(root, ".gitignore", "assets/\n", 2);
    await project.sync({ paths: [".gitignore"] });
    assert.ok(project.node("generated/out.ts"));
    assert.equal(project.node("assets/logo.svg"), null);
    assert.deepEqual(dump(project), await freshDump(root));
    await project.close();
  });

  test("never looks outside the project", async () => {
    const root = copyFixture();
    const outside = tempDir("outside");
    writeFileSync(join(outside, "secret.ts"), "export const secret = 1;\n");
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
    const before = dump(project);
    const result = await project.sync({ paths: [join(outside, "secret.ts"), "../secret.ts", "src/../../secret.ts"] });
    assert.deepEqual([result.added, result.changed, result.removed], [0, 0, 0]);
    assert.deepEqual(dump(project), before);
    await project.close();
  });

  test("rebuild discards the index and produces the same graph", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
    const before = dump(project);
    const result = await project.rebuild();
    assert.equal(result.added, 18);
    assert.deepEqual(dump(project), before);
    await project.close();
  });
});

describe("watching", () => {
  test("picks up changes without being asked", async (t) => {
    const root = copyFixture();
    const synced: SyncResult[] = [];
    const project = Project.open({ root, dataDir: tempDir("data"), onSync: (result) => synced.push(result) });
    if (!(await project.watch())) {
      await project.close();
      t.skip("no file watcher on this platform");
      return;
    }
    assert.equal(project.status().watching, true);
    await project.sync({ full: true });
    assert.equal(synced.length, 1);

    // Only the watcher can make these true: nothing below asks for a sync.
    const eventually = async (what: string, check: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`${what}: not within 10 s of the file change`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };

    writeFileSync(join(root, "src/utils/clock.ts"), "export function now(): number {\n  return Date.now();\n}\n");
    await eventually("new file indexed", () => project.node("src/utils/clock.ts#now") !== null);
    assert.ok(synced.length >= 2);

    rmSync(join(root, "src/utils/clock.ts"));
    await eventually("deleted file dropped", () => project.node("src/utils/clock.ts") === null);
    await project.sync();
    assert.deepEqual(dump(project), await freshDump(root));
    await project.close();
  });

  test("a query about a file sees an edit made a moment earlier", async (t) => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    if (!(await project.watch())) {
      await project.close();
      t.skip("no file watcher on this platform");
      return;
    }
    await project.sync({ full: true });

    // No waiting for the watcher: the file is checked on disk because the query names it.
    const tokens = readFileSync(join(root, "src/auth/tokens.ts"), "utf8");
    write(root, "src/auth/tokens.ts", `${tokens}\nexport function revoke(token: string): void {}\n`, 1);
    await project.refresh(["src/auth/tokens.ts#revoke"]);
    assert.ok(project.node("src/auth/tokens.ts#revoke"));

    rmSync(join(root, "src/utils/log.ts"));
    await project.refresh(["src/utils/log.ts#warn"]);
    assert.equal(project.node("src/utils/log.ts"), null);
    await project.close();
  });
});

describe("several processes on one project", () => {
  test("concurrent syncs through separate connections end in the same graph", async () => {
    const root = copyFixture();
    const dataDir = tempDir("data");
    const first = Project.open({ root, dataDir });
    const second = Project.open({ root, dataDir });
    await Promise.all([first.sync(), second.sync()]);
    assert.deepEqual(dump(first), await freshDump(root));

    const tokens = readFileSync(join(root, "src/auth/tokens.ts"), "utf8");
    write(root, "src/auth/tokens.ts", tokens.replace("function rotate(", "function rotateToken("), 1);
    write(root, "src/utils/clock.ts", "export function now(): number {\n  return Date.now();\n}\n", 1);
    await Promise.all([first.sync(), second.sync(), first.sync({ paths: ["src/utils/clock.ts"] })]);
    assert.deepEqual(dump(second), await freshDump(root));
    assert.equal(existsSync(join(dataDir, "sync.lock")), false);
    await first.close();
    await second.close();
  });

  test("the lock admits one holder at a time and recovers from a dead one", async () => {
    const lockPath = join(tempDir("lock"), "sync.lock");
    let inside = 0;
    let overlapped = false;
    const work = () =>
      withFileLock(lockPath, async () => {
        inside++;
        if (inside > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 30));
        inside--;
      });
    await Promise.all([work(), work(), work()]);
    assert.equal(overlapped, false);
    assert.equal(existsSync(lockPath), false);

    // A lock left behind by a process that no longer exists is taken over.
    writeFileSync(lockPath, "2147483646");
    let waited = false;
    const value = await withFileLock(
      lockPath,
      async () => "done",
      () => {
        waited = true;
      },
    );
    assert.equal(value, "done");
    assert.equal(waited, false);
    assert.equal(existsSync(lockPath), false);
  });
});
