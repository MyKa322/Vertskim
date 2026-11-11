import { builtinModules } from "node:module";
import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl, ImportName } from "../../types.js";
import { posixDirname, posixJoin, tidySignature, truncate } from "../../util.js";
import type { DefDecision, DocInfo, LanguageSpec, RawDef, ResolveContext, ResolvedImport, SymbolInfo } from "../spec.js";

type Flavor = "javascript" | "typescript" | "tsx";

/** Patterns shared by JavaScript and TypeScript. */
const COMMON_QUERY = `
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(method_definition name: (_) @name) @def.method
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
`;

const JAVASCRIPT_QUERY = `
(class_declaration name: (identifier) @name) @def.class
(field_definition property: (_) @name value: [(arrow_function) (function_expression)]) @def.method
(class_heritage (identifier) @name) @ref.extends
(class_heritage (member_expression object: (_) @qualifier property: (property_identifier) @name)) @ref.extends
`;

const TYPESCRIPT_QUERY = `
(class_declaration name: (type_identifier) @name) @def.class
(abstract_class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(type_alias_declaration name: (type_identifier) @name) @def.type
(enum_declaration name: (identifier) @name) @def.enum
(public_field_definition name: (_) @name value: [(arrow_function) (function_expression)]) @def.method
(abstract_method_signature name: (_) @name) @def.method
(method_signature name: (_) @name) @def.method

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

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  const nameType = def.nameNode.type;
  if (nameType === "computed_property_name") return null;
  const name = nameType === "string" ? (stringValue(def.nameNode) ?? def.name) : def.name;
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
    case "method":
      return parent && (parent.kind === "class" || parent.kind === "interface") ? { kind: "method", name } : null;
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
    if (!parent.exported) return 0;
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
  const text = tidySignature(source.slice(start, end)).replace(/[{;,]$/, "").trim();
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
      if (!child || child.type !== "import_clause") continue;
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
  };
}

export const javascript = makeSpec("javascript");
export const typescript = makeSpec("typescript");
export const tsx = makeSpec("tsx");
