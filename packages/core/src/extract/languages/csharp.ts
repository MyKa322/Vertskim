import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl } from "../../types.js";
import { posixDirname } from "../../util.js";
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
(class_declaration name: (identifier) @name) @def.class
(struct_declaration name: (identifier) @name) @def.struct
(record_declaration name: (identifier) @name) @def.record
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(delegate_declaration name: (identifier) @name) @def.delegate
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.constructor
(property_declaration name: (identifier) @name) @def.property
(field_declaration
  (modifier) @_mod
  (variable_declaration (variable_declarator name: (identifier) @name))
  (#eq? @_mod "const")) @def.variable

(invocation_expression function: (identifier) @name) @ref.call
(invocation_expression function: (generic_name (identifier) @name)) @ref.call
(invocation_expression function: (member_access_expression expression: (_) @qualifier name: (identifier) @name)) @ref.call
(invocation_expression function: (member_access_expression expression: (_) @qualifier name: (generic_name (identifier) @name))) @ref.call
(object_creation_expression type: (identifier) @name) @ref.new
(object_creation_expression type: (generic_name (identifier) @name)) @ref.new
(base_list (identifier) @name) @ref.extends
(base_list (generic_name (identifier) @name)) @ref.extends

(type_parameter name: (identifier) @typeparam)
(identifier) @ref.ident

(using_directive) @import

(parameter type: (identifier) @vartype name: (identifier) @var)
(parameter type: (generic_name (identifier) @vartype) name: (identifier) @var)
(variable_declaration type: (identifier) @vartype (variable_declarator name: (identifier) @var))
(variable_declaration type: (generic_name (identifier) @vartype) (variable_declarator name: (identifier) @var))
(variable_declaration (variable_declarator name: (identifier) @var (object_creation_expression type: (identifier) @vartype)))
(property_declaration type: (identifier) @vartype name: (identifier) @var)
(foreach_statement type: (identifier) @vartype left: (identifier) @var)
(parameter type: (qualified_name) @vartype name: (identifier) @var)
(variable_declaration type: (qualified_name) @vartype (variable_declarator name: (identifier) @var))
(property_declaration type: (qualified_name) @vartype name: (identifier) @var)
`;

const BUILTINS = new Set(["String", "Object", "Task", "Console", "Math", "var", "nameof", "value"]);
const TYPE_PARENTS = new Set(["class", "interface", "type"]);

function modifiers(node: Node): Set<string> {
  const out = new Set<string>();
  for (const child of node.namedChildren) if (child?.type === "modifier") out.add(child.text);
  return out;
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  if (parent && !TYPE_PARENTS.has(parent.kind)) return null;
  switch (def.kind) {
    case "class":
      return { kind: "class" };
    case "struct":
      return { kind: "class", subkind: "struct" };
    case "record":
      return { kind: "class", subkind: "record" };
    case "interface":
      return { kind: "interface" };
    case "enum":
      return { kind: "type", subkind: "enum" };
    case "delegate":
      return { kind: "type", subkind: "delegate" };
    case "method":
      return parent ? { kind: "method" } : null;
    case "constructor":
      return parent ? { kind: "method", subkind: "constructor" } : null;
    case "property":
      return parent ? { kind: "variable", subkind: "property" } : null;
    case "variable":
      return parent ? { kind: "variable", subkind: "const" } : null;
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  return def.node;
}

function exported(def: RawDef, _outer: Node, parent: SymbolInfo | null): Exported {
  if (parent && !parent.exported) return 0;
  if (parent?.kind === "interface") return 1;
  const mods = modifiers(def.node);
  if (mods.has("private")) return 0;
  if (mods.has("public") || mods.has("internal") || mods.has("protected")) return 1;
  // No modifier: members are private, top-level types are visible to the assembly.
  return parent ? 0 : 1;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  const text = signatureBeforeBody(def, source, ["body", "accessors"]);
  // Attributes sit in front of the modifiers and say little about the shape.
  return text ? text.replace(/^(\[[^\]]*\]\s*)+/, "") || null : null;
}

function doc(_def: RawDef, outerNode: Node): DocInfo {
  return commentAbove(outerNode);
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "class_declaration":
    case "struct_declaration":
    case "record_declaration":
    case "interface_declaration":
    case "enum_declaration":
    case "delegate_declaration":
    case "method_declaration":
    case "constructor_declaration":
    case "property_declaration":
    case "variable_declarator":
    case "parameter":
    case "enum_member_declaration":
    case "type_parameter":
    case "catch_declaration":
    case "local_function_statement":
      return !fieldIs(parent, "name", node);
    case "foreach_statement":
      return !fieldIs(parent, "left", node);
    case "member_access_expression":
      return fieldIs(parent, "expression", node);
    case "qualified_name":
    case "using_directive":
    case "attribute":
    case "name_colon":
    case "name_equals":
    case "labeled_statement":
    case "namespace_declaration":
    case "file_scoped_namespace_declaration":
      return false;
    default:
      return true;
  }
}

function parseImport(node: Node): ImportDecl[] {
  const match = /^(?:global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/.exec(node.text.replace(/\s+/g, " "));
  if (!match) return [];
  const line = node.startPosition.row + 1;
  let path = match[3]!;
  if (match[2]) {
    // `using Alias = A.B.C;` names a type, or sometimes a namespace.
    return [
      {
        specifier: path,
        line,
        names: [{ local: match[2], imported: path.slice(path.lastIndexOf(".") + 1) }],
        reexport: false,
      },
    ];
  }
  // `using static A.B.C;` is treated as bringing C's namespace in.
  if (match[1] && path.includes(".")) path = path.slice(0, path.lastIndexOf("."));
  return [{ specifier: path, line, names: [{ local: "*", imported: "*" }], reexport: false }];
}

function csFiles(namespace: string, ctx: ResolveContext): string[] {
  return ctx.filesInPackage(namespace).filter((f) => f.endsWith(".cs"));
}

/** The one directory a namespace's files share, if they do. */
function sharedDir(files: string[]): string | undefined {
  const dir = posixDirname(files[0]!);
  return files.every((f) => posixDirname(f) === dir) ? dir : undefined;
}

function resolveImport(imp: ImportDecl, _fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const path = imp.specifier;
  const withDir = (files: string[], names: ImportDecl["names"]): ResolvedImport[] => {
    const dir = sharedDir(files);
    return [{ files, names, ...(dir === undefined ? {} : { dir }) }];
  };
  const files = csFiles(path, ctx);
  if (files.length > 0) {
    // An alias for a namespace binds the namespace whole.
    return withDir(
      files,
      imp.names.map((n) => (n.local === "*" ? n : { ...n, imported: "*" })),
    );
  }
  const alias = imp.names.find((n) => n.local !== "*");
  if (alias && path.includes(".")) {
    const owner = csFiles(path.slice(0, path.lastIndexOf(".")), ctx);
    if (owner.length > 0) return withDir(owner, imp.names);
  }
  const segments = path.split(".");
  const name = segments[0] === "System" || segments.length === 1 ? segments[0]! : segments.slice(0, 2).join(".");
  return [{ external: { id: `ext:dotnet/${name}`, name, ecosystem: "dotnet" }, names: imp.names }];
}

function packageOf(root: Node): string | null {
  for (const child of root.namedChildren) {
    if (child?.type === "namespace_declaration" || child?.type === "file_scoped_namespace_declaration") {
      return child.childForFieldName("name")?.text.replace(/\s+/g, "") ?? null;
    }
  }
  return null;
}

/** Everything in the same namespace and the namespaces it is nested in. */
function ambient(fromFile: string, ctx: ResolveContext): string[] {
  const namespace = ctx.packageOf(fromFile);
  if (!namespace) return [];
  const out: string[] = [];
  const segments = namespace.split(".");
  for (let n = segments.length; n >= 1; n--) {
    for (const file of csFiles(segments.slice(0, n).join("."), ctx)) if (file !== fromFile) out.push(file);
  }
  return out;
}

/** Standard-library methods too common for a name-only match to mean anything. */
// biome-ignore format: a list of words reads better packed
const COMMON_MEMBERS = new Set([
  "ToString", "Equals", "GetHashCode", "GetType", "Select", "Where", "Any", "All", "First", "FirstOrDefault",
  "Single", "SingleOrDefault", "Last", "LastOrDefault", "Sum", "OrderBy", "OrderByDescending", "ThenBy", "GroupBy",
  "Add", "Remove", "ContainsKey", "TryGetValue", "AddRange", "Clear", "Wait", "ConfigureAwait", "GetAwaiter",
  "GetResult", "Invoke", "WriteLine", "WriteLineAsync", "Flush", "Append", "AppendLine", "Format", "Join", "Split",
  "Trim", "Replace", "Substring", "StartsWith", "EndsWith", "IndexOf", "IsAssignableFrom", "GetInterfaces",
  "GetMethods", "GetMethod", "GetProperties", "GetProperty", "GetGenericArguments", "GetGenericTypeDefinition",
  "MakeGenericType", "GetCustomAttributes", "Cast", "OfType", "Concat", "Distinct", "Skip", "Take", "Reverse",
  "Aggregate", "SelectMany", "ToDictionary", "ToHashSet", "Max", "Min", "Average", "GetEnumerator", "MoveNext",
]);

export const csharp: LanguageSpec = {
  id: "csharp",
  grammar: "c-sharp",
  family: "dotnet",
  query: QUERY,
  scopeBreakers: new Set(["block", "lambda_expression", "anonymous_method_expression"]),
  selfNames: new Set(["this"]),
  superNames: new Set(["base"]),
  importsAreExports: false,
  implicitSelf: true,
  commonMembers: COMMON_MEMBERS,
  basesByTarget: true,
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
