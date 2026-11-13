import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Project } from "@vertskim/core";
import { formatBenchmark, runBenchmark } from "./bench.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/sample", import.meta.url));

describe("the token benchmark", () => {
  let root: string;
  let dataDir: string;
  let project: Project;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "vertskim-bench-project-"));
    dataDir = mkdtempSync(join(tmpdir(), "vertskim-bench-data-"));
    cpSync(FIXTURE, root, { recursive: true });
    project = Project.open({ root, dataDir });
    await project.sync();
  });
  after(async () => {
    await project.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("measures every question on both sides", async () => {
    const result = await runBenchmark(project, { samples: 8 });
    assert.equal(result.files, 18);
    assert.equal(result.capped, false);
    assert.deepEqual(
      result.rows.map((r) => r.question),
      [
        "Get oriented in the project",
        "See what a file contains",
        "Read one function or class",
        "Find who uses a symbol",
        "Gather the code around a symbol",
        "Check what a change would affect",
      ],
    );
    for (const row of result.rows) {
      assert.ok(row.samples >= 1 && row.samples <= 8, row.question);
      assert.ok(row.totalWithout > 0 && row.totalWith > 0, row.question);
      assert.ok(row.medianWithout > 0 && row.medianWith > 0, row.question);
      assert.ok(row.larger >= 0 && row.larger <= row.samples, row.question);
    }
    // Reading one function is always cheaper than reading the file around it.
    const read = result.rows[2]!;
    assert.ok(read.totalWith < read.totalWithout);
  });

  test("gives the same numbers on every run and leaves the project alone", async () => {
    const first = await runBenchmark(project, { samples: 6 });
    const second = await runBenchmark(project, { samples: 6 });
    assert.deepEqual(first, second);
    assert.equal(project.noteCounts().notes, 0);
  });

  test("prints a table that says what was compared", async () => {
    const text = formatBenchmark(await runBenchmark(project, { samples: 4 }));
    assert.match(text, /^Token use on vertskim-bench-project-\w+: 18 files, \d+ symbols/);
    assert.match(text, /question\s+samples\s+without graph\s+with graph\s+difference\s+overall/);
    assert.match(text, /Read one function or class\s+4\s+[\d,]+\s+[\d,]+\s+\d+% (less|more)/);
    assert.match(text, /- Find who uses a symbol: search the project for its name/);
    assert.match(text, /This measures size only/);
  });
});
