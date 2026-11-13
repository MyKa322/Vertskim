import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractFile } from "../index.js";

describe("Luau and Lua syntax", () => {
  test("reads newer Luau types and attributes without moving definitions or losing calls", async () => {
    const source = `--!strict
--- Measures an input.
@native
local function measure<T, Rest...>(value: T, ...: Rest...): number
  for index: number, item: number in { 1, 2 } do
    if item < 0 then continue end
  end
  return #\`value {value}\`
end

export type Box<T = number> = { read value: T, write next: T? }
export type Choice =
  | Box<number>
  | string
type Mapper<T...> = (T...) -> T...
type Convert = <T>(T) -> T
const answer = 7

local function run(): number
  return measure<<number>>(answer)
end

return { measure = measure, run = run }
`;
    const result = await extractFile("syntax.luau", "luau", source);
    assert.equal(result.syntaxError, null);
    const measure = result.nodes.find((node) => node.name === "measure");
    assert.equal(measure?.startLine, 4); // @native was blanked without moving the function
    assert.equal(measure?.signature, "local function measure<T, Rest...>(value: T, ...: Rest...): number");
    assert.ok(result.nodes.some((node) => node.name === "Box" && node.kind === "type"));
    assert.ok(result.nodes.some((node) => node.name === "Choice" && node.kind === "type"));
    assert.equal(result.nodes.find((node) => node.name === "answer")?.signature, "const answer = 7");
    assert.ok(
      result.refs.some((ref) => ref.src === "syntax.luau#run" && ref.kind === "calls" && ref.name === "measure"),
    );
  });

  test("finds a type function and retains its original signature", async () => {
    const result = await extractFile("types.luau", "luau", "export type function identity(ty)\n  return ty\nend\n");
    assert.equal(result.syntaxError, null);
    assert.equal(result.nodes.find((node) => node.name === "identity")?.signature, "export type function identity(ty)");
  });

  test("keeps syntax-like text inside strings and comments out of the graph", async () => {
    const source = `-- @native type function pretend() end
local literal = [=[type Fake<T = number> = { read value: T }]=]
local text = "goto pretend <<number>>"
local function read(): string
  -- for index: number in things do
  return literal .. text
end
return read
`;
    const result = await extractFile("literal.luau", "luau", source);
    assert.equal(result.syntaxError, null);
    assert.deepEqual(result.nodes.map((node) => node.name).sort(), ["literal", "read", "text"]);
    assert.equal(result.nodes.find((node) => node.name === "read")?.signature, "local function read(): string");
    assert.ok(!result.refs.some((ref) => ref.name === "pretend" || ref.name === "Fake"));
  });

  test("reads Lua labels and bitwise expressions without losing the calls beside them", async () => {
    const source = `local M = {}
function M.read(value)
  if value == 0 then goto done end
  value = (value << 1) | 1
  value = value & ~2
  ::done::
  return M.finish(value)
end
function M.finish(value)
  return value
end
return M
`;
    const result = await extractFile("bits.lua", "lua", source);
    assert.equal(result.syntaxError, null);
    assert.equal(result.nodes.find((node) => node.name === "M")?.kind, "class");
    assert.ok(
      result.refs.some((ref) => ref.src === "bits.lua#M.read" && ref.kind === "calls" && ref.name === "finish"),
    );
    assert.ok(!result.refs.some((ref) => ref.name === "done"));
  });

  test("still reports malformed Luau after trying its syntax fallbacks", async () => {
    const result = await extractFile("broken.luau", "luau", "@native\nlocal function broken(\n");
    assert.ok(result.syntaxError);
  });
});
