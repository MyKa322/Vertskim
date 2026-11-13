import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Project } from "./project.js";
import { edge, removeTempDirs, tempDir, write } from "./testing/helpers.js";

after(removeTempDirs);

const TS = `export function outer(items: number[]): number {
  function helper(x: number): number {
    return x * 2;
  }
  const double = (x: number) => helper(x);
  return items.map(double).length;
}

export const api = {
  get(id: string) {
    return lookup(id);
  },
  list: () => [],
};

export const tool = define({
  run(input: string) {
    return lookup(input);
  },
});

export function Component() {
  const onClick = () => save();
  const onKey = (key: string) => {
    if (key === "Enter") save();
    return key;
  };
  return [onClick, onKey];
}

export class Widget {
  render(): string {
    const label = (text: string) => {
      return text.toUpperCase();
    };
    return label("x");
  }
}

function define<T>(value: T): T {
  return value;
}
function save(): void {}
function lookup(id: string): string {
  return id;
}
`;

const PY = `def decorator(fn):
    def wrapper(*args):
        print("calling")
        return fn(*args)

    return wrapper


def short(fn):
    def inner():
        return fn()

    return inner
`;

describe("definitions inside other definitions", () => {
  test("named functions inside functions and methods of object literals become nodes", async () => {
    const root = tempDir("project");
    write(root, "src/nested.ts", TS, 0);
    write(root, "tools/deco.py", PY, 0);
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      const kind = (id: string) => project.node(id)?.kind;
      assert.equal(kind("src/nested.ts#outer.helper"), "function");
      assert.equal(kind("src/nested.ts#api.get"), "method");
      assert.equal(kind("src/nested.ts#tool.run"), "method");
      assert.equal(kind("src/nested.ts#Component.onKey"), "function");
      assert.equal(kind("src/nested.ts#Widget.render.label"), "function");
      assert.equal(kind("tools/deco.py#decorator.wrapper"), "function");
      // One-liners are left to their owner.
      for (const id of [
        "src/nested.ts#outer.double",
        "src/nested.ts#api.list",
        "src/nested.ts#Component.onClick",
        "tools/deco.py#short.inner",
      ]) {
        assert.equal(project.node(id), null, id);
      }
      // What is defined inside a function is not exported, whatever its owner is.
      assert.equal(project.node("src/nested.ts#outer.helper")?.exported, 0);
      assert.equal(project.node("src/nested.ts#outer.helper")?.parent, "src/nested.ts#outer");

      // Calls reach nested functions by their bare name, and are made from them.
      assert.equal(edge(project, "src/nested.ts#outer", "calls", "src/nested.ts#outer.helper")?.confidence, "resolved");
      assert.equal(edge(project, "src/nested.ts#api.get", "calls", "src/nested.ts#lookup")?.confidence, "resolved");
      assert.equal(edge(project, "src/nested.ts#tool.run", "calls", "src/nested.ts#lookup")?.confidence, "resolved");
      assert.equal(
        edge(project, "src/nested.ts#Component.onKey", "calls", "src/nested.ts#save")?.confidence,
        "resolved",
      );
      assert.equal(edge(project, "src/nested.ts#Component", "calls", "src/nested.ts#save")?.confidence, "resolved");
      assert.equal(
        edge(project, "src/nested.ts#Widget.render", "calls", "src/nested.ts#Widget.render.label")?.confidence,
        "resolved",
      );
    } finally {
      await project.close();
    }
  });
});
