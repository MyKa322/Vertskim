import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl, ImportName } from "../../types.js";
import { posixBasename, posixDirname, posixJoin, tidySignature, toPosix, truncate } from "../../util.js";
import type {
  DefDecision,
  DocInfo,
  LanguageSpec,
  RawDef,
  ResolveContext,
  ResolvedImport,
  SymbolInfo,
} from "../spec.js";
import { cleanComment, commentAbove, fieldIs } from "./common.js";

/**
 * Luau, and Lua read as Luau.
 *
 * The language has no classes and no export statement, only conventions, and those are
 * what is indexed. A table the file gives functions (`function Cart.new()`,
 * `function Cart:add()`) is a class and they are its methods. What a file returns is
 * what it exports: `return Cart` makes Cart the module's value, the way a default export
 * is one in JavaScript, and `return { rate = rate }` exports the functions it lists.
 * `require` is the import, by path or, in Roblox, by where the module sits in the game.
 */
const QUERY = `
(chunk (function_declaration name: (identifier) @name) @def.function)
(chunk (function_declaration name: (dot_index_expression field: (identifier) @name)) @def.method)
(chunk (function_declaration name: (method_index_expression method: (identifier) @name)) @def.method)
(chunk (variable_declaration (assignment_statement (variable_list . name: (identifier) @name))) @def.local)
(chunk (assignment_statement (variable_list . name: (identifier) @name .)) @def.global)
(chunk (assignment_statement
  (variable_list . name: (dot_index_expression field: (identifier) @name) .)
  (expression_list . value: (function_definition) .)) @def.assigned)
(field name: (identifier) @name value: (function_definition)) @def.field
(chunk (type_definition name: (identifier) @name) @def.type)
(chunk (type_definition name: (generic_type . (identifier) @name)) @def.type)

(function_call name: (identifier) @name) @ref.call
(function_call name: (dot_index_expression table: (_) @qualifier field: (identifier) @name)) @ref.call
(function_call name: (method_index_expression table: (_) @qualifier method: (identifier) @name)) @ref.call

(chunk (variable_declaration (assignment_statement
  (variable_list . name: (identifier) @subject .)
  (expression_list . value: (function_call
    name: (identifier) @_set
    arguments: (arguments (_) . (table_constructor (field name: (identifier) @_index value: (identifier) @name))))))
  @ref.extends (#eq? @_set "setmetatable") (#eq? @_index "__index")))
(chunk (variable_declaration (assignment_statement
  (variable_list . name: (identifier) @subject .)
  (expression_list . value: (function_call
    name: (identifier) @_set
    arguments: (arguments (_) . (table_constructor (field
      name: (identifier) @_index
      value: (dot_index_expression table: (_) @qualifier field: (identifier) @name)))))))
  @ref.extends (#eq? @_set "setmetatable") (#eq? @_index "__index")))
(chunk (function_call
  name: (identifier) @_set
  arguments: (arguments . (identifier) @subject . (table_constructor (field name: (identifier) @_index value: (identifier) @name))))
  @ref.extends (#eq? @_set "setmetatable") (#eq? @_index "__index"))
(chunk (function_call
  name: (identifier) @_set
  arguments: (arguments . (identifier) @subject . (table_constructor (field
    name: (identifier) @_index
    value: (dot_index_expression table: (_) @qualifier field: (identifier) @name)))))
  @ref.extends (#eq? @_set "setmetatable") (#eq? @_index "__index"))
(chunk (function_call
  name: (identifier) @_set
  arguments: (arguments . (identifier) @subject . (identifier) @name .))
  @ref.extends (#eq? @_set "setmetatable"))
(chunk (variable_declaration (assignment_statement
  (variable_list . name: (identifier) @subject .)
  (expression_list . value: (function_call
    name: (method_index_expression table: (identifier) @name method: (identifier) @_extend))))
  @ref.extends (#eq? @_extend "extend")))
(chunk (variable_declaration (assignment_statement
  (variable_list . name: (identifier) @subject .)
  (expression_list . value: (function_call
    name: (method_index_expression
      table: (dot_index_expression table: (_) @qualifier field: (identifier) @name)
      method: (identifier) @_extend))))
  @ref.extends (#eq? @_extend "extend")))

(field_type . (identifier) @qualifier . (identifier) @name .) @ref.type
(identifier) @ref.ident

(function_call name: (identifier) @_require (#eq? @_require "require")) @import
(function_call
  name: (method_index_expression table: (identifier) @_game method: (identifier) @_get)
  (#eq? @_game "game") (#eq? @_get "GetService")) @import

(chunk (return_statement (expression_list . (identifier) @name .))) @export.default
(chunk (return_statement (expression_list . (cast_expression . (identifier) @name)))) @export.default
(chunk (return_statement (expression_list . (function_call
  name: (_) @_wrap
  arguments: (arguments . (identifier) @name))))
  (#any-of? @_wrap "table.freeze" "setmetatable")) @export.default
(chunk (return_statement (expression_list . (table_constructor (field value: (identifier) @name))))) @export.named
(chunk (return_statement (expression_list . (function_call
  name: (_) @_wrap
  arguments: (arguments . (table_constructor (field value: (identifier) @name)))))
  (#any-of? @_wrap "table.freeze" "setmetatable"))) @export.named

(parameter . (identifier) @var . [(identifier) (field_type)] @vartype)
(parameter . (identifier) @var . (optional_type . [(identifier) (field_type)] @vartype))
(variable_list name: (identifier) @var . ":" . [(identifier) (field_type)] @vartype)
(variable_list name: (identifier) @var . ":" . (optional_type . [(identifier) (field_type)] @vartype))
(variable_declaration (assignment_statement
  (variable_list . name: (identifier) @var .)
  (expression_list . value: (cast_expression (_) . [(identifier) (field_type)] @vartype .) .)))
(variable_declaration (assignment_statement
  (variable_list . name: (identifier) @var .)
  (expression_list . value: (function_call
    name: (dot_index_expression table: [(identifier) (dot_index_expression)] @newtype field: (identifier) @_new)) .))
  (#eq? @_new "new"))
(variable_declaration (assignment_statement
  (variable_list . name: (identifier) @var .)
  (expression_list . value: (function_call
    name: (identifier) @_set
    arguments: (arguments . (_) . (identifier) @newtype .)) .))
  (#eq? @_set "setmetatable"))
(variable_declaration (assignment_statement
  (variable_list . name: (identifier) @var .)
  (expression_list . value: (function_call
    name: [(identifier) (dot_index_expression) (method_index_expression)] @varcall) .))
  (#not-any-of? @varcall "require" "setmetatable" "game:GetService"))
(assignment_statement
  (variable_list . name: (dot_index_expression table: (identifier) @_self field: (identifier) @fieldvar) .)
  (expression_list . value: (function_call
    name: (dot_index_expression table: [(identifier) (dot_index_expression)] @newtype field: (identifier) @_new)) .)
  (#eq? @_self "self") (#eq? @_new "new"))
(assignment_statement
  (variable_list . name: (dot_index_expression table: (identifier) @_self field: (identifier) @fieldvar) .)
  (expression_list . value: (function_call
    name: [(identifier) (dot_index_expression) (method_index_expression)] @varcall) .)
  (#eq? @_self "self") (#not-any-of? @varcall "require" "setmetatable" "game:GetService"))
(assignment_statement
  (variable_list . name: (dot_index_expression table: (identifier) @_self field: (identifier) @fieldvar) .)
  (expression_list . value: (identifier) @varvalue .)
  (#eq? @_self "self"))
`;

/** The language's own tables and Roblox's: a call on one is never the project's. */
// biome-ignore format: a list of words reads better packed
const GLOBALS = new Set([
  "string", "table", "math", "os", "io", "coroutine", "debug", "utf8", "bit32", "buffer", "vector", "package", "_G",
  "task", "game", "workspace", "script", "plugin", "shared", "Enum", "Instance", "Vector2", "Vector3", "CFrame",
  "Color3", "BrickColor", "UDim", "UDim2", "Rect", "Ray", "Region3", "Random", "DateTime", "TweenInfo", "NumberRange",
  "NumberSequence", "ColorSequence", "Font", "PhysicalProperties", "OverlapParams", "RaycastParams",
]);

/** Methods of strings, Roblox instances, signals and promises: matching one by name alone says nothing. */
// biome-ignore format: a list of words reads better packed
const COMMON_MEMBERS = new Set([
  "len", "sub", "gsub", "gmatch", "find", "rep", "byte", "char", "unpack", "pack", "concat", "Connect",
  "ConnectParallel", "Once", "Wait", "Disconnect", "Destroy", "Clone", "Fire", "FireServer", "FireClient",
  "FireAllClients", "Invoke", "InvokeServer", "InvokeClient", "FindFirstChild", "FindFirstChildOfClass",
  "FindFirstChildWhichIsA", "FindFirstAncestor", "FindFirstAncestorOfClass", "WaitForChild", "GetChildren",
  "GetDescendants", "GetService", "IsA", "IsDescendantOf", "IsAncestorOf", "GetAttribute", "SetAttribute",
  "GetAttributes", "GetPropertyChangedSignal", "GetAttributeChangedSignal", "GetFullName", "GetPlayers",
  "GetPlayerFromCharacter", "Play", "Stop", "Pause", "Cancel", "Create", "Kick", "LoadAnimation", "MoveTo",
  "PivotTo", "GetPivot", "Lerp", "Dot", "Cross", "ToWorldSpace", "ToObjectSpace", "Raycast", "GetAsync", "SetAsync",
  "UpdateAsync", "RemoveAsync", "GetDataStore", "JSONEncode", "JSONDecode", "NextInteger", "NextNumber", "andThen",
  "await", "expect", "extend",
]);

const SCRIPT_FILE = /\.luau?$/;
/** Folders a Roblox project keeps its installed packages in: what they hold is not the project's. */
const PACKAGE_FOLDERS = new Set(["Packages", "DevPackages", "ServerPackages"]);
/** Ways of asking an instance for a child by name, which a path can be followed through. */
const CHILD_LOOKUPS = new Set(["WaitForChild", "FindFirstChild"]);

/** `Cart` or `shop.Cart` for a name or a chain of `.name`; null for anything else. */
function dotted(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type !== "dot_index_expression") return null;
  const table = dotted(node.childForFieldName("table"));
  const field = node.childForFieldName("field");
  return table && field ? `${table}.${field.text}` : null;
}

/** An expression without the casts and parentheses around it: `({} :: Impl)` is `{}`. */
function bare(node: Node | null): Node | null {
  let n = node;
  while (n && (n.type === "cast_expression" || n.type === "parenthesized_expression")) n = n.namedChild(0);
  return n;
}

function named(node: Node, type: string): Node | null {
  return node.namedChildren.find((c) => c?.type === type) ?? null;
}

/** The `a, b = 1, 2` inside a `local` statement, or the statement itself when it is one. */
function assignmentOf(statement: Node): Node | null {
  return statement.type === "variable_declaration" ? named(statement, "assignment_statement") : statement;
}

/** The first value a declaration or assignment gives. */
function firstValue(statement: Node): Node | null {
  const values = assignmentOf(statement);
  return (values && named(values, "expression_list")?.namedChild(0)) ?? null;
}

/** The names a declaration introduces or an assignment sets, without the types written after them. */
function namesOf(list: Node): Node[] {
  return list.namedChildren.filter((c): c is Node => c !== null && c.previousSibling?.type !== ":");
}

function isRequire(call: Node): boolean {
  const callee = call.childForFieldName("name");
  return callee?.type === "identifier" && callee.text === "require";
}

/** `game:GetService("Players")`. */
function isService(call: Node): boolean {
  const callee = call.childForFieldName("name");
  return callee?.type === "method_index_expression" && callee.text.replace(/\s+/g, "") === "game:GetService";
}

/** The text of a call's only argument when it is a plain string: `require("./item")`, `require "./item"`. */
function stringArgument(call: Node): string | null {
  const args = call.childForFieldName("arguments");
  const literal = args?.type === "string" ? args : args?.namedChild(0);
  if (literal?.type !== "string" || named(literal, "interpolation")) return null;
  return named(literal, "string_content")?.text ?? null;
}

/**
 * The `require(…)` or `game:GetService(…)` call a value is taken from, with the member
 * picked off it in `require("./shop").Cart`. Null when the value is anything else.
 */
function importSource(value: Node | null): { call: Node; member: string | null } | null {
  let n = bare(value);
  let member: string | null = null;
  if (n?.type === "dot_index_expression") {
    member = n.childForFieldName("field")?.text ?? null;
    n = bare(n.childForFieldName("table"));
  }
  return n?.type === "function_call" && (isRequire(n) || isService(n)) ? { call: n, member } : null;
}

/** A table written out, or one given a metatable or frozen on the spot: `{}`, `setmetatable({}, Base)`. */
function tableOf(value: Node | null): Node | null {
  const n = bare(value);
  if (n?.type === "table_constructor") return n;
  if (n?.type !== "function_call") return null;
  const callee = n.childForFieldName("name")?.text;
  if (callee !== "setmetatable" && callee !== "table.freeze") return null;
  return tableOf(n.childForFieldName("arguments")?.namedChild(0) ?? null);
}

function hasFunctionFields(table: Node | null): boolean {
  return (
    table?.namedChildren.some(
      (f) => f?.type === "field" && bare(f.childForFieldName("value"))?.type === "function_definition",
    ) ?? false
  );
}

/** What is known of a file as a whole, worked out once per parse. */
interface FileInfo {
  /** Tables the file gives functions, or sets up as a class with `X.__index = X`. */
  owners: Set<string>;
  /** Names declared at the top of the file with `local`. */
  locals: Set<string>;
  /** Top-level tables that count as classes. */
  classes: Set<string>;
  /** What each top-level local is set to. */
  values: Map<string, Node>;
  /** Names the returned table lists, by the local each one stands for: `{ Basket = Cart }` gives Cart -> [Basket]. */
  returned: Map<string, string[]>;
  /** The name the file returns, in `return Cart`. */
  returnedName: string | null;
}

const infos = new WeakMap<object, FileInfo>();

function fileInfo(node: Node): FileInfo {
  const known = infos.get(node.tree);
  if (known) return known;
  const info: FileInfo = {
    owners: new Set(),
    locals: new Set(),
    classes: new Set(),
    values: new Map(),
    returned: new Map(),
    returnedName: null,
  };
  const tables: { name: string; table: Node | null }[] = [];
  for (const statement of node.tree.rootNode.namedChildren) {
    if (!statement) continue;
    switch (statement.type) {
      case "function_declaration": {
        const target = statement.childForFieldName("name");
        if (target?.type === "identifier") {
          if (statement.child(0)?.type === "local") info.locals.add(target.text);
        } else {
          const owner = dotted(target?.childForFieldName("table") ?? null);
          if (owner) info.owners.add(owner);
        }
        break;
      }
      case "variable_declaration": {
        const assignment = assignmentOf(statement);
        const list = named(assignment ?? statement, "variable_list");
        const names = list ? namesOf(list) : [];
        for (const name of names) info.locals.add(name.text);
        const value = firstValue(statement);
        if (names[0] && value) {
          info.values.set(names[0].text, value);
          tables.push({ name: names[0].text, table: tableOf(value) });
        }
        break;
      }
      case "assignment_statement": {
        const list = named(statement, "variable_list");
        const target = list && namesOf(list).length === 1 ? list.namedChild(0) : null;
        const value = bare(firstValue(statement));
        if (target?.type === "identifier") {
          if (!info.locals.has(target.text)) tables.push({ name: target.text, table: tableOf(value) });
        } else if (target?.type === "dot_index_expression") {
          const owner = dotted(target.childForFieldName("table"));
          const field = target.childForFieldName("field")?.text;
          if (owner && (value?.type === "function_definition" || (field === "__index" && value?.text === owner))) {
            info.owners.add(owner);
          }
        }
        break;
      }
      case "return_statement": {
        const value = named(statement, "expression_list")?.namedChild(0) ?? null;
        const plain = bare(value);
        if (plain?.type === "identifier") info.returnedName = plain.text;
        for (const field of tableOf(value)?.namedChildren ?? []) {
          const key = field?.childForFieldName("name");
          const local = field?.childForFieldName("value");
          if (key?.type !== "identifier" || local?.type !== "identifier") continue;
          const list = info.returned.get(local.text);
          if (list) list.push(key.text);
          else info.returned.set(local.text, [key.text]);
        }
        break;
      }
    }
  }
  for (const { name, table } of tables) {
    if (info.owners.has(name) || hasFunctionFields(table)) info.classes.add(name);
  }
  infos.set(node.tree, info);
  return info;
}

/** The function a definition is: the declaration itself, or the function a name or field is set to. */
function functionOf(def: RawDef): Node | null {
  switch (def.kind) {
    case "function":
    case "method":
      return def.node;
    case "field":
      return bare(def.node.childForFieldName("value"));
    default: {
      const value = bare(firstValue(def.node));
      return value?.type === "function_definition" ? value : null;
    }
  }
}

/** What a function defined on a table is: `function Cart.new()` and `function Cart:add()` both belong to Cart. */
function memberOf(target: Node | null, fn: Node | null): DefDecision | null {
  const owner = dotted(target?.childForFieldName("table") ?? null);
  if (!owner) return null;
  // Written with a dot and no `self` to receive, it is called on the table itself.
  const first = fn?.childForFieldName("parameters")?.namedChild(0)?.namedChild(0);
  const isStatic = target?.type === "dot_index_expression" && first?.text !== "self";
  return { kind: "method", owner, ...(isStatic ? { subkind: "static" } : {}) };
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  const node = def.node;
  switch (def.kind) {
    case "function":
      return { kind: "function" };
    case "method":
      return memberOf(node.childForFieldName("name"), node);
    case "assigned":
      return memberOf(named(node, "variable_list")?.namedChild(0) ?? null, functionOf(def));
    case "field": {
      const table = node.parent;
      const holder = table?.parent?.type === "expression_list" ? table.parent.parent : null;
      // A function listed in the table the file returns is one of the functions it exports.
      if (!parent)
        return holder?.type === "return_statement" && holder.parent?.type === "chunk" ? { kind: "function" } : null;
      // Otherwise it counts when it sits directly in a table that is a class, not in one nested inside it.
      const statement =
        holder?.type === "assignment_statement" && holder.parent?.type === "variable_declaration"
          ? holder.parent
          : holder;
      return parent.kind === "class" && statement?.startIndex === parent.start ? { kind: "method" } : null;
    }
    case "local":
    case "global": {
      const info = fileInfo(node);
      // `count = count + 1` at the top of a file sets a local; only a new name is a definition.
      if (def.kind === "global" && info.locals.has(def.name)) return null;
      const value = firstValue(node);
      // What `require` or a Roblox service gives is an import, not something this file defines.
      if (importSource(value)) return null;
      if (bare(value)?.type === "function_definition") return { kind: "function" };
      if (info.classes.has(def.name)) return { kind: "class", subkind: "table" };
      // Among plain assignments only a table is worth a node: the rest set what exists elsewhere.
      return def.kind === "local" || tableOf(value) ? { kind: "variable" } : null;
    }
    case "type":
      // `export type Cart = …` beside the table Cart describes the same thing: the class stands for both.
      return fileInfo(node).classes.has(def.name) ? null : { kind: "type" };
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  return def.node;
}

function exported(def: RawDef, outerNode: Node): Exported {
  switch (def.kind) {
    case "type":
      return outerNode.child(0)?.type === "export" ? 1 : 0;
    case "function":
      // `local function` is the file's own until the file returns it; without `local` it is a global.
      return outerNode.child(0)?.type === "local" ? 0 : 1;
    case "local":
      return 0;
    case "global":
      return 1;
    default:
      return def.name.startsWith("_") ? 0 : 1;
  }
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  let start = def.node.startIndex;
  const fn = functionOf(def);
  if (fn) {
    // A type function was retried as a plain function, but the reader should see what was written.
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (/^\s*(?:export\s+)?type\s+$/.test(source.slice(lineStart, start))) start = lineStart;
    const body = fn.childForFieldName("body");
    const end = body?.startIndex ?? fn.endIndex;
    // A comment before the first statement sits outside the grammar's body node.
    const comment = fn.namedChildren.find((child) => child?.type === "comment" && child.startIndex < end);
    const head = tidySignature(source.slice(start, comment?.startIndex ?? end));
    // A function with nothing in it has no body to stop at.
    return truncate(body ? head : head.replace(/\s*\bend$/, ""), 240) || null;
  }
  const text = source.slice(start, def.node.endIndex);
  const line = text.split("\n", 1)[0]!.trim();
  if (line === text.trim()) return truncate(tidySignature(line), 160) || null;
  // A table or type written over several lines: its first line says what it is.
  return truncate(`${tidySignature(line)} …`, 160);
}

/** A comment's text without Lua's markers: `--`, `---`, `--[[ ]]`, `--[=[ ]=]`. */
function cleanLuaComment(raw: string): string | null {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    // `--!strict` and its like are instructions to the compiler.
    .filter((line) => !line.startsWith("--!"))
    .map((line) =>
      line
        .replace(/^--+\[=*\[/, "")
        .replace(/\]=*\]$/, "")
        .replace(/^--+ ?/, "")
        .trim(),
    );
  // Documentation tools put tags first (`@class Cart`, `@within Cart`): the prose is what follows them.
  while (lines.length > 0 && (lines[0] === "" || lines[0]!.startsWith("@"))) lines.shift();
  return cleanComment(lines.join("\n"));
}

function doc(_def: RawDef, outerNode: Node): DocInfo {
  return commentAbove(outerNode, undefined, cleanLuaComment);
}

/** True when a `Cart` or `shop.Cart` is the table in the name of a function being defined. */
function namesDefinedFunction(node: Node): boolean {
  let top = node;
  while (
    top.parent &&
    (top.parent.type === "dot_index_expression" || top.parent.type === "method_index_expression") &&
    fieldIs(top.parent, "table", top)
  ) {
    top = top.parent;
  }
  return top.parent?.type === "function_declaration" && fieldIs(top.parent, "name", top);
}

/**
 * True for the lines every module has and that say nothing about what uses what:
 * `Cart.__index = Cart`, and what the file returns (`return Cart`, `return { owed = owed }`).
 */
function isPlumbing(node: Node, parent: Node): boolean {
  if (parent.type === "dot_index_expression") {
    return parent.childForFieldName("field")?.text === "__index" && parent.parent?.type === "variable_list";
  }
  if (parent.type === "expression_list") {
    const statement = parent.parent;
    if (statement?.type === "return_statement") return statement.parent?.type === "chunk";
    const target = statement?.type === "assignment_statement" ? named(statement, "variable_list")?.namedChild(0) : null;
    return target?.type === "dot_index_expression" && target.text === `${node.text}.__index`;
  }
  if (parent.type === "field") {
    const statement = parent.parent?.parent?.parent;
    return statement?.type === "return_statement" && statement.parent?.type === "chunk";
  }
  return false;
}

/** True when a name is used inside the declaration of the type of that name, as in `type Cart = typeof(setmetatable(…, Cart))`. */
function isOwnType(node: Node): boolean {
  for (let a = node.parent; a; a = a.parent) {
    if (a.type === "type_definition") return bare(a.childForFieldName("name"))?.text.split("<", 1)[0] === node.text;
    if (a.type === "block") return false;
  }
  return false;
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent || isPlumbing(node, parent) || isOwnType(node)) return false;
  switch (parent.type) {
    case "dot_index_expression":
    case "method_index_expression":
      // What comes after the dot is a member, and `function Cart.new()` does not use Cart: it adds to it.
      return fieldIs(parent, "table", node) && !namesDefinedFunction(parent);
    case "function_declaration":
    case "field":
    case "type_definition":
    case "for_numeric_clause":
      return !fieldIs(parent, "name", node);
    case "generic_type":
      // `type Pair<K, V> = …` declares all three names.
      return !(parent.parent?.type === "type_definition" && fieldIs(parent.parent, "name", parent));
    case "parameter":
      return parent.namedChild(0)?.id !== node.id;
    case "variable_list": {
      // A type written after a name is a use of that type.
      if (node.previousSibling?.type === ":") return true;
      const statement = parent.parent;
      if (statement?.type === "for_generic_clause") return false;
      return !(statement?.type === "assignment_statement" && statement.parent?.type === "variable_declaration");
    }
    case "object_type":
    case "function_type":
      // `{ name: string }`, `(item: Item) -> ()`: the name before the colon is a field or a parameter.
      return node.nextSibling?.type !== ":";
    case "field_type":
      return parent.namedChild(0)?.id === node.id;
    case "attribute":
      return false;
    default:
      return true;
  }
}

// ------------------------------------------------- syntax newer than the grammar

/** Comments and strings: nothing in them is syntax. */
function literalRanges(root: Node): [number, number][] {
  const ranges: [number, number][] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "comment" || (node.type === "string" && !named(node, "interpolation"))) {
      ranges.push([node.startIndex, node.endIndex]);
      continue;
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** The end of a `<…>` list that opens at `open`, or -1 when it does not close within a few lines. */
function closingAngle(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 600; i++) {
    const ch = text[i];
    if (ch === "<") depth++;
    else if (ch === ">" && text[i - 1] !== "-") {
      if (--depth === 0) return i;
    } else if (ch === ")" && depth === 1 && text.slice(open, i).indexOf("(") < 0) return -1;
  }
  return -1;
}

/** Each rule finds text the grammar does not know and gives what to put in its place, of the same length. */
type Rewrite = [pattern: RegExp, replace: (match: RegExpExecArray) => string];

const spaces = (text: string) => text.replace(/[^\n]/g, " ");

/**
 * Luau syntax added since the grammar was written. None of it changes what a file defines
 * or calls, so it is taken out: attributes (`@native`), type packs, the `|` or `&` a type may start
 * with, `read` and `write` on a table type's fields, types on loop variables, explicit
 * type arguments (`f<<number>>()`), and the word `type` before a type function.
 * A `const` binding is read as a `local` of the same width.
 */
const LUAU_REWRITES: Rewrite[] = [
  [/(?<=^|\n)[ \t]*@(?:[A-Za-z_]\w*|\[[^\]\n]*\])/g, (m) => spaces(m[0])],
  [/\bconst(?=\s+[A-Za-z_])/g, () => "local"],
  [/\b([A-Za-z_]\w*)\.\.\./g, (m) => `${m[1]}   `],
  [/(=|:|->|[(,<{?])(\s*)[|&](?![|&=])/g, (m) => `${m[1]}${m[2]} `],
  [/([{,;]\s*)(read|write)(?=\s+[A-Za-z_]\w*\s*:)/g, (m) => m[1]! + spaces(m[2]!)],
  [/\bfor\s[^=\n]*?(?=\s*=|\s+in\s)/g, (m) => m[0].replace(/:[^,]*/g, spaces)],
  [/<<[^<>\n]*>>(?=\s*\()/g, (m) => spaces(m[0])],
  [/\b(?:export\s+)?type(?=\s+function\b)/g, (m) => spaces(m[0])],
];

/** Lua since 5.1 that Luau never took up: `goto` and its labels, and the bitwise operators of 5.3. */
const LUA_REWRITES: Rewrite[] = [
  [/\bgoto\s+[A-Za-z_]\w*/g, (m) => spaces(m[0])],
  [/::\s*[A-Za-z_]\w*\s*::/g, (m) => spaces(m[0])],
  // Any operator of the same width will do: what is on either side is read all the same.
  [/<<|>>/g, () => "+ "],
  [/[&|]/g, () => "+"],
  [/~(?!=)/g, () => "-"],
];

/**
 * In the generic parameters of a type or function, the parts the grammar does not know:
 * `T...` for a pack of types and `= Default`.
 */
function blankGenerics(text: string, isLiteral: (start: number, end: number) => boolean): string {
  let out = text;
  // Generic function types (`map: <T>(T) -> T`) are functions to the grammar after their binder is blanked.
  for (const match of text.matchAll(/(?:[:=(,]|->)\s*</g)) {
    const open = match.index + match[0].length - 1;
    const close = closingAngle(text, open);
    if (close < 0 || isLiteral(open, close + 1) || !/^\s*\(/.test(text.slice(close + 1))) continue;
    out = out.slice(0, open) + spaces(out.slice(open, close + 1)) + out.slice(close + 1);
  }
  for (const match of text.matchAll(/\b(?:type\s+[A-Za-z_]\w*|function(?:\s+[A-Za-z_][\w.:]*)?)\s*</g)) {
    const open = match.index + match[0].length - 1;
    const close = closingAngle(text, open);
    if (close < 0 || isLiteral(open, close)) continue;
    let depth = 0;
    let defaultFrom = -1;
    const blank = (start: number, end: number) => {
      out = out.slice(0, start) + spaces(out.slice(start, end)) + out.slice(end);
    };
    for (let i = open; i <= close; i++) {
      const ch = text[i];
      if (ch === "<" || ch === "(" || ch === "{") depth++;
      else if (ch === ")" || ch === "}" || (ch === ">" && text[i - 1] !== "-")) depth--;
      const atEnd = (depth === 1 && ch === ",") || i === close;
      if (defaultFrom >= 0 && atEnd) {
        blank(defaultFrom, i);
        defaultFrom = -1;
      } else if (depth === 1 && defaultFrom < 0) {
        if (ch === "=") defaultFrom = i;
        else if (text.startsWith("...", i)) blank(i, i + 3);
      }
    }
  }
  return out;
}

function reparseWith(rewrites: Rewrite[]): (source: string, root: Node) => string | null {
  return (source, root) => {
    const literals = literalRanges(root);
    const isLiteral = (start: number, end: number) => literals.some(([s, e]) => s < end && e > start);
    let text = blankGenerics(source, isLiteral);
    for (const [pattern, replace] of rewrites) {
      pattern.lastIndex = 0;
      let out = "";
      let last = 0;
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        if (match[0] === "") pattern.lastIndex++;
        const end = match.index + match[0].length;
        if (isLiteral(match.index, end)) continue;
        const replaced = replace(match);
        // A rule that would move the rest of the file is not applied: positions must hold.
        if (replaced.length !== match[0].length) continue;
        out += text.slice(last, match.index) + replaced;
        last = end;
      }
      text = out + text.slice(last);
    }
    return text === source ? null : text;
  };
}

// ---------------------------------------------------------------- imports

/**
 * Where an expression points in the Roblox data model, as the names from a starting point:
 * `script.Parent.Item`, `game.ReplicatedStorage.Shared.Money`. A local set to a service or
 * to another path is followed; anything not known starts with `?`.
 */
function instancePath(node: Node | null, info: FileInfo, depth = 0): string[] | null {
  const expr = bare(node);
  if (!expr || depth > 6) return null;
  switch (expr.type) {
    case "identifier": {
      const name = expr.text;
      if (name === "script" || name === "game") return [name];
      if (name === "workspace") return ["game", "Workspace"];
      const value = info.values.get(name);
      const known = value ? instancePath(value, info, depth + 1) : null;
      // An unknown name is often that of the folder it holds: kept, it helps tell candidates apart.
      return known ?? ["?", name];
    }
    case "dot_index_expression": {
      const base = instancePath(expr.childForFieldName("table"), info, depth + 1);
      const field = expr.childForFieldName("field")?.text;
      return base && field ? [...base, field] : null;
    }
    case "function_call": {
      const callee = expr.childForFieldName("name");
      if (callee?.type !== "method_index_expression") return null;
      const method = callee.childForFieldName("method")?.text ?? "";
      const argument = stringArgument(expr);
      const base = instancePath(callee.childForFieldName("table"), info, depth + 1);
      if (!base || !argument) return null;
      if (method === "GetService" && base.length === 1 && base[0] === "game") return ["game", argument];
      return CHILD_LOOKUPS.has(method) ? [...base, argument] : null;
    }
    default:
      return null;
  }
}

/** The names an import is known by in its file, and whether the file passes them on. */
function bindings(call: Node, member: string | null, info: FileInfo): { names: ImportName[]; reexport: boolean } {
  const imported = member ?? "default";
  // Up from the call to the statement it is the value of, past `:: any`, parentheses and `.Member`.
  let value = call;
  while (
    value.parent &&
    (value.parent.type === "cast_expression" ||
      value.parent.type === "parenthesized_expression" ||
      (member !== null && value.parent.type === "dot_index_expression"))
  ) {
    value = value.parent;
  }
  const holder = value.parent;
  if (holder?.type === "field") {
    // `return { Cart = require("./Cart") }`: the file hands the module on under that name.
    const key = holder.childForFieldName("name");
    const statement = holder.parent?.parent?.parent;
    const isReturned = statement?.type === "return_statement" && statement.parent?.type === "chunk";
    return key?.type === "identifier" && isReturned
      ? { names: [{ local: key.text, imported }], reexport: true }
      : { names: [], reexport: false };
  }
  if (holder?.type !== "expression_list") return { names: [], reexport: false };
  const statement = holder.parent;
  if (statement?.type === "return_statement") {
    // `return require("./impl")`: this module is that one.
    return statement.parent?.type === "chunk"
      ? { names: [{ local: "default", imported }], reexport: true }
      : { names: [], reexport: false };
  }
  const list = statement?.type === "assignment_statement" ? named(statement, "variable_list") : null;
  const index = holder.namedChildren.findIndex((c) => c?.id === value.id);
  const target = list ? namesOf(list)[index] : undefined;
  if (target?.type !== "identifier") return { names: [], reexport: false };
  const local = target.text;
  const names: ImportName[] = [{ local, imported }];
  // Only what is declared at the top of the file can be what the file returns.
  if (statement?.parent?.parent?.type !== "chunk") return { names, reexport: false };
  for (const key of info.returned.get(local) ?? []) if (key !== local) names.push({ local: key, imported });
  if (info.returnedName === local) names.push({ local: "default", imported });
  return { names, reexport: info.returned.has(local) || info.returnedName === local };
}

function parseImport(node: Node): ImportDecl[] {
  const info = fileInfo(node);
  const line = node.startPosition.row + 1;
  if (isService(node)) {
    const service = stringArgument(node);
    if (!service) return [];
    // A service is a value of the platform's: nothing is passed on, and nothing on it is the project's.
    const local = bindings(node, null, info).names[0]?.local;
    return [{ specifier: `service:${service}`, line, names: local ? [{ local, imported: "*" }] : [], reexport: false }];
  }
  const literal = stringArgument(node);
  const args = node.childForFieldName("arguments");
  const path = literal === null && args?.type === "arguments" ? instancePath(args.namedChild(0), info) : null;
  const specifier = literal ?? (path ? `rbx:${path.join(".")}` : null);
  if (!specifier) return [];
  const member =
    node.parent?.type === "dot_index_expression" ? (node.parent.childForFieldName("field")?.text ?? null) : null;
  return [{ specifier, line, ...bindings(node, member, info) }];
}

/** The file a module path stands for: the path itself, with an extension, or a folder's `init` file. */
function moduleFile(path: string | null, ctx: ResolveContext): string | null {
  if (path === null) return null;
  if (SCRIPT_FILE.test(path) && ctx.hasFile(path)) return path;
  for (const candidate of [`${path}.luau`, `${path}.lua`, `${path}/init.luau`, `${path}/init.lua`]) {
    if (ctx.hasFile(candidate)) return candidate;
  }
  return null;
}

function isInit(path: string): boolean {
  return /^init\.luau?$/.test(posixBasename(path));
}

/** JSON as configuration files are written: with comments and trailing commas. */
function parseLenientJson(text: string | null): unknown {
  if (text === null) return null;
  const plain = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

/** Where an alias (`@shared/…`) points, from the nearest `.luaurc` that defines it. */
function aliasTarget(alias: string, fromFile: string, ctx: ResolveContext): string | null {
  for (let dir: string | null = posixDirname(fromFile); dir !== null; dir = dir === "" ? null : posixDirname(dir)) {
    const folder = dir;
    const aliases = ctx.memo(`luau.aliases:${folder}`, () => {
      const rc = parseLenientJson(ctx.read(folder === "" ? ".luaurc" : `${folder}/.luaurc`)) as {
        aliases?: Record<string, unknown>;
      } | null;
      return rc?.aliases && typeof rc.aliases === "object" ? rc.aliases : null;
    });
    const target = aliases?.[alias];
    if (typeof target === "string") return posixJoin(folder, toPosix(target));
  }
  return null;
}

function resolveString(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const spec = toPosix(imp.specifier);
  const names = imp.names;
  const dir = posixDirname(fromFile);
  const found = (file: string | null): ResolvedImport[] | null => (file ? [{ file, names }] : null);

  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const alias = spec.slice(1, slash < 0 ? undefined : slash);
    const rest = slash < 0 ? "" : spec.slice(slash + 1);
    // `@self` is the module's own folder.
    const base = alias === "self" ? dir : aliasTarget(alias, fromFile, ctx);
    const file = base === null ? null : moduleFile(posixJoin(base, rest), ctx);
    if (file) return [{ file, names }];
    // A runtime's own library (`@lune/fs`), or an alias this project does not define.
    const [id, name] =
      alias === "lune" || alias === "std" ? [`${alias}/${rest}`, spec] : [`luau/${alias}`, `@${alias}`];
    return base === null
      ? [{ external: { id: `ext:${id}`, name, ecosystem: alias === "lune" ? "lune" : "luau" }, names }]
      : [{ names }];
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    // Beside the file; for a folder's `init` file also beside the folder, which is how Luau itself reads it.
    const beside = moduleFile(posixJoin(dir, spec), ctx);
    const outside =
      !beside && isInit(fromFile) && dir !== "" ? moduleFile(posixJoin(posixDirname(dir), spec), ctx) : null;
    return found(beside ?? outside) ?? [{ names }];
  }
  // Lua's own form: a name looked up along the package path, with dots between folders.
  const written = spec.includes("/") ? spec : spec.replace(/\./g, "/");
  const direct = moduleFile(posixJoin(dir, written), ctx) ?? moduleFile(written, ctx);
  if (direct) return [{ file: direct, names }];
  const base = posixBasename(written);
  const candidates = [`${base}.luau`, `${base}.lua`]
    .flatMap((file) => ctx.filesNamed(file).filter((f) => f.endsWith(`/${written}${file.slice(base.length)}`)))
    .concat(
      ["init.luau", "init.lua"].flatMap((file) =>
        ctx.filesNamed(file).filter((f) => f.endsWith(`/${written}/${file}`)),
      ),
    )
    .sort((a, b) => a.length - b.length);
  if (candidates[0]) return [{ file: candidates[0], names }];
  const name = written.split("/")[0]!;
  return [{ external: { id: `ext:lua/${name}`, name, ecosystem: "lua" }, names }];
}

/** Where each named part of the Roblox data model is kept on disk, from the project files Rojo reads. */
function rojoTree(ctx: ResolveContext): { instance: string[]; path: string }[] {
  return ctx.memo("luau.rojo", () => {
    const out: { instance: string[]; path: string }[] = [];
    const projects = new Set([
      ...ctx.filesIn("").filter((f) => f.endsWith(".project.json")),
      ...ctx.filesNamed("default.project.json"),
    ]);
    for (const file of projects) {
      const json = parseLenientJson(ctx.read(file)) as { tree?: unknown } | null;
      const visit = (node: unknown, instance: string[], depth: number) => {
        if (!node || typeof node !== "object" || depth > 12) return;
        const at = (node as Record<string, unknown>).$path;
        const path = typeof at === "string" ? posixJoin(posixDirname(file), toPosix(at)) : null;
        // The top of the tree is the game itself; a library's project has no names to go by.
        if (path !== null && instance.length > 0) out.push({ instance, path });
        for (const [key, child] of Object.entries(node)) {
          if (!key.startsWith("$")) visit(child, [...instance, key], depth + 1);
        }
      };
      visit(json?.tree, [], 0);
    }
    // The longest match wins: `ReplicatedStorage.Shared` before `ReplicatedStorage`.
    return out.sort((a, b) => b.instance.length - a.instance.length);
  });
}

/** The name a script goes by in the game: `Cart` for `Cart.luau`, and for `Cart.server.luau` too. */
function instanceName(file: string): string {
  return posixBasename(file)
    .replace(SCRIPT_FILE, "")
    .replace(/\.(server|client)$/, "");
}

/**
 * The one module a path's last names point at when nothing says where the path starts: a
 * file of that name inside folders named like the rest of the path. At least one folder
 * has to agree, and one candidate has to agree more than the others.
 */
function byName(segments: string[], ctx: ResolveContext): string | null {
  const last = segments[segments.length - 1]!;
  const candidates = [
    ...ctx.filesNamed(`${last}.luau`),
    ...ctx.filesNamed(`${last}.lua`),
    ...["init.luau", "init.lua"].flatMap((f) =>
      ctx.filesNamed(f).filter((p) => posixBasename(posixDirname(p)) === last),
    ),
  ];
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const file of candidates) {
    const folders = (isInit(file) ? posixDirname(posixDirname(file)) : posixDirname(file)).split("/").filter(Boolean);
    let score = 0;
    while (
      score < folders.length &&
      score < segments.length - 1 &&
      folders[folders.length - 1 - score]!.toLowerCase() === segments[segments.length - 2 - score]!.toLowerCase()
    ) {
      score++;
    }
    if (score > bestScore) {
      best = file;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) tied = true;
  }
  return bestScore > 0 && !tied ? best : null;
}

function resolveInstance(segments: string[], imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const names = imp.names;
  const root = segments[0];
  const rest = segments.slice(1);
  let file: string | null = null;
  if (root === "script") {
    // A script is where its file is; an `init` file is its folder. `Parent` is the folder above.
    let at: string | null = isInit(fromFile)
      ? posixDirname(fromFile)
      : posixJoin(posixDirname(fromFile), instanceName(fromFile));
    for (const segment of rest) {
      if (at === null) break;
      at = segment === "Parent" ? (at === "" ? null : posixDirname(at)) : posixJoin(at, segment);
    }
    file = at === null || rest.length === 0 ? null : moduleFile(at, ctx);
  } else if (root === "game") {
    for (const mapped of rojoTree(ctx)) {
      if (mapped.instance.length > rest.length || mapped.instance.some((name, i) => name !== rest[i])) continue;
      file = moduleFile(posixJoin(mapped.path, ...rest.slice(mapped.instance.length)), ctx);
      break;
    }
  }
  file ??= rest.includes("Parent") ? null : byName(rest, ctx);
  if (file) return [{ file, names }];
  // What sits in a packages folder was installed, not written here.
  const folder = rest.findIndex((segment) => PACKAGE_FOLDERS.has(segment));
  const name = folder >= 0 ? rest[folder + 1] : undefined;
  return name ? [{ external: { id: `ext:wally/${name}`, name, ecosystem: "wally" }, names }] : [{ names }];
}

function resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  if (imp.specifier.startsWith("service:")) {
    const name = imp.specifier.slice("service:".length);
    return [{ external: { id: `ext:roblox/${name}`, name, ecosystem: "roblox" }, names: imp.names }];
  }
  if (imp.specifier.startsWith("rbx:")) {
    return resolveInstance(imp.specifier.slice("rbx:".length).split("."), imp, fromFile, ctx);
  }
  return resolveString(imp, fromFile, ctx);
}

export const luau: LanguageSpec = {
  id: "luau",
  grammar: "luau",
  family: "luau",
  query: QUERY,
  scopeBreakers: new Set(["block"]),
  selfNames: new Set(["self"]),
  importsAreExports: false,
  moduleValues: true,
  globals: GLOBALS,
  commonMembers: COMMON_MEMBERS,
  classify,
  outer,
  exported,
  signature,
  doc,
  isIdentUsage,
  reparse: reparseWith(LUAU_REWRITES),
  parseImport,
  resolveImport,
};

/** Lua files are read with the same grammar: Luau grew out of Lua 5.1 and still reads it. */
export const lua: LanguageSpec = { ...luau, id: "lua", reparse: reparseWith([...LUAU_REWRITES, ...LUA_REWRITES]) };
