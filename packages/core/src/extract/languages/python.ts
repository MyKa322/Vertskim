import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl, ImportName } from "../../types.js";
import { posixDirname, posixJoin, tidySignature, truncate } from "../../util.js";
import {
  MIN_NESTED_LINES,
  type DefDecision,
  type DocInfo,
  type LanguageSpec,
  type RawDef,
  type ResolveContext,
  type ResolvedImport,
  type SymbolInfo,
} from "../spec.js";

const QUERY = `
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
(module (expression_statement (assignment left: (identifier) @name) @def.variable))

(call function: (identifier) @name) @ref.call
(call function: (attribute object: (_) @qualifier attribute: (identifier) @name)) @ref.call
(class_definition superclasses: (argument_list (identifier) @name)) @ref.extends
(class_definition superclasses: (argument_list (attribute object: (_) @qualifier attribute: (identifier) @name))) @ref.extends

(identifier) @ref.ident

(import_statement) @import
(import_from_statement) @import

(typed_parameter (identifier) @var type: (type (identifier) @vartype))
(typed_default_parameter name: (identifier) @var type: (type (identifier) @vartype))
(typed_parameter (identifier) @var type: (type (generic_type (identifier) @vartype)) (#not-eq? @vartype "Optional"))
(typed_default_parameter name: (identifier) @var type: (type (generic_type (identifier) @vartype)) (#not-eq? @vartype "Optional"))
(typed_parameter (identifier) @var
  type: (type (generic_type (identifier) @_optional (type_parameter (type (identifier) @vartype))))
  (#eq? @_optional "Optional"))
(typed_default_parameter name: (identifier) @var
  type: (type (generic_type (identifier) @_optional (type_parameter (type (identifier) @vartype))))
  (#eq? @_optional "Optional"))
(assignment left: (identifier) @var type: (type (identifier) @vartype))
(assignment left: (attribute object: (identifier) @_self attribute: (identifier) @fieldvar) type: (type (identifier) @vartype)
  (#eq? @_self "self"))
(assignment left: (identifier) @var right: (call function: [(identifier) (attribute)] @varcall))
(assignment left: (attribute object: (identifier) @_self attribute: (identifier) @fieldvar) right: [(identifier) (attribute)] @varvalue
  (#eq? @_self "self"))
(assignment left: (attribute object: (identifier) @_self attribute: (identifier) @fieldvar) right: (call function: [(identifier) (attribute)] @varcall)
  (#eq? @_self "self"))
`;

function fieldIs(parent: Node, field: string, node: Node): boolean {
  return parent.childForFieldName(field)?.id === node.id;
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  switch (def.kind) {
    case "function": {
      if (!parent) return { kind: "function" };
      if (parent.kind === "class") return { kind: "method" };
      // A function defined inside another (a decorator's wrapper, a callback), when it is more than a line or two.
      const lines = def.node.endPosition.row - def.node.startPosition.row + 1;
      return (parent.kind === "function" || parent.kind === "method") && lines >= MIN_NESTED_LINES
        ? { kind: "function" }
        : null;
    }
    case "class":
      return !parent || parent.kind === "class" ? { kind: "class" } : null;
    case "variable":
      return parent ? null : { kind: "variable" };
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  const parent = def.node.parent;
  if (parent && (parent.type === "decorated_definition" || parent.type === "expression_statement")) return parent;
  return def.node;
}

function exported(def: RawDef, _outer: Node, parent: SymbolInfo | null): Exported {
  if (def.name.startsWith("_")) return 0;
  if (parent && !parent.exported) return 0;
  return 1;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  const node = def.node;
  const start = node.startIndex;
  let end = node.endIndex;
  const body = node.childForFieldName("body");
  if (body && body.startIndex > start) end = body.startIndex;
  const text = tidySignature(source.slice(start, end)).replace(/:$/, "").trim();
  return text ? truncate(text, body ? 240 : 160) : null;
}

function doc(def: RawDef, _outer: Node, _source: string): DocInfo {
  const body = def.node.childForFieldName("body");
  const first = body?.namedChild(0);
  if (first?.type !== "expression_statement") return { text: null };
  const str = first.namedChild(0);
  if (str?.type !== "string") return { text: null };
  const content = str.namedChildren.find((c) => c?.type === "string_content");
  const raw = content ? content.text : str.text.replace(/^[a-zA-Z]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
  const lines: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      if (lines.length > 0) break;
      continue;
    }
    lines.push(line);
  }
  const text = lines.join(" ");
  return { text: text ? truncate(text, 200) : null };
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "attribute":
      return fieldIs(parent, "object", node);
    case "keyword_argument":
    case "default_parameter":
    case "typed_default_parameter":
    case "function_definition":
    case "class_definition":
      return !fieldIs(parent, "name", node);
    case "typed_parameter":
      return parent.namedChild(0)?.id !== node.id;
    case "assignment":
    case "for_statement":
    case "for_in_clause":
      return !fieldIs(parent, "left", node);
    case "parameters":
    case "lambda_parameters":
    case "list_splat_pattern":
    case "dictionary_splat_pattern":
    case "pattern_list":
    case "tuple_pattern":
    case "as_pattern_target":
    case "global_statement":
    case "nonlocal_statement":
    case "dotted_name":
    case "aliased_import":
      return false;
    default:
      return true;
  }
}

function parseImport(node: Node): ImportDecl[] {
  const line = node.startPosition.row + 1;
  const out: ImportDecl[] = [];

  if (node.type === "import_statement") {
    // import a.b.c            -> binds `a.b.c` to the module
    // import a.b.c as m       -> binds `m`
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === "dotted_name") {
        out.push({ specifier: child.text, line, names: [{ local: child.text, imported: "*" }], reexport: false });
      } else if (child.type === "aliased_import") {
        const name = child.childForFieldName("name");
        const alias = child.childForFieldName("alias");
        if (name && alias) {
          out.push({ specifier: name.text, line, names: [{ local: alias.text, imported: "*" }], reexport: false });
        }
      }
    }
    return out;
  }

  // from x import a, b as c, *
  const moduleNode = node.childForFieldName("module_name");
  if (!moduleNode) return out;
  const specifier = moduleNode.text;
  const names: ImportName[] = [];
  for (const child of node.namedChildren) {
    if (!child || child.id === moduleNode.id) continue;
    if (child.type === "dotted_name") names.push({ local: child.text, imported: child.text });
    else if (child.type === "aliased_import") {
      const name = child.childForFieldName("name");
      const alias = child.childForFieldName("alias");
      if (name && alias) names.push({ local: alias.text, imported: name.text });
    } else if (child.type === "wildcard_import") names.push({ local: "*", imported: "*" });
  }
  out.push({ specifier, line, names, reexport: false });
  return out;
}

function moduleFile(base: string | null, ctx: ResolveContext): string | null {
  if (base === null) return null;
  for (const candidate of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`, `${base}/__init__.pyi`]) {
    if (ctx.hasFile(candidate)) return candidate;
  }
  return null;
}

/** Resolve a dotted module name (possibly relative) to a project file. */
function resolveModule(specifier: string, fromFile: string, ctx: ResolveContext): string | null {
  const dots = /^\.*/.exec(specifier)![0].length;
  const rest = specifier.slice(dots);
  const parts = rest === "" ? [] : rest.split(".");

  if (dots > 0) {
    let dir: string | null = posixDirname(fromFile);
    for (let i = 1; i < dots && dir !== null; i++) dir = posixJoin(dir, "..");
    if (dir === null) return null;
    if (parts.length === 0) {
      const init = posixJoin(dir, "__init__.py");
      return init !== null && ctx.hasFile(init) ? init : null;
    }
    return moduleFile(posixJoin(dir, ...parts), ctx);
  }

  // Absolute: try every ancestor of the importing file, then common source roots.
  const roots: string[] = [];
  for (let dir: string | null = posixDirname(fromFile); dir !== null; ) {
    roots.push(dir);
    if (dir === "") break;
    dir = posixDirname(dir);
  }
  for (const extra of ["", "src", "lib"]) if (!roots.includes(extra)) roots.push(extra);
  for (const root of roots) {
    const file = moduleFile(posixJoin(root, ...parts), ctx);
    if (file) return file;
  }
  return null;
}

function resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const out: ResolvedImport[] = [];
  const moduleTarget = resolveModule(imp.specifier, fromFile, ctx);
  const isFromImport = imp.names.some((n) => n.imported !== "*") || imp.names.some((n) => n.local === "*");

  if (!isFromImport) {
    if (moduleTarget) return [{ file: moduleTarget, names: imp.names }];
    if (imp.specifier.startsWith(".")) return [{ names: imp.names }];
    const top = imp.specifier.split(".")[0]!;
    return [{ external: { id: `ext:py/${top}`, name: top, ecosystem: "py" }, names: imp.names }];
  }

  // `from pkg import name`: each name is either a submodule of pkg or a symbol inside it.
  const symbolNames: ImportName[] = [];
  for (const name of imp.names) {
    if (name.imported === "*") {
      symbolNames.push(name);
      continue;
    }
    const joiner = imp.specifier.endsWith(".") ? "" : ".";
    const submodule = resolveModule(`${imp.specifier}${joiner}${name.imported}`, fromFile, ctx);
    if (submodule) out.push({ file: submodule, names: [{ local: name.local, imported: "*" }] });
    else symbolNames.push(name);
  }
  if (moduleTarget) {
    out.push({ file: moduleTarget, names: symbolNames });
  } else if (symbolNames.length > 0 || out.length === 0) {
    if (imp.specifier.startsWith(".")) out.push({ names: symbolNames });
    else {
      const top = imp.specifier.split(".")[0]!;
      out.push({ external: { id: `ext:py/${top}`, name: top, ecosystem: "py" }, names: symbolNames });
    }
  }
  return out;
}

export const python: LanguageSpec = {
  id: "python",
  grammar: "python",
  family: "py",
  query: QUERY,
  scopeBreakers: new Set<string>(),
  selfNames: new Set(["self", "cls"]),
  importsAreExports: true,
  classify,
  outer,
  exported,
  signature,
  doc,
  isIdentUsage,
  parseImport,
  resolveImport,
};
