import assert from "node:assert/strict";
import { test } from "node:test";
import { silenceSqliteWarning } from "./warnings.js";

test("the experimental-feature warning for node:sqlite is dropped, and no other", async () => {
  const original = process.emitWarning;
  const seen: string[] = [];
  const listener = (warning: Error) => seen.push(warning.message);
  process.on("warning", listener);
  try {
    silenceSqliteWarning();
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning("something else worth knowing", "Warning");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["something else worth knowing"]);
  } finally {
    process.emitWarning = original;
    process.off("warning", listener);
  }
});
