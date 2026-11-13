import { builtinModules } from "node:module";
import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl, ImportName } from "../../types.js";
import { posixDirname, posixJoin, tidySignature, truncate } from "../../util.js";
import type {
  DefDecision,
  DocInfo,
  LanguageSpec,
  RawDef,
  ResolveContext,
  ResolvedImport,
  SymbolInfo,
} from "../spec.js";

type Flavor = "javascript" | "typescript" | "tsx";

/** Patterns shared by JavaScript and TypeScript. */
const COMMON_QUERY = `
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(method_definition name: (_) @name) @def.method
(pair key: [(property_identifier) (string)] @name value: [(arrow_function) (function_expression)]) @def.method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function
(variable_declarator name: (identifier) @name) @def.variable

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (member_expression object: (_) @qualifier property: (property_identifier) @name)) @ref.call
(new_expression constructor: (identifier) @name) @ref.new
(new_expression constructor: (member_expression object: (_) @qualifier property: (property_identifier) @name)) @ref.new

(identifier) @ref.ident
(shorthand_property_identifier) @ref.ident

(import_statement) @import
(export_statement source: (string)) @import
(call_expression
  function: (identifier) @_fn
  arguments: (arguments . (string) .)
  (#eq? @_fn "require")) @import
(call_expression function: (import) arguments: (arguments . (string) .)) @import

(export_statement !source (export_clause (export_specifier name: (identifier) @name))) @export.named
(export_statement value: (identifier) @name) @export.default

(variable_declarator name: (identifier) @var value: (new_expression constructor: [(identifier) (member_expression)] @newtype))
(variable_declarator name: (identifier) @var value: (call_expression function: [(identifier) (member_expression)] @varcall))
(variable_declarator name: (identifier) @var value: (await_expression (call_expression function: [(identifier) (member_expression)] @varcall)))
(assignment_expression
  left: (member_expression object: (this) property: (property_identifier) @fieldvar)
  right: (new_expression constructor: [(identifier) (member_expression)] @newtype))
(assignment_expression
  left: (member_expression object: (this) property: (property_identifier) @fieldvar)
  right: [(identifier) (member_expression)] @varvalue)
(variable_declarator name: (identifier) @var value: (member_expression) @varvalue)
`;

const JAVASCRIPT_QUERY = `
(class_declaration name: (identifier) @name) @def.class
(field_definition property: (_) @name value: [(arrow_function) (function_expression)]) @def.method
(class_heritage (identifier) @name) @ref.extends
(class_heritage (member_expression object: (_) @qualifier property: (property_identifier) @name)) @ref.extends
(field_definition property: (property_identifier) @var value: (new_expression constructor: [(identifier) (member_expression)] @newtype))
`;

const TYPESCRIPT_QUERY = `
(class_declaration name: (type_identifier) @name) @def.class
(abstract_class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(type_alias_declaration name: (type_identifier) @name) @def.type
(enum_declaration name: (identifier) @name) @def.enum
(public_field_definition name: (_) @name value: [(arrow_function) (function_expression)]) @def.method
(class_body (abstract_method_signature name: (_) @name) @def.method)
(class_body (method_signature name: (_) @name) @def.method)
(interface_body (method_signature name: (_) @name) @def.method)
(type_alias_declaration value: (object_type (method_signature name: (_) @name) @def.method))

(required_parameter pattern: (identifier) @var type: (type_annotation (_) @vartype))
(optional_parameter pattern: (identifier) @var type: (type_annotation (_) @vartype))
(required_parameter (accessibility_modifier) pattern: (identifier) @fieldvar type: (type_annotation (_) @vartype))
(optional_parameter (accessibility_modifier) pattern: (identifier) @fieldvar type: (type_annotation (_) @vartype))
(required_parameter "readonly" pattern: (identifier) @fieldvar type: (type_annotation (_) @vartype))
(variable_declarator name: (identifier) @var type: (type_annotation (_) @vartype))
(public_field_definition name: (property_identifier) @var type: (type_annotation (_) @vartype))
(interface_body (property_signature name: (property_identifier) @var type: (type_annotation (_) @vartype)))
(type_alias_declaration value: (object_type (property_signature name: (property_identifier) @var type: (type_annotation (_) @vartype))))
(public_field_definition name: (property_identifier) @var value: (new_expression constructor: [(identifier) (member_expression)] @newtype))

(extends_clause value: (identifier) @name) @ref.extends
(extends_clause value: (member_expression object: (_) @qualifier property: (property_identifier) @name)) @ref.extends
(implements_clause (type_identifier) @name) @ref.implements
(implements_clause (generic_type name: (type_identifier) @name)) @ref.implements
(extends_type_clause type: (type_identifier) @name) @ref.extends
(extends_type_clause type: (generic_type name: (type_identifier) @name)) @ref.extends

(type_parameter name: (type_identifier) @typeparam)
(type_identifier) @ref.type
`;

const SCOPE_BREAKERS = new Set([
  "statement_block",
  "arrow_function",
  "function_expression",
  "object",
  "class",
  "for_statement",
  "for_in_statement",
]);

const CODE_EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"];
/** TypeScript sources are imported with the extension of their compiled output. */
const EXT_SWAPS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const NODE_BUILTINS = new Set(builtinModules);

function stringValue(node: Node | null): string | null {
  if (!node) return null;
  const text = node.text;
  if (text.length >= 2 && /^['"`]/.test(text)) return text.slice(1, -1);
  return text;
}

function isFunctionValue(node: Node | null): boolean {
  return node !== null && (node.type === "arrow_function" || node.type === "function_expression");
}

function cleanComment(raw: string): string | null {
  const out: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine
      .trim()
      .replace(/^\/\*+!?/, "")
      .replace(/\*+\/$/, "")
      .replace(/^\*+ ?/, "")
      .replace(/^\/\/+ ?/, "")
      .trim();
    if (line.startsWith("@")) break;
    if (line === "") {
      if (out.length > 0) break;
      continue;
    }
    out.push(line);
  }
  const text = out.join(" ");
  if (text === "" || /^(eslint|prettier|istanbul|c8|@ts-|biome)/.test(text)) return null;
  return truncate(text, 200);
}

function fieldIs(parent: Node, field: string, node: Node): boolean {
  return parent.childForFieldName(field)?.id === node.id;
}

function classify(def: RawDef, parent: SymbolInfo | null, nested = false): DefDecision | null {
  const nameType = def.nameNode.type;
  if (nameType === "computed_property_name") return null;
  const name = nameType === "string" ? (stringValue(def.nameNode) ?? def.name) : def.name;
  if (nested) {
    // A named function inside a function or method; a method of an object literal held by a variable.
    if (def.kind === "function" && parent && (parent.kind === "function" || parent.kind === "method")) {
      return { kind: "function", name };
    }
    if (def.kind === "method" && parent?.kind === "variable") return { kind: "method", name };
    if (def.kind === "method" && parent && (parent.kind === "function" || parent.kind === "method")) {
      // `return { run() {…} }` inside a factory: the methods of the object it builds.
      return def.node.type === "method_definition" || def.node.type === "pair" ? { kind: "function", name } : null;
    }
    return null;
  }
  if (def.node.type === "pair") return null;
  switch (def.kind) {
    case "function":
      return parent ? null : { kind: "function", name };
    case "class":
      return parent ? null : { kind: "class", name };
    case "interface":
      return parent ? null : { kind: "interface", name };
    case "type":
      return parent ? null : { kind: "type", name };
    case "enum":
      return parent ? null : { kind: "type", subkind: "enum", name };
    case "variable":
      return parent ? null : { kind: "variable", name };
    case "method": {
      if (!parent || (parent.kind !== "class" && parent.kind !== "interface" && parent.kind !== "type")) return null;
      // An overload signature: the implementation that follows stands for it.
      if (def.node.type === "method_signature" && def.node.parent?.type === "class_body") {
        for (const sibling of def.node.parent.namedChildren) {
          if (sibling?.type === "method_definition" && sibling.childForFieldName("name")?.text === def.name)
            return null;
        }
      }
      return { kind: "method", name };
    }
    default:
      return null;
  }
}

/** Objects every JavaScript program can use without importing them. */
// biome-ignore format: a list of words reads better packed
const JS_GLOBALS = new Set([
  "Promise", "Object", "Array", "JSON", "Math", "Date", "Number", "String", "Boolean", "Symbol", "Reflect", "Proxy",
  "Intl", "BigInt", "RegExp", "Error", "Map", "Set", "WeakMap", "WeakSet", "ArrayBuffer", "DataView", "Atomics",
  "console", "process", "Buffer", "URL", "URLSearchParams", "crypto", "performance", "globalThis", "window",
  "document", "navigator", "location", "history", "localStorage", "sessionStorage", "TextEncoder", "TextDecoder",
  "AbortSignal", "AbortController", "Response", "Request", "Headers", "WebAssembly", "Float32Array", "Float64Array",
  "Uint8Array", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array", "Int32Array", "BigInt64Array",
  "BigUint64Array", "Uint8ClampedArray", "Iterator", "module", "exports", "require",
]);

/** Types that say nothing about which methods a value has. */
const UNTYPED = new Set(["any", "unknown"]);
/** Members of a union that only say the value may be missing. */
const EMPTY_TYPES = new Set(["null", "undefined", "void"]);

/** The type a written annotation names: `Store` for `Store | null`, `Map` for `Map<K, V>`, `Array` for `T[]`. */
function hintType(node: Node): string | null {
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "predefined_type":
      return UNTYPED.has(node.text) ? null : node.text;
    case "generic_type": {
      const name = node.childForFieldName("name");
      return name ? hintType(name) : null;
    }
    case "nested_type_identifier":
      return node.text.replace(/\s+/g, "");
    case "array_type":
    case "tuple_type":
      return "Array";
    case "readonly_type":
    case "parenthesized_type":
      return node.namedChild(0) ? hintType(node.namedChild(0)!) : null;
    case "function_type":
    case "object_type":
    case "constructor_type":
    case "literal_type":
    case "template_literal_type":
      return "{}";
    case "union_type": {
      const members: Node[] = [];
      const collect = (n: Node) => {
        for (const child of n.namedChildren) {
          if (!child) continue;
          if (child.type === "union_type") collect(child);
          else if (!EMPTY_TYPES.has(child.text)) members.push(child);
        }
      };
      collect(node);
      return members.length === 1 ? hintType(members[0]!) : null;
    }
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  let node = def.node;
  const parent = node.parent;
  if (
    node.type === "variable_declarator" &&
    parent &&
    (parent.type === "lexical_declaration" || parent.type === "variable_declaration")
  ) {
    node = parent;
  }
  if (node.parent?.type === "export_statement") node = node.parent;
  return node;
}

function exported(def: RawDef, outerNode: Node, parent: SymbolInfo | null): Exported {
  if (parent) {
    // What a function defines inside itself is its own business.
    if (!parent.exported || parent.kind === "function" || parent.kind === "method") return 0;
    if (def.name.startsWith("#")) return 0;
    for (const child of def.node.children) {
      if (child?.type === "accessibility_modifier" && child.text !== "public") return 0;
    }
    return 1;
  }
  if (outerNode.type !== "export_statement") return 0;
  for (const child of outerNode.children) {
    if (child?.type === "default") return 2;
  }
  return 1;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  const node = def.node;
  const start = node.startIndex;
  let end = node.endIndex;
  let prefix = "";
  if (node.type === "variable_declarator") {
    const keyword = node.parent?.child(0)?.text;
    if (keyword === "const" || keyword === "let" || keyword === "var") prefix = `${keyword} `;
  }
  const value = node.childForFieldName("value");
  const body = (isFunctionValue(value) ? value!.childForFieldName("body") : null) ?? node.childForFieldName("body");
  if (body && body.startIndex > start) end = body.startIndex;
  const text = tidySignature(source.slice(start, end))
    .replace(/[{;,]$/, "")
    .trim();
  // With no body to cut at (a constant, a type alias) the whole declaration is the signature; keep it short.
  return text ? truncate(prefix + text, body ? 240 : 160) : null;
}

function doc(_def: RawDef, outerNode: Node, _source: string): DocInfo {
  const comments: Node[] = [];
  let expectedRow = outerNode.startPosition.row;
  let prev = outerNode.previousNamedSibling;
  while (prev && prev.type === "comment" && prev.endPosition.row >= expectedRow - 1) {
    comments.unshift(prev);
    if (prev.text.startsWith("/*")) break;
    expectedRow = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  const first = comments[0];
  if (!first) return { text: null };
  const text = cleanComment(comments.map((c) => c.text).join("\n"));
  return text ? { text, startLine: first.startPosition.row + 1 } : { text: null };
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "variable_declarator":
    case "function_declaration":
    case "generator_function_declaration":
    case "function_expression":
    case "class_declaration":
    case "class":
    case "enum_declaration":
      return !fieldIs(parent, "name", node);
    case "required_parameter":
    case "optional_parameter":
      return !fieldIs(parent, "pattern", node);
    case "assignment_pattern":
    case "for_in_statement":
      return !fieldIs(parent, "left", node);
    case "arrow_function":
    case "catch_clause":
      return !fieldIs(parent, "parameter", node);
    case "formal_parameters":
    case "rest_pattern":
    case "array_pattern":
    case "object_pattern":
    case "pair_pattern":
    case "import_specifier":
    case "namespace_import":
    case "import_clause":
    case "export_specifier":
    case "namespace_export":
    case "export_statement":
    case "labeled_statement":
    case "break_statement":
    case "continue_statement":
      return false;
    default:
      return true;
  }
}

function specifierNames(clause: Node, specifierType: string): ImportName[] {
  const names: ImportName[] = [];
  for (const spec of clause.namedChildren) {
    if (!spec || spec.type !== specifierType) continue;
    const name = spec.childForFieldName("name");
    const alias = spec.childForFieldName("alias");
    if (name) names.push({ local: stringValue(alias ?? name)!, imported: stringValue(name)! });
  }
  return names;
}

function parseImport(node: Node): ImportDecl[] {
  const line = node.startPosition.row + 1;

  if (node.type === "import_statement") {
    const specifier = stringValue(node.childForFieldName("source"));
    if (!specifier) return [];
    const names: ImportName[] = [];
    for (const child of node.namedChildren) {
      if (child?.type !== "import_clause") continue;
      for (const part of child.namedChildren) {
        if (!part) continue;
        if (part.type === "identifier") names.push({ local: part.text, imported: "default" });
        else if (part.type === "namespace_import") {
          const local = part.namedChildren.find((c) => c?.type === "identifier");
          if (local) names.push({ local: local.text, imported: "*" });
        } else if (part.type === "named_imports") names.push(...specifierNames(part, "import_specifier"));
      }
    }
    return [{ specifier, line, names, reexport: false }];
  }

  if (node.type === "export_statement") {
    const specifier = stringValue(node.childForFieldName("source"));
    if (!specifier) return [];
    const names: ImportName[] = [];
    let sawClause = false;
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === "export_clause") {
        sawClause = true;
        names.push(...specifierNames(child, "export_specifier"));
      } else if (child.type === "namespace_export") {
        sawClause = true;
        const local = child.namedChildren.find((c) => c?.type === "identifier");
        if (local) names.push({ local: local.text, imported: "*" });
      }
    }
    if (!sawClause) names.push({ local: "*", imported: "*" });
    return [{ specifier, line, names, reexport: true }];
  }

  // require("x") or import("x")
  const args = node.childForFieldName("arguments");
  const specifier = stringValue(args?.namedChild(0) ?? null);
  if (!specifier) return [];
  const names: ImportName[] = [];
  const declarator = node.parent;
  if (declarator?.type === "variable_declarator" && fieldIs(declarator, "value", node)) {
    const target = declarator.childForFieldName("name");
    if (target?.type === "identifier") {
      names.push({ local: target.text, imported: "*" });
    } else if (target?.type === "object_pattern") {
      for (const prop of target.namedChildren) {
        if (!prop) continue;
        if (prop.type === "shorthand_property_identifier_pattern") {
          names.push({ local: prop.text, imported: prop.text });
        } else if (prop.type === "pair_pattern") {
          const key = prop.childForFieldName("key");
          const value = prop.childForFieldName("value");
          if (key && value?.type === "identifier") names.push({ local: value.text, imported: key.text });
        }
      }
    }
  }
  return [{ specifier, line, names, reexport: false }];
}

/** Find the project file a module path refers to, trying the usual extensions and index files. */
function resolveModulePath(base: string, ctx: ResolveContext): string | null {
  if (ctx.hasFile(base)) return base;
  for (const [from, tos] of Object.entries(EXT_SWAPS)) {
    if (!base.endsWith(from)) continue;
    const stem = base.slice(0, -from.length);
    for (const to of tos) if (ctx.hasFile(stem + to)) return stem + to;
  }
  for (const ext of CODE_EXTS) if (ctx.hasFile(base + ext)) return base + ext;
  for (const ext of CODE_EXTS) if (ctx.hasFile(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

/** JSON with comments and trailing commas, as tsconfig.json allows. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, "$1"));
}

function readJson(path: string, ctx: ResolveContext): Record<string, unknown> | null {
  const text = ctx.read(path);
  if (text === null) return null;
  try {
    const value = parseJsonc(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Path aliases in force for a directory, from the nearest tsconfig.json or jsconfig.json. */
interface PathConfig {
  /** Project-relative directory bare imports may also be resolved against, or null. */
  baseUrl: string | null;
  /** Patterns such as `@lib/*`, longest prefix first, with targets already relative to the project. */
  paths: { prefix: string; suffix: string; wildcard: boolean; targets: string[] }[];
}

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];

/** compilerOptions of a config file, merged over those of the configs it extends. */
function compilerOptions(
  path: string,
  ctx: ResolveContext,
  depth: number,
): { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string } {
  const json = readJson(path, ctx);
  if (!json || depth > 5) return {};
  const dir = posixDirname(path);
  let merged: { baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string } = {};
  const parents = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
  for (const parent of parents) {
    // Only configs inside the project can be read; one from a package (`@tsconfig/node20`) sets no aliases worth having.
    if (typeof parent !== "string" || !parent.startsWith(".")) continue;
    const target = posixJoin(dir, parent.endsWith(".json") ? parent : `${parent}.json`);
    if (target && ctx.hasFile(target)) merged = { ...merged, ...compilerOptions(target, ctx, depth + 1) };
  }
  const options = (json.compilerOptions ?? {}) as { baseUrl?: unknown; paths?: unknown };
  if (typeof options.baseUrl === "string") merged.baseUrl = posixJoin(dir, options.baseUrl) ?? undefined;
  if (options.paths && typeof options.paths === "object") {
    merged.paths = options.paths as Record<string, string[]>;
    merged.pathsDir = dir;
  }
  return merged;
}

function pathConfig(dir: string, ctx: ResolveContext): PathConfig | null {
  return ctx.memo(`js.paths:${dir}`, () => {
    for (let current: string | null = dir; current !== null; current = current === "" ? null : posixDirname(current)) {
      for (const name of CONFIG_NAMES) {
        const path = current === "" ? name : `${current}/${name}`;
        if (!ctx.hasFile(path)) continue;
        const options = compilerOptions(path, ctx, 0);
        // Without baseUrl, path targets are relative to the config that declares them.
        const targetBase = options.baseUrl ?? options.pathsDir ?? posixDirname(path);
        const paths: PathConfig["paths"] = [];
        for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
          if (!Array.isArray(targets)) continue;
          const star = pattern.indexOf("*");
          paths.push({
            prefix: star < 0 ? pattern : pattern.slice(0, star),
            suffix: star < 0 ? "" : pattern.slice(star + 1),
            wildcard: star >= 0,
            targets: targets
              .filter((t): t is string => typeof t === "string")
              .map((t) => posixJoin(targetBase, t))
              .filter((t): t is string => t !== null),
          });
        }
        paths.sort((a, b) => b.prefix.length - a.prefix.length);
        return { baseUrl: options.baseUrl ?? null, paths };
      }
    }
    return null;
  });
}

/** A file an alias from tsconfig.json or jsconfig.json points to. */
function resolveAlias(spec: string, fromFile: string, ctx: ResolveContext): string | null {
  const config = pathConfig(posixDirname(fromFile), ctx);
  if (!config) return null;
  for (const entry of config.paths) {
    let middle: string;
    if (!entry.wildcard) {
      if (spec !== entry.prefix) continue;
      middle = "";
    } else {
      if (
        !spec.startsWith(entry.prefix) ||
        !spec.endsWith(entry.suffix) ||
        spec.length < entry.prefix.length + entry.suffix.length
      )
        continue;
      middle = spec.slice(entry.prefix.length, spec.length - entry.suffix.length);
    }
    for (const target of entry.targets) {
      const file = resolveModulePath(target.replace("*", middle), ctx);
      if (file) return file;
    }
  }
  if (config.baseUrl !== null) {
    const base = posixJoin(config.baseUrl, spec);
    const file = base === null ? null : resolveModulePath(base, ctx);
    if (file) return file;
  }
  return null;
}

/** The first file path in a package.json `imports` or `exports` value, whatever conditions it is under. */
function conditionTarget(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = conditionTarget(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object" || depth > 4) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["types", "import", "module", "default", "node", "require"]) {
    const found = key in record ? conditionTarget(record[key], depth + 1) : null;
    if (found) return found;
  }
  for (const nested of Object.values(record)) {
    const found = conditionTarget(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Look a subpath up in an `imports` or `exports` map, patterns with `*` included. */
function mapLookup(map: Record<string, unknown>, key: string): string | null {
  if (key in map) return conditionTarget(map[key]);
  let best: { prefix: string; target: string; middle: string } | null = null;
  for (const [pattern, value] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix) || key.length < prefix.length + suffix.length) continue;
    const target = conditionTarget(value);
    if (target && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, target, middle: key.slice(prefix.length, key.length - suffix.length) };
    }
  }
  return best ? best.target.replace("*", best.middle) : null;
}

/** A package's published files usually mirror its sources: `dist/a.js` was built from `src/a.ts`. */
function sourceCandidates(path: string): string[] {
  const out = [path];
  const stripped = path.replace(/\.d\.[cm]?ts$/, ".js");
  if (stripped !== path) out.push(stripped);
  for (const candidate of [...out]) {
    const swapped = candidate.replace(/(^|\/)(dist|build|lib|out|esm|cjs)\//, "$1src/");
    if (swapped !== candidate) out.push(swapped);
  }
  return out;
}

/** The nearest package.json at or above a directory, as [directory, contents]. */
function nearestPackage(dir: string, ctx: ResolveContext): [string, Record<string, unknown>] | null {
  return ctx.memo(`js.package:${dir}`, () => {
    for (let current: string | null = dir; current !== null; current = current === "" ? null : posixDirname(current)) {
      const path = current === "" ? "package.json" : `${current}/package.json`;
      if (!ctx.hasFile(path)) continue;
      const json = readJson(path, ctx);
      if (json) return [current, json] as [string, Record<string, unknown>];
    }
    return null;
  });
}

function resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const spec = imp.specifier;
  const names = imp.names;

  if (spec.startsWith(".")) {
    const base = posixJoin(posixDirname(fromFile), spec);
    const file = base === null ? null : resolveModulePath(base, ctx);
    return file ? [{ file, names }] : [{ names }];
  }
  if (spec.startsWith("/")) {
    const file = resolveModulePath(spec.slice(1), ctx);
    return file ? [{ file, names }] : [{ names }];
  }
  // `#internal/x`: the `imports` map of the importing file's package.json.
  if (spec.startsWith("#")) {
    const pkg = nearestPackage(posixDirname(fromFile), ctx);
    const map = pkg?.[1].imports;
    const target = map && typeof map === "object" ? mapLookup(map as Record<string, unknown>, spec) : null;
    if (pkg && target) {
      for (const candidate of sourceCandidates(target.replace(/^\.\//, ""))) {
        const base = posixJoin(pkg[0], candidate);
        const file = base === null ? null : resolveModulePath(base, ctx);
        if (file) return [{ file, names }];
      }
    }
    return [{ names }];
  }
  // Aliases set in tsconfig.json or jsconfig.json, before any guess.
  const aliased = resolveAlias(spec, fromFile, ctx);
  if (aliased) return [{ file: aliased, names }];
  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const rest = spec.slice(2);
    const file = resolveModulePath(`src/${rest}`, ctx) ?? resolveModulePath(rest, ctx);
    return file ? [{ file, names }] : [{ names }];
  }

  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  const segments = bare.split("/");
  const pkg = bare.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
  const subpath = segments.slice(bare.startsWith("@") ? 2 : 1).join("/");

  const pkgDir = ctx.packages.get(pkg);
  if (pkgDir !== undefined) {
    const prefix = pkgDir === "" ? "" : `${pkgDir}/`;
    // The package says what each subpath is in its `exports`; built files are traced back to their sources.
    const manifest = readJson(`${prefix}package.json`, ctx);
    const exportsField = manifest?.exports;
    if (exportsField !== undefined) {
      const key = subpath ? `./${subpath}` : ".";
      const target =
        typeof exportsField === "string" || Array.isArray(exportsField)
          ? key === "."
            ? conditionTarget(exportsField)
            : null
          : exportsField && typeof exportsField === "object"
            ? Object.keys(exportsField).some((k) => k.startsWith("."))
              ? mapLookup(exportsField as Record<string, unknown>, key)
              : key === "."
                ? conditionTarget(exportsField)
                : null
            : null;
      if (target) {
        for (const candidate of sourceCandidates(target.replace(/^\.\//, ""))) {
          const file = resolveModulePath(`${prefix}${candidate}`, ctx);
          if (file) return [{ file, names }];
        }
      }
    }
    const candidates = subpath
      ? [`${prefix}${subpath}`, `${prefix}src/${subpath}`]
      : [`${prefix}src/index`, `${prefix}index`, `${prefix}src/main`, `${prefix}lib/index`];
    for (const candidate of candidates) {
      const file = resolveModulePath(candidate, ctx);
      if (file) return [{ file, names }];
    }
  }

  if (spec.startsWith("node:") || NODE_BUILTINS.has(pkg)) {
    return [{ external: { id: `ext:node/${pkg}`, name: pkg, ecosystem: "node" }, names }];
  }
  return [{ external: { id: `ext:npm/${pkg}`, name: pkg, ecosystem: "npm" }, names }];
}

function makeSpec(flavor: Flavor): LanguageSpec {
  return {
    id: flavor,
    grammar: flavor,
    family: "js",
    query: COMMON_QUERY + (flavor === "javascript" ? JAVASCRIPT_QUERY : TYPESCRIPT_QUERY),
    scopeBreakers: SCOPE_BREAKERS,
    nestedDefs: true,
    selfNames: new Set(["this"]),
    importsAreExports: false,
    classify,
    outer,
    exported,
    signature,
    doc,
    isIdentUsage,
    parseImport,
    resolveImport,
    hintType,
    globals: JS_GLOBALS,
  };
}

export const javascript = makeSpec("javascript");
export const typescript = makeSpec("typescript");
export const tsx = makeSpec("tsx");
