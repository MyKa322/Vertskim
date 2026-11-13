import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl } from "../../types.js";
import { posixBasename, posixDirname, posixJoin } from "../../util.js";
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

// C goes through the C++ grammar: it parses nearly all C, and headers are shared between the two.
const QUERY = `
(class_specifier name: (type_identifier) @name body: (field_declaration_list)) @def.class
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @def.struct
(union_specifier name: (type_identifier) @name body: (field_declaration_list)) @def.union
(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @def.enum
(type_definition declarator: (type_identifier) @name) @def.type
(alias_declaration name: (type_identifier) @name) @def.type

(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.function
(function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @def.function
(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (field_identifier) @name))) @def.method
(function_definition declarator: (reference_declarator (function_declarator declarator: (field_identifier) @name))) @def.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @def.outside
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (qualified_identifier name: (identifier) @name)))) @def.outside
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @def.outside
(function_definition declarator: (reference_declarator (function_declarator declarator: (qualified_identifier name: (identifier) @name)))) @def.outside
(declaration declarator: (function_declarator declarator: (identifier) @name)) @def.prototype
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @def.prototype
(field_declaration declarator: (function_declarator declarator: (field_identifier) @name)) @def.member
(field_declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (field_identifier) @name))) @def.member
(field_declaration declarator: (reference_declarator (function_declarator declarator: (field_identifier) @name))) @def.member
(preproc_def name: (identifier) @name) @def.macro
(preproc_function_def name: (identifier) @name) @def.macrofn
(declaration declarator: (init_declarator declarator: (identifier) @name)) @def.variable

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (field_expression argument: (_) @qualifier field: (field_identifier) @name)) @ref.call
(call_expression function: (qualified_identifier scope: (_) @qualifier name: (identifier) @name)) @ref.call
(call_expression function: (qualified_identifier name: (qualified_identifier scope: (_) @qualifier name: (identifier) @name))) @ref.call
(call_expression function: (template_function name: (identifier) @name)) @ref.call
(new_expression type: (type_identifier) @name) @ref.new
(new_expression type: (qualified_identifier scope: (_) @qualifier name: (type_identifier) @name)) @ref.new
(base_class_clause (type_identifier) @name) @ref.extends
(base_class_clause (qualified_identifier scope: (_) @qualifier name: (type_identifier) @name)) @ref.extends
(base_class_clause (template_type name: (type_identifier) @name)) @ref.extends

(qualified_identifier scope: (namespace_identifier) @qualifier name: (type_identifier) @name) @ref.type
(template_parameter_list (type_parameter_declaration (type_identifier) @typeparam))
(type_identifier) @ref.type
(identifier) @ref.ident

(preproc_include) @import

(parameter_declaration type: (type_identifier) @vartype declarator: (identifier) @var)
(parameter_declaration type: (type_identifier) @vartype declarator: (reference_declarator (identifier) @var))
(parameter_declaration type: (type_identifier) @vartype declarator: (pointer_declarator declarator: (identifier) @var))
(parameter_declaration type: (qualified_identifier name: (type_identifier) @vartype) declarator: (identifier) @var)
(parameter_declaration type: (qualified_identifier name: (type_identifier) @vartype) declarator: (reference_declarator (identifier) @var))
(declaration type: (type_identifier) @vartype declarator: (identifier) @var)
(declaration type: (type_identifier) @vartype declarator: (init_declarator declarator: (identifier) @var))
(declaration type: (type_identifier) @vartype declarator: (pointer_declarator declarator: (identifier) @var))
(declaration type: (type_identifier) @vartype declarator: (init_declarator declarator: (pointer_declarator declarator: (identifier) @var)))
(declaration type: (qualified_identifier name: (type_identifier) @vartype) declarator: (identifier) @var)
(declaration type: (qualified_identifier name: (type_identifier) @vartype) declarator: (init_declarator declarator: (identifier) @var))
(field_declaration type: (type_identifier) @vartype declarator: (field_identifier) @var)
(field_declaration type: (type_identifier) @vartype declarator: (pointer_declarator declarator: (field_identifier) @var))
`;

// biome-ignore format: a list of words reads better packed
const BUILTINS = new Set([
  "std", "size_t", "ssize_t", "ptrdiff_t", "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t",
  "uint32_t", "uint64_t", "intptr_t", "uintptr_t", "FILE", "NULL", "nullptr", "string", "vector", "map", "set",
  "unordered_map", "unordered_set", "shared_ptr", "unique_ptr", "optional", "pair", "tuple", "function", "array",
]);

const TYPE_PARENTS = new Set(["class", "interface", "type"]);
/** Specifiers a typedef can wrap, and the subkind each gives. */
const TAGGED = new Map([
  ["struct_specifier", "struct"],
  ["union_specifier", "union"],
  ["enum_specifier", "enum"],
]);
const COMMENT_SKIP = new Set(["attribute_declaration"]);

function storage(node: Node): string[] {
  const out: string[] = [];
  for (const child of node.namedChildren) if (child?.type === "storage_class_specifier") out.push(child.text);
  return out;
}

/** `Cart` for `Cart::add`, `shop::Cart::add` or `Cart<T>::add`. */
function ownerOf(def: RawDef): string | null {
  const qualified = ancestorOfName(def.nameNode, "qualified_identifier");
  if (!qualified) return null;
  const segments = qualified.text.replace(/<[^<>]*>/g, "").split("::");
  const owner = segments[segments.length - 2]?.trim();
  return owner && /^[A-Za-z_]\w*$/.test(owner) ? owner : null;
}

/** The outermost `qualified_identifier` the name sits in. */
function ancestorOfName(name: Node, type: string): Node | null {
  let found: Node | null = null;
  for (let n = name.parent; n?.type === type; n = n.parent) found = n;
  return found;
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  if (parent && !TYPE_PARENTS.has(parent.kind)) return null;
  switch (def.kind) {
    case "class":
      return { kind: "class" };
    case "struct":
    case "union":
      return { kind: "class", subkind: def.kind };
    case "enum":
      return { kind: "type", subkind: "enum" };
    case "type": {
      // `typedef struct Foo {...} Foo;` is the struct itself, already a node; an unnamed one takes the typedef's name.
      const type = def.node.childForFieldName("type");
      if (type && TAGGED.has(type.type) && type.childForFieldName("body")) {
        if (type.childForFieldName("name")) return null;
        return { kind: type.type === "enum_specifier" ? "type" : "class", subkind: TAGGED.get(type.type)! };
      }
      return { kind: "type" };
    }
    case "function":
      // Inside a class, a function named without a return type is a constructor.
      return parent ? { kind: "method", subkind: "constructor" } : { kind: "function" };
    case "method":
      return parent ? { kind: "method" } : null;
    case "member":
      return parent ? { kind: "method", subkind: "declaration" } : null;
    case "outside": {
      if (parent) return null;
      const owner = ownerOf(def);
      return owner ? { kind: "method", owner } : { kind: "function" };
    }
    case "prototype":
      return parent ? { kind: "method", subkind: "declaration" } : { kind: "function", subkind: "declaration" };
    case "macro":
      // A macro with no value is a header guard or a switch, not something code uses.
      return parent || !def.node.childForFieldName("value") ? null : { kind: "variable", subkind: "macro" };
    case "macrofn":
      return parent ? null : { kind: "function", subkind: "macro" };
    case "variable":
      return parent ? null : { kind: "variable" };
    default:
      return null;
  }
}

/** A template's definition starts at `template <...>`, where its comment sits. */
function outer(def: RawDef): Node {
  const parent = def.node.parent;
  return parent?.type === "template_declaration" ? parent : def.node;
}

/** `public:` and the like, the nearest one written before a member. */
function access(member: Node): string | null {
  for (let s = member.previousNamedSibling; s; s = s.previousNamedSibling) {
    if (s.type === "access_specifier") return s.text;
  }
  return null;
}

function exported(def: RawDef, outerNode: Node, parent: SymbolInfo | null): Exported {
  if (parent) {
    if (!parent.exported) return 0;
    const section = access(outerNode);
    const body = outerNode.parent;
    // Members of a class are private until a section says otherwise; those of a struct are public.
    const isClass = body?.parent?.type === "class_specifier";
    return (section ?? (isClass ? "private" : "public")) === "public" ? 1 : 0;
  }
  if (storage(def.node).includes("static")) return 0;
  for (let a = outerNode.parent; a; a = a.parent) {
    if (a.type === "namespace_definition" && !a.childForFieldName("name")) return 0; // anonymous namespace
  }
  return 1;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  return signatureBeforeBody(def, source);
}

function doc(_def: RawDef, outerNode: Node): DocInfo {
  return commentAbove(outerNode, COMMENT_SKIP);
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "function_declarator":
    case "init_declarator":
    case "parameter_declaration":
    case "optional_parameter_declaration":
    case "declaration":
    case "for_range_loop":
      return !fieldIs(parent, "declarator", node);
    case "preproc_def":
    case "preproc_function_def":
    case "enumerator":
      return !fieldIs(parent, "name", node);
    case "field_expression":
      return fieldIs(parent, "argument", node);
    case "reference_declarator":
    case "pointer_declarator":
    case "array_declarator":
    case "qualified_identifier":
    case "preproc_params":
    case "labeled_statement":
    case "goto_statement":
    case "preproc_defined":
      return false;
    default:
      return true;
  }
}

/** Text the macro clean-up leaves alone. */
const LITERALS = new Set(["comment", "string_literal", "raw_string_literal", "char_literal", "system_lib_string"]);
/** Words after which `NAME(...)` is an expression, not an annotation. */
const EXPRESSION_KEYWORDS =
  /^(?:return|case|throw|else|do|goto|co_return|co_yield|new|delete|sizeof|alignof|decltype|typeid|if|while|for|switch)$/;
/** `CJSON_PUBLIC(const char *) name(` at the start of a declaration: an export macro wrapping the return type. */
const WRAPPER =
  /^([ \t]*(?:(?:extern|static|inline)\s+)*)([A-Z][A-Z0-9_]{2,})\(([^()\n]*)\)(?=[\s*&]*[A-Za-z_]\w*\s*\()/gm;
/** `GUARDED_BY(mu)` or `EXCLUSIVE_LOCKS_REQUIRED(mutex_)` after a declarator. */
const ANNOTATION =
  /([)\w])([ \t\r\n]+)([A-Z][A-Z0-9_]{2,}\s*\((?:[^;{}()]|\([^;{}()]*\))*\))(?=\s*(?:[;{=,:]|const\b|override\b|final\b|noexcept\b|->|[A-Z][A-Z0-9_]{2,}\s*\())/g;
/** Export, visibility and calling-convention words: `class LEVELDB_EXPORT DB`, `void (CJSON_CDECL *fn)(...)`. */
const DECORATION =
  /\b(?:[A-Z][A-Z0-9_]*_(?:EXPORT|EXPORTS|API|CDECL|STDCALL|FASTCALL|PUBLIC|DLL|INLINE|NORETURN|DEPRECATED|UNUSED)|NO_THREAD_SAFETY_ANALYSIS|WINAPI|APIENTRY)\b(?!\s*\()/g;

/**
 * Blank out what a preprocessor would expand away and the parser cannot make sense of:
 * export macros around a return type, annotations after a declarator, export and
 * calling-convention words. Replaced with spaces, newlines kept, so that every position
 * in the text stays the same.
 */
function reparse(source: string, root: Node): string | null {
  const literals: [number, number][] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (LITERALS.has(node.type)) {
      literals.push([node.startIndex, node.endIndex]);
      continue;
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  literals.sort((a, b) => a[0] - b[0]);
  const inLiteral = (start: number, end: number) => {
    let lo = 0;
    let hi = literals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [s, e] = literals[mid]!;
      if (e <= start) lo = mid + 1;
      else if (s >= end) hi = mid - 1;
      else return true;
    }
    return false;
  };

  let text = source;
  const blank = (start: number, end: number) => {
    if (start >= end || inLiteral(start, end)) return false;
    text = text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
    return true;
  };
  for (const match of [...text.matchAll(WRAPPER)]) {
    const macroStart = match.index + match[1]!.length;
    const close = macroStart + match[2]!.length + 1 + match[3]!.length;
    if (!inLiteral(macroStart, close + 1)) {
      blank(macroStart, macroStart + match[2]!.length + 1); // `NAME(`
      blank(close, close + 1); // `)`
    }
  }
  // Annotations can follow one another; each pass clears the last of a run.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const match of [...text.matchAll(ANNOTATION)]) {
      const start = match.index + match[1]!.length + match[2]!.length;
      if (match[1] !== ")") {
        const word = /\w+$/.exec(text.slice(Math.max(0, match.index - 40), match.index + 1))?.[0] ?? "";
        if (EXPRESSION_KEYWORDS.test(word)) continue;
      }
      if (blank(start, start + match[3]!.length)) changed = true;
    }
    if (!changed) break;
  }
  for (const match of [...text.matchAll(DECORATION)]) blank(match.index, match.index + match[0].length);
  return text === source ? null : text;
}

function parseImport(node: Node): ImportDecl[] {
  const path = node.childForFieldName("path");
  if (!path) return [];
  const system = path.type === "system_lib_string";
  const text = system ? path.text.slice(1, -1) : unquote(path.text);
  if (!text) return [];
  // An included file is pasted in whole, with everything it includes in turn.
  return [
    {
      specifier: system ? `<${text}>` : text,
      line: node.startPosition.row + 1,
      names: [{ local: "*", imported: "*" }],
      reexport: true,
    },
  ];
}

/** Of several files, the one whose directory shares the most with `fromFile`'s. */
function closest(files: string[], fromFile: string): string {
  const from = posixDirname(fromFile).split("/");
  let best = files[0]!;
  let bestScore = -1;
  for (const file of [...files].sort()) {
    const dir = posixDirname(file).split("/");
    let score = 0;
    while (score < dir.length && score < from.length && dir[score] === from[score]) score++;
    if (score > bestScore) {
      best = file;
      bestScore = score;
    }
  }
  return best;
}

function resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  const system = imp.specifier.startsWith("<");
  const written = system ? imp.specifier.slice(1, -1) : imp.specifier;
  if (!system) {
    const beside = posixJoin(posixDirname(fromFile), written);
    if (beside !== null && ctx.hasFile(beside)) return [{ file: beside, names: imp.names }];
  }
  // Include directories are set in the build, which is not read: any file ending in the written path will do.
  const found = ctx.filesNamed(posixBasename(written)).filter((f) => f === written || f.endsWith(`/${written}`));
  if (found.length > 0) return [{ file: closest(found, fromFile), names: imp.names }];
  if (!system) return [{ names: imp.names }]; // generated, or outside the project
  const name = written.includes("/") ? written.slice(0, written.indexOf("/")) : "std";
  return [{ external: { id: `ext:c/${name}`, name, ecosystem: "c" }, names: imp.names }];
}

const shared = {
  grammar: "cpp",
  family: "c",
  query: QUERY,
  scopeBreakers: new Set(["compound_statement", "lambda_expression"]),
  selfNames: new Set(["this"]),
  importsAreExports: false,
  implicitSelf: true,
  namespaceQualifiers: true,
  prototypes: true,
  ignoredNames: BUILTINS,
  globals: new Set(["std"]),
  classify,
  outer,
  exported,
  signature,
  doc,
  isIdentUsage,
  reparse,
  parseImport,
  resolveImport,
} satisfies Omit<LanguageSpec, "id">;

export const c: LanguageSpec = { id: "c", ...shared };
export const cpp: LanguageSpec = { id: "cpp", ...shared };
