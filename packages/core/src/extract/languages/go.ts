import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl } from "../../types.js";
import { posixDirname, posixJoin, truncate } from "../../util.js";
import type {
  DefDecision,
  DocInfo,
  LanguageSpec,
  RawDef,
  ResolveContext,
  ResolvedImport,
  SymbolInfo,
} from "../spec.js";
import { commentAbove, fieldIs, signatureBeforeBody, unquote } from "./common.js";

const QUERY = `
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(method_elem name: (field_identifier) @name) @def.method
(type_spec name: (type_identifier) @name) @def.type
(type_alias name: (type_identifier) @name) @def.type
(const_spec name: (identifier) @name) @def.variable
(var_spec name: (identifier) @name) @def.variable

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (selector_expression operand: (_) @qualifier field: (field_identifier) @name)) @ref.call
(composite_literal type: (type_identifier) @name) @ref.new
(composite_literal type: (qualified_type package: (package_identifier) @qualifier name: (type_identifier) @name)) @ref.new
(field_declaration !name type: (type_identifier) @name) @ref.extends
(field_declaration !name type: (pointer_type (type_identifier) @name)) @ref.extends
(interface_type (type_elem . (type_identifier) @name .)) @ref.extends
(interface_type (type_elem . (qualified_type package: (package_identifier) @qualifier name: (type_identifier) @name) .)) @ref.extends
(qualified_type package: (package_identifier) @qualifier name: (type_identifier) @name) @ref.type

(type_identifier) @ref.type
(identifier) @ref.ident

(import_spec) @import

(parameter_declaration name: (identifier) @var type: (type_identifier) @vartype)
(parameter_declaration name: (identifier) @var type: (pointer_type (type_identifier) @vartype))
(parameter_declaration name: (identifier) @var type: (qualified_type) @vartype)
(parameter_declaration name: (identifier) @var type: (pointer_type (qualified_type) @vartype))
(var_spec name: (identifier) @var type: (type_identifier) @vartype)
(var_spec name: (identifier) @var type: (pointer_type (type_identifier) @vartype))
(var_spec name: (identifier) @var type: (qualified_type) @vartype)
(var_spec name: (identifier) @var type: (pointer_type (qualified_type) @vartype))
(short_var_declaration
  left: (expression_list . (identifier) @var)
  right: (expression_list . (call_expression function: (_) @varcall) .))
(field_declaration name: (field_identifier) @var type: (type_identifier) @vartype)
(field_declaration name: (field_identifier) @var type: (pointer_type (type_identifier) @vartype))
(field_declaration name: (field_identifier) @var type: (qualified_type) @vartype)
(field_declaration name: (field_identifier) @var type: (pointer_type (qualified_type) @vartype))
(short_var_declaration
  left: (expression_list . (identifier) @var .)
  right: (expression_list . (composite_literal type: [(type_identifier) (qualified_type)] @vartype) .))
(short_var_declaration
  left: (expression_list . (identifier) @var .)
  right: (expression_list . (unary_expression operand: (composite_literal type: [(type_identifier) (qualified_type)] @vartype)) .))
`;

// biome-ignore format: a list of words reads better packed
const BUILTINS = new Set([
  "string", "bool", "byte", "rune", "error", "any", "int", "int8", "int16", "int32", "int64", "uint", "uint8",
  "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128", "nil", "true", "false",
  "iota",
]);

/** `Cart`, `*Cart` or `Cart[T]` -> `Cart`. */
function typeName(node: Node | null): string | null {
  for (let n = node; n; ) {
    if (n.type === "type_identifier") return n.text;
    if (n.type === "pointer_type" || n.type === "parenthesized_type") n = n.namedChild(0);
    else if (n.type === "generic_type") n = n.childForFieldName("type");
    else return null;
  }
  return null;
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  const node = def.node;
  switch (def.kind) {
    case "function":
      return parent ? null : { kind: "function" };
    case "method": {
      if (node.type === "method_elem") return parent?.kind === "interface" ? { kind: "method" } : null;
      if (parent) return null;
      const receiver = node.childForFieldName("receiver")?.namedChild(0);
      const owner = typeName(receiver?.childForFieldName("type") ?? null);
      if (!owner) return null;
      const selfName = receiver?.childForFieldName("name")?.text;
      return { kind: "method", owner, ...(selfName && selfName !== "_" ? { selfName } : {}) };
    }
    case "type": {
      if (parent) return null;
      const body = node.childForFieldName("type");
      if (body?.type === "struct_type") return { kind: "class", subkind: "struct" };
      if (body?.type === "interface_type") return { kind: "interface" };
      return { kind: "type" };
    }
    case "variable":
      if (parent || def.name === "_") return null;
      return { kind: "variable", ...(node.type === "const_spec" ? { subkind: "const" } : {}) };
    default:
      return null;
  }
}

/** A lone spec stands for its whole `type`/`const`/`var` statement, so the comment above it is found. */
function outer(def: RawDef): Node {
  const parent = def.node.parent;
  if (
    parent &&
    (parent.type === "type_declaration" || parent.type === "const_declaration" || parent.type === "var_declaration") &&
    parent.namedChildCount === 1
  ) {
    return parent;
  }
  return def.node;
}

function exported(def: RawDef): Exported {
  return /^\p{Lu}/u.test(def.name) ? 1 : 0;
}

function signature(def: RawDef, _outerNode: Node, source: string): string | null {
  const node = def.node;
  if (node.type === "type_spec" || node.type === "type_alias") {
    const body = node.childForFieldName("type");
    if (body?.type === "struct_type") return `type ${def.name} struct`;
    if (body?.type === "interface_type") return `type ${def.name} interface`;
    return truncate(`type ${node.text.replace(/\s+/g, " ")}`, 160);
  }
  if (node.type === "const_spec" || node.type === "var_spec") {
    const keyword = node.type === "const_spec" ? "const" : "var";
    return truncate(`${keyword} ${node.text.replace(/\s+/g, " ")}`, 160);
  }
  const text = signatureBeforeBody(def, source);
  return node.type === "method_elem" || !text ? text : text.startsWith("func") ? text : `func ${text}`;
}

function doc(_def: RawDef, outerNode: Node): DocInfo {
  return commentAbove(outerNode);
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "parameter_declaration":
    case "variadic_parameter_declaration":
    case "var_spec":
    case "const_spec":
    case "function_declaration":
      return !fieldIs(parent, "name", node);
    case "expression_list": {
      const statement = parent.parent;
      if (
        statement &&
        (statement.type === "short_var_declaration" ||
          statement.type === "range_clause" ||
          statement.type === "receive_statement") &&
        fieldIs(statement, "left", parent)
      ) {
        return false;
      }
      return true;
    }
    case "literal_element": {
      const element = parent.parent;
      return !(element?.type === "keyed_element" && fieldIs(element, "key", parent));
    }
    case "selector_expression":
      return fieldIs(parent, "operand", node);
    case "labeled_statement":
    case "import_spec":
    case "package_clause":
      return false;
    default:
      return true;
  }
}

function parseImport(node: Node): ImportDecl[] {
  const path = node.childForFieldName("path");
  if (!path) return [];
  const specifier = unquote(path.text);
  const alias = node.childForFieldName("name");
  const line = node.startPosition.row + 1;
  if (alias?.type === "blank_identifier") return [{ specifier, line, names: [], reexport: false }];
  if (alias?.type === "dot") return [{ specifier, line, names: [{ local: "*", imported: "*" }], reexport: false }];
  // An empty local name means "whatever the package calls itself", settled when the import is resolved.
  return [{ specifier, line, names: [{ local: alias?.text ?? "", imported: "*" }], reexport: false }];
}

interface GoModule {
  name: string;
  dir: string;
}

function modules(ctx: ResolveContext): GoModule[] {
  return ctx.memo("go.modules", () => {
    const out: GoModule[] = [];
    for (const file of ctx.filesNamed("go.mod")) {
      const name = /^\s*module\s+(\S+)/m.exec(ctx.read(file) ?? "")?.[1];
      if (name) out.push({ name: unquote(name), dir: posixDirname(file) });
    }
    return out.sort((a, b) => b.name.length - a.name.length);
  });
}

function packageFiles(dir: string, ctx: ResolveContext): string[] {
  return ctx.filesIn(dir).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
}

/** The name a package import binds when the statement gives none. */
function defaultName(specifier: string, files: string[], ctx: ResolveContext): string {
  const declared = files[0] ? ctx.packageOf(files[0]) : null;
  if (declared) return declared;
  const segments = specifier.split("/");
  let last = segments[segments.length - 1] ?? specifier;
  if (/^v\d+$/.test(last) && segments.length > 1) last = segments[segments.length - 2]!;
  return last;
}

function resolveImport(imp: ImportDecl, _fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const spec = imp.specifier;
  let files: string[] = [];
  let dir: string | null = null;
  for (const module of modules(ctx)) {
    if (spec !== module.name && !spec.startsWith(`${module.name}/`)) continue;
    dir = posixJoin(module.dir, spec.slice(module.name.length + 1));
    if (dir !== null) files = packageFiles(dir, ctx);
    break;
  }
  const names = imp.names.map((n) => (n.local === "" ? { ...n, local: defaultName(spec, files, ctx) } : n));
  if (dir !== null && files.length > 0) return [{ files, dir, names }];

  // The standard library has no host name in its first segment; everything else is a module path.
  const segments = spec.split("/");
  const thirdParty = segments[0]!.includes(".");
  const name = thirdParty ? segments.slice(0, 3).join("/") : spec;
  return [{ external: { id: `ext:go/${name}`, name, ecosystem: "go" }, names }];
}

function packageOf(root: Node): string | null {
  for (const child of root.namedChildren) {
    if (child?.type === "package_clause") return child.namedChild(0)?.text ?? null;
  }
  return null;
}

/** The other files of the same package: same directory, same package clause. */
function ambient(fromFile: string, ctx: ResolveContext): string[] {
  const own = ctx.packageOf(fromFile);
  return ctx
    .filesIn(posixDirname(fromFile))
    .filter((f) => f !== fromFile && f.endsWith(".go") && ctx.packageOf(f) === own);
}

export const go: LanguageSpec = {
  id: "go",
  grammar: "go",
  family: "go",
  query: QUERY,
  scopeBreakers: new Set(["block", "func_literal"]),
  selfNames: new Set<string>(),
  importsAreExports: false,
  ignoredNames: BUILTINS,
  classify,
  outer,
  exported,
  signature,
  doc,
  isIdentUsage,
  keepIdent: (name) => /^\p{Lu}/u.test(name),
  parseImport,
  resolveImport,
  packageOf,
  ambient,
};
