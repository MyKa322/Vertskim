import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl } from "../../types.js";
import { posixBasename } from "../../util.js";
import type {
  DefDecision,
  DocInfo,
  LanguageSpec,
  RawDef,
  ResolveContext,
  ResolvedImport,
  SymbolInfo,
} from "../spec.js";
import { commentAbove, fieldIs, signatureBeforeBody } from "./common.js";

const QUERY = `
(class_declaration name: (name) @name) @def.class
(interface_declaration name: (name) @name) @def.interface
(trait_declaration name: (name) @name) @def.trait
(enum_declaration name: (name) @name) @def.enum
(function_definition name: (name) @name) @def.function
(method_declaration name: (name) @name) @def.method
(const_declaration (const_element (name) @name)) @def.constant

(function_call_expression function: (name) @name) @ref.call
(function_call_expression function: (qualified_name (name) @name)) @ref.call
(member_call_expression object: (_) @qualifier name: (name) @name) @ref.call
(nullsafe_member_call_expression object: (_) @qualifier name: (name) @name) @ref.call
(scoped_call_expression scope: (name) @qualifier name: (name) @name) @ref.call
(scoped_call_expression scope: (qualified_name (name) @qualifier) name: (name) @name) @ref.call
(scoped_call_expression scope: (relative_scope) @qualifier name: (name) @name) @ref.call
(object_creation_expression (name) @name) @ref.new
(object_creation_expression (qualified_name (name) @name)) @ref.new
(base_clause (name) @name) @ref.extends
(base_clause (qualified_name (name) @name)) @ref.extends
(class_interface_clause (name) @name) @ref.implements
(class_interface_clause (qualified_name (name) @name)) @ref.implements
(use_declaration (name) @name) @ref.extends
(use_declaration (qualified_name (name) @name)) @ref.extends

(named_type (name) @ref.type)
(named_type (qualified_name (name) @ref.type))
(name) @ref.ident

(namespace_use_declaration) @import

(simple_parameter type: (named_type (name) @vartype) name: (variable_name) @var)
(simple_parameter type: (optional_type (named_type (name) @vartype)) name: (variable_name) @var)
(property_declaration type: (named_type (name) @vartype) (property_element name: (variable_name (name) @fieldvar)))
(property_declaration type: (optional_type (named_type (name) @vartype)) (property_element name: (variable_name (name) @fieldvar)))
(property_promotion_parameter type: (named_type (name) @vartype) name: (variable_name (name) @fieldvar))
(property_promotion_parameter type: (optional_type (named_type (name) @vartype)) name: (variable_name (name) @fieldvar))
(assignment_expression left: (variable_name) @var right: (object_creation_expression (name) @newtype))
(assignment_expression
  left: (member_access_expression object: (variable_name) @_this name: (name) @fieldvar)
  right: (object_creation_expression (name) @newtype)
  (#eq? @_this "$this"))
`;

// biome-ignore format: a list of words reads better packed
const BUILTINS = new Set([
  "self", "static", "parent", "array", "string", "int", "bool", "float", "mixed", "void", "null", "callable",
  "iterable", "object", "never", "false", "true", "Exception", "Throwable", "Error", "TypeError", "DateTime",
  "DateTimeImmutable", "DateTimeInterface", "Closure", "Generator", "stdClass", "ArrayObject", "ArrayAccess",
  "Countable", "Traversable", "Iterator", "IteratorAggregate", "JsonSerializable", "Stringable",
  "InvalidArgumentException", "RuntimeException", "LogicException",
]);

const TYPE_PARENTS = new Set(["class", "interface", "type"]);

function modifierTexts(node: Node): string[] {
  const out: string[] = [];
  for (const child of node.namedChildren) {
    if (child && /_modifier$/.test(child.type)) out.push(child.text);
  }
  return out;
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  if (parent && !TYPE_PARENTS.has(parent.kind)) return null;
  switch (def.kind) {
    case "class":
      return { kind: "class" };
    case "interface":
      return { kind: "interface" };
    case "trait":
      return { kind: "class", subkind: "trait" };
    case "enum":
      return { kind: "type", subkind: "enum" };
    case "function":
      return parent ? null : { kind: "function" };
    case "method": {
      if (!parent) return null;
      if (def.name === "__construct") return { kind: "method", subkind: "constructor" };
      return modifierTexts(def.node).includes("static") ? { kind: "method", subkind: "static" } : { kind: "method" };
    }
    case "constant":
      return { kind: "variable", subkind: "const" };
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  return def.node;
}

function exported(def: RawDef, _outer: Node, parent: SymbolInfo | null): Exported {
  if (parent && !parent.exported) return 0;
  const modifiers = modifierTexts(def.kind === "constant" ? (def.node ?? def.node) : def.node);
  return modifiers.includes("private") || modifiers.includes("protected") ? 0 : 1;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  return signatureBeforeBody(def, source);
}

function doc(_def: RawDef, outerNode: Node): DocInfo {
  return commentAbove(outerNode, new Set(["attribute_list"]));
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "class_declaration":
    case "interface_declaration":
    case "trait_declaration":
    case "enum_declaration":
    case "function_definition":
    case "method_declaration":
      return !fieldIs(parent, "name", node);
    case "namespace_name":
    case "qualified_name":
    case "namespace_definition":
    case "namespace_use_clause":
    case "variable_name":
    case "member_access_expression":
    case "nullsafe_member_access_expression":
    case "const_element":
    case "named_type":
    case "attribute":
    case "enum_case":
    case "named_label_statement":
    case "goto_statement":
      return false;
    default:
      return true;
  }
}

/** `use A\B\C;`, `use A\B\{C, D as E};`, `use function A\b;`: one declaration per name. */
function parseImport(node: Node): ImportDecl[] {
  const line = node.startPosition.row + 1;
  const group = node.namedChildren.find((c) => c?.type === "namespace_use_group");
  const prefix = group ? node.namedChildren.find((c) => c?.type === "namespace_name")?.text : null;
  const out: ImportDecl[] = [];
  for (const clause of (group ?? node).namedChildren) {
    if (clause?.type !== "namespace_use_clause" && clause?.type !== "namespace_use_group_clause") continue;
    const target = clause.namedChildren.find(
      (c) => c?.type === "qualified_name" || c?.type === "name" || c?.type === "namespace_name",
    );
    if (!target) continue;
    const full = (prefix ? `${prefix}\\${target.text}` : target.text).replace(/^\\/, "").replace(/\s+/g, "");
    const last = full.slice(full.lastIndexOf("\\") + 1);
    const alias = clause.childForFieldName("alias")?.text;
    out.push({ specifier: full, line, names: [{ local: alias ?? last, imported: last }], reexport: false });
  }
  return out;
}

function phpFiles(namespace: string, ctx: ResolveContext): string[] {
  return ctx.filesInPackage(namespace).filter((f) => f.endsWith(".php"));
}

function resolveImport(imp: ImportDecl, _fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const cut = imp.specifier.lastIndexOf("\\");
  const namespace = cut > 0 ? imp.specifier.slice(0, cut) : "";
  const name = imp.specifier.slice(cut + 1);
  // A class lives in a file named after it, in a file declaring its namespace (PSR-4 and nearly everything else).
  const files = namespace ? phpFiles(namespace, ctx) : [];
  const file = files.find((f) => posixBasename(f) === `${name}.php`);
  if (file) return [{ file, names: imp.names }];
  if (files.length > 0) return [{ files, names: imp.names }];
  // `use Acme\Shop;` names a namespace: its classes are then reached as `Shop\Cart`.
  const inside = phpFiles(imp.specifier, ctx);
  if (inside.length > 0) return [{ files: inside, names: imp.names.map((n) => ({ ...n, imported: "*" })) }];
  // `use RuntimeException;`, `use function sprintf;`: the global namespace, which is PHP's own.
  if (!imp.specifier.includes("\\")) {
    return [{ external: { id: "ext:php/php", name: "php", ecosystem: "php" }, names: imp.names }];
  }
  const vendor = imp.specifier.split("\\")[0]!.toLowerCase();
  return [{ external: { id: `ext:composer/${vendor}`, name: vendor, ecosystem: "composer" }, names: imp.names }];
}

function packageOf(root: Node): string | null {
  for (const child of root.namedChildren) {
    if (child?.type !== "namespace_definition") continue;
    return child.childForFieldName("name")?.text.replace(/\s+/g, "") ?? null;
  }
  return null;
}

/** The rest of the namespace is in scope without a `use`. */
function ambient(fromFile: string, ctx: ResolveContext): string[] {
  const namespace = ctx.packageOf(fromFile);
  return namespace ? phpFiles(namespace, ctx).filter((f) => f !== fromFile) : [];
}

export const php: LanguageSpec = {
  id: "php",
  grammar: "php",
  family: "php",
  query: QUERY,
  scopeBreakers: new Set(["compound_statement", "anonymous_function", "arrow_function"]),
  selfNames: new Set(["$this", "self", "static"]),
  superNames: new Set(["parent"]),
  importsAreExports: false,
  ignoredNames: BUILTINS,
  classify,
  outer,
  exported,
  signature,
  doc,
  isIdentUsage,
  parseImport,
  resolveImport,
  packageOf,
  ambient,
};
