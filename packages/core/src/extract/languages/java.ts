import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl } from "../../types.js";
import { posixBasename, posixDirname } from "../../util.js";
import type { DefDecision, DocInfo, LanguageSpec, RawDef, ResolveContext, ResolvedImport, SymbolInfo } from "../spec.js";
import { commentAbove, fieldIs, signatureBeforeBody } from "./common.js";

const QUERY = `
(class_declaration name: (identifier) @name) @def.class
(record_declaration name: (identifier) @name) @def.record
(interface_declaration name: (identifier) @name) @def.interface
(annotation_type_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.constructor
(field_declaration
  (modifiers) @_mods
  declarator: (variable_declarator name: (identifier) @name)
  (#match? @_mods "static")
  (#match? @_mods "final")) @def.variable

(method_invocation !object name: (identifier) @name) @ref.call
(method_invocation object: (_) @qualifier name: (identifier) @name) @ref.call
(object_creation_expression type: (type_identifier) @name) @ref.new
(object_creation_expression type: (generic_type (type_identifier) @name)) @ref.new
(superclass (type_identifier) @name) @ref.extends
(superclass (generic_type (type_identifier) @name)) @ref.extends
(super_interfaces (type_list (type_identifier) @name)) @ref.implements
(super_interfaces (type_list (generic_type (type_identifier) @name))) @ref.implements
(extends_interfaces (type_list (type_identifier) @name)) @ref.extends
(extends_interfaces (type_list (generic_type (type_identifier) @name))) @ref.extends

(type_parameter (type_identifier) @typeparam)
(type_identifier) @ref.type
(identifier) @ref.ident

(import_declaration) @import

(formal_parameter type: (type_identifier) @vartype name: (identifier) @var)
(formal_parameter type: (generic_type (type_identifier) @vartype) name: (identifier) @var)
(local_variable_declaration type: (type_identifier) @vartype declarator: (variable_declarator name: (identifier) @var))
(local_variable_declaration type: (generic_type (type_identifier) @vartype) declarator: (variable_declarator name: (identifier) @var))
(local_variable_declaration
  declarator: (variable_declarator name: (identifier) @var value: (object_creation_expression type: (type_identifier) @vartype)))
(field_declaration type: (type_identifier) @vartype declarator: (variable_declarator name: (identifier) @var))
(field_declaration type: (generic_type (type_identifier) @vartype) declarator: (variable_declarator name: (identifier) @var))
(enhanced_for_statement type: (type_identifier) @vartype name: (identifier) @var)
`;

const BUILTINS = new Set([
  "String", "Object", "Integer", "Long", "Double", "Float", "Boolean", "Character", "Byte", "Short", "Void", "var",
]);

const TYPE_PARENTS = new Set(["class", "interface", "type"]);

function modifiers(node: Node): string {
  for (const child of node.namedChildren) if (child?.type === "modifiers") return child.text;
  return "";
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  if (parent && !TYPE_PARENTS.has(parent.kind)) return null;
  switch (def.kind) {
    case "class":
      return { kind: "class" };
    case "record":
      return { kind: "class", subkind: "record" };
    case "interface":
      return { kind: "interface" };
    case "enum":
      return { kind: "type", subkind: "enum" };
    case "method":
      return parent ? { kind: "method" } : null;
    case "constructor":
      return parent ? { kind: "method", subkind: "constructor" } : null;
    case "variable":
      return parent ? { kind: "variable", subkind: "const" } : null;
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  return def.node;
}

/** Anything not private can be used from another file of the package, which is what counts here. */
function exported(def: RawDef, _outer: Node, parent: SymbolInfo | null): Exported {
  if (parent && !parent.exported) return 0;
  return /\bprivate\b/.test(modifiers(def.node)) ? 0 : 1;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  const text = signatureBeforeBody(def, source);
  // Annotations sit in front of the modifiers and say little about the shape.
  return text ? text.replace(/^(@[\w.]+(\([^)]*\))?\s*)+/, "") || null : null;
}

function doc(_def: RawDef, outerNode: Node): DocInfo {
  return commentAbove(outerNode);
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "class_declaration":
    case "record_declaration":
    case "interface_declaration":
    case "annotation_type_declaration":
    case "enum_declaration":
    case "method_declaration":
    case "constructor_declaration":
    case "variable_declarator":
    case "formal_parameter":
    case "spread_parameter":
    case "catch_formal_parameter":
    case "enhanced_for_statement":
    case "enum_constant":
    case "method_invocation":
      return !fieldIs(parent, "name", node);
    case "field_access":
      return fieldIs(parent, "object", node);
    case "scoped_identifier":
    case "marker_annotation":
    case "annotation":
    case "element_value_pair":
    case "inferred_parameters":
    case "lambda_expression":
    case "labeled_statement":
    case "break_statement":
    case "continue_statement":
    case "package_declaration":
      return false;
    default:
      return true;
  }
}

function parseImport(node: Node): ImportDecl[] {
  const match = /^import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/.exec(node.text.replace(/\s+/g, " "));
  if (!match) return [];
  const line = node.startPosition.row + 1;
  const path = match[2]!;
  const last = path.slice(path.lastIndexOf(".") + 1);
  if (match[3]) {
    // `import a.b.*` brings a package in; `import static a.b.C.*` is treated as importing C.
    if (!match[1]) return [{ specifier: path, line, names: [{ local: "*", imported: "*" }], reexport: false }];
    return [{ specifier: path, line, names: [{ local: last, imported: last }], reexport: false }];
  }
  if (match[1]) {
    // `import static a.b.C.member`
    const owner = path.slice(0, path.lastIndexOf("."));
    const ownerName = owner.slice(owner.lastIndexOf(".") + 1);
    return [{ specifier: owner, line, names: [{ local: last, imported: `${ownerName}.${last}` }], reexport: false }];
  }
  return [{ specifier: path, line, names: [{ local: last, imported: last }], reexport: false }];
}

function javaFiles(pkg: string, ctx: ResolveContext): string[] {
  return ctx.filesInPackage(pkg).filter((f) => f.endsWith(".java"));
}

function external(path: string, names: ImportDecl["names"]): ResolvedImport[] {
  const name = path.split(".").slice(0, 2).join(".");
  return [{ external: { id: `ext:jvm/${name}`, name, ecosystem: "jvm" }, names }];
}

function resolveImport(imp: ImportDecl, _fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const path = imp.specifier;
  if (imp.names.some((n) => n.local === "*")) {
    const files = javaFiles(path, ctx);
    return files.length > 0 ? [{ files, dir: posixDirname(files[0]!), names: imp.names }] : external(path, imp.names);
  }
  // `a.b.Outer.Inner`: walk back until the remaining prefix is a package this project declares.
  const segments = path.split(".");
  for (let cut = segments.length - 1; cut >= 1; cut--) {
    const files = javaFiles(segments.slice(0, cut).join("."), ctx);
    if (files.length === 0) continue;
    const cls = segments[cut]!;
    const inner = segments.slice(cut).join(".");
    const names =
      cut === segments.length - 1
        ? imp.names
        : imp.names.map((n) => ({ ...n, imported: n.imported.includes(".") ? `${segments.slice(cut, -1).join(".")}.${n.imported.split(".").pop()}` : inner }));
    const file = files.find((f) => posixBasename(f) === `${cls}.java`);
    return file ? [{ file, names }] : [{ files, names }];
  }
  return external(path, imp.names);
}

function packageOf(root: Node): string | null {
  for (const child of root.namedChildren) {
    if (child?.type === "package_declaration") {
      const name = child.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier");
      return name ? name.text.replace(/\s+/g, "") : null;
    }
  }
  return null;
}

/** The rest of the package, wherever its files live (main and test trees alike). */
function ambient(fromFile: string, ctx: ResolveContext): string[] {
  const pkg = ctx.packageOf(fromFile);
  const files = pkg ? javaFiles(pkg, ctx) : ctx.filesIn(posixDirname(fromFile)).filter((f) => f.endsWith(".java") && !ctx.packageOf(f));
  return files.filter((f) => f !== fromFile);
}

export const java: LanguageSpec = {
  id: "java",
  grammar: "java",
  family: "jvm",
  query: QUERY,
  scopeBreakers: new Set(["block", "constructor_body", "object_creation_expression", "lambda_expression"]),
  selfNames: new Set(["this"]),
  importsAreExports: false,
  implicitSelf: true,
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
