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
  TokenCall,
} from "../spec.js";
import { commentAbove, fieldIs, signatureBeforeBody } from "./common.js";

/** Kernel methods and class-body keywords: calls, but never to the project. */
// biome-ignore format: a list of words reads better packed
const KERNEL = [
  "require", "require_relative", "load", "autoload", "include", "extend", "prepend", "attr_reader", "attr_writer",
  "attr_accessor", "private", "protected", "public", "module_function", "private_constant", "puts", "print", "p",
  "pp", "raise", "fail", "lambda", "proc", "loop", "catch", "throw", "format", "sprintf", "block_given?", "binding",
];
const KERNEL_LIST = KERNEL.map((k) => `"${k}"`).join(" ");

const QUERY = `
(class name: (constant) @name) @def.class
(class name: (scope_resolution name: (constant) @name)) @def.class
(module name: (constant) @name) @def.module
(module name: (scope_resolution name: (constant) @name)) @def.module
(method name: (_) @name) @def.method
(singleton_method object: (self) name: (_) @name) @def.singleton
(assignment left: (constant) @name) @def.constant

(call receiver: (_) @qualifier method: (identifier) @name (#not-eq? @name "new")) @ref.call
(call !receiver method: (identifier) @name (#not-any-of? @name ${KERNEL_LIST})) @ref.call
(call receiver: (constant) @name method: (identifier) @_new (#eq? @_new "new")) @ref.new
(call receiver: (scope_resolution scope: (_) @qualifier name: (constant) @name) method: (identifier) @_new (#eq? @_new "new")) @ref.new
(superclass (constant) @name) @ref.extends
(superclass (scope_resolution scope: (_) @qualifier name: (constant) @name)) @ref.extends
(call !receiver method: (identifier) @_mixin arguments: (argument_list (constant) @name) (#any-of? @_mixin "include" "extend" "prepend")) @ref.extends
(call !receiver method: (identifier) @_mixin arguments: (argument_list (scope_resolution scope: (_) @qualifier name: (constant) @name)) (#any-of? @_mixin "include" "extend" "prepend")) @ref.extends

(scope_resolution scope: (_) @qualifier name: (constant) @name) @ref.type
(constant) @ref.type
(identifier) @ref.ident

(call !receiver method: (identifier) @_require arguments: (argument_list (string)) (#any-of? @_require "require" "require_relative" "load" "autoload")) @import

(program) @scan
(method) @scan
(singleton_method) @scan

(assignment left: (identifier) @var right: (call receiver: (constant) @newtype method: (identifier) @_n (#eq? @_n "new")))
(assignment left: (identifier) @var right: (call receiver: (scope_resolution) @newtype method: (identifier) @_n (#eq? @_n "new")))
`;

// biome-ignore format: a list of words reads better packed
const BUILTINS = new Set([
  "Object", "BasicObject", "Module", "Class", "Kernel", "Comparable", "Enumerable", "String", "Symbol", "Integer",
  "Float", "Numeric", "Array", "Hash", "Set", "Struct", "Range", "Proc", "Time", "IO", "File", "Dir", "Exception",
  "StandardError", "RuntimeError", "ArgumentError", "TypeError", "NameError", "NoMethodError", "KeyError",
  "NotImplementedError", "JSON", "ENV", "ARGV", "STDOUT", "STDERR",
]);

const TYPE_PARENTS = new Set(["class", "interface", "type"]);
const VISIBILITY = new Set(["private", "protected", "public"]);
/** Nodes that start a scope of their own: their names are not the enclosing method's. */
const OWN_SCOPES = new Set(["method", "singleton_method", "class", "module", "singleton_class"]);
const PARAMETER_LISTS = new Set(["method_parameters", "block_parameters", "lambda_parameters"]);
const NAMED_PARAMETERS = new Set([
  "optional_parameter",
  "keyword_parameter",
  "splat_parameter",
  "hash_splat_parameter",
  "block_parameter",
]);

/**
 * `Shop` for `class Shop::Cart`, inside whatever encloses it: the class's full name
 * is then `Shop.Cart`, as if written inside `module Shop`.
 */
function compactScope(def: RawDef, parent: SymbolInfo | null): { owner?: string } {
  const name = def.node.childForFieldName("name");
  const scope = name?.type === "scope_resolution" ? name.childForFieldName("scope") : null;
  if (!scope || !/^[A-Z]\w*(\s*::\s*[A-Z]\w*)*$/.test(scope.text)) return {};
  const written = scope.text.replace(/\s*::\s*/g, ".");
  return { owner: parent ? `${parent.qname}.${written}` : written };
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  if (parent && !TYPE_PARENTS.has(parent.kind)) return null;
  switch (def.kind) {
    case "class":
      return { kind: "class", ...compactScope(def, parent) };
    case "module":
      return { kind: "class", subkind: "module", ...compactScope(def, parent) };
    case "method":
      return parent ? { kind: "method" } : { kind: "function" };
    case "singleton":
      return parent ? { kind: "method", subkind: "static" } : null;
    case "constant":
      return { kind: "variable", subkind: "const" };
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  // `private def audit; end`: the visibility call wraps the method.
  const list = def.node.parent;
  return list?.type === "argument_list" && list.parent?.type === "call" ? list.parent : def.node;
}

function exported(def: RawDef, outerNode: Node, _parent: SymbolInfo | null): Exported {
  if (def.kind !== "method" && def.kind !== "singleton") return 1;
  if (outerNode !== def.node) {
    const method = outerNode.childForFieldName("method")?.text;
    return method === "private" || method === "protected" ? 0 : 1;
  }
  // A bare `private` above it in the class body hides everything after it, until `public`.
  for (let s = outerNode.previousNamedSibling; s; s = s.previousNamedSibling) {
    if (s.type === "identifier" && VISIBILITY.has(s.text)) return s.text === "public" ? 1 : 0;
  }
  return 1;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  // A comment ahead of the body is parsed inside the definition; `def a; end` has no body to stop at.
  return (
    signatureBeforeBody(def, source)
      ?.replace(/\s+#\s.*$/, "")
      .replace(/\s*;.*$/, "") ?? null
  );
}

/**
 * The comment above a definition. A comment before the first statement of a body is
 * parsed as part of the enclosing class or module, so it is looked for there too.
 */
function doc(_def: RawDef, outerNode: Node): DocInfo {
  const found = commentAbove(outerNode);
  if (found.text || outerNode.previousNamedSibling) return found;
  const body = outerNode.parent;
  return body?.type === "body_statement" ? commentAbove(body) : found;
}

/** True when an identifier names a local variable or parameter there, rather than using one. */
function declares(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (PARAMETER_LISTS.has(parent.type) || NAMED_PARAMETERS.has(parent.type)) return true;
  switch (parent.type) {
    case "assignment":
    case "operator_assignment":
      return fieldIs(parent, "left", node);
    case "left_assignment_list":
    case "destructured_left_assignment":
    case "destructured_parameter":
    case "exception_variable":
      return true;
    case "for":
      return fieldIs(parent, "pattern", node);
    default:
      return false;
  }
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent || declares(node)) return false;
  switch (parent.type) {
    case "method":
    case "singleton_method":
      return !fieldIs(parent, "name", node);
    case "call":
      return !fieldIs(parent, "method", node);
    default:
      return true;
  }
}

/**
 * Calls written as a bare name (`audit`, `price * 2`): Ruby lets a method be called
 * without parentheses or a receiver, and the parser sees only an identifier. Any name the
 * method does not assign or take as a parameter is such a call.
 */
function scanCalls(scope: Node): TokenCall[] {
  const locals = new Set<string>();
  const uses: Node[] = [];
  const walk = (node: Node) => {
    for (const child of node.namedChildren) {
      if (!child || OWN_SCOPES.has(child.type)) continue;
      if (child.type === "identifier") {
        if (declares(child)) locals.add(child.text);
        else if (isIdentUsage(child)) uses.push(child);
      } else {
        walk(child);
      }
    }
  };
  if (scope.type === "program") walk(scope);
  else {
    // Parameters first, then the body; the method's own name is neither.
    for (const field of ["parameters", "body"]) {
      const part = scope.childForFieldName(field);
      if (part) walk(part);
    }
  }
  return uses
    .filter((use) => !locals.has(use.text) && !KERNEL.includes(use.text))
    .map((use) => ({ name: use, receiver: null, chained: false }));
}

function parseImport(node: Node): ImportDecl[] {
  const method = node.childForFieldName("method")?.text;
  const args = node.childForFieldName("arguments");
  const literal = args?.namedChildren.find((c) => c?.type === "string");
  // A path built with interpolation cannot be followed.
  if (!literal || literal.namedChildren.some((c) => c?.type === "interpolation")) return [];
  const text = literal.namedChildren.find((c) => c?.type === "string_content")?.text ?? "";
  if (!text) return [];
  return [
    {
      specifier: method === "require_relative" ? `./${text}` : text,
      line: node.startPosition.row + 1,
      // Requiring a file runs it: what it defines, and what it requires, is then defined everywhere.
      names: [{ local: "*", imported: "*" }],
      reexport: true,
    },
  ];
}

function withExtension(path: string): string {
  return path.endsWith(".rb") ? path : `${path}.rb`;
}

function resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  if (imp.specifier.startsWith("./")) {
    const target = posixJoin(posixDirname(fromFile), withExtension(imp.specifier.slice(2)));
    return target !== null && ctx.hasFile(target) ? [{ file: target, names: imp.names }] : [{ names: imp.names }];
  }
  // `require "shop/cart"` looks along the load path, which is usually a lib/ folder.
  const written = withExtension(imp.specifier);
  const found = ctx
    .filesNamed(posixBasename(written))
    .filter((f) => f === written || f.endsWith(`/${written}`))
    .sort((a, b) => Number(!/(^|\/)lib\//.test(a)) - Number(!/(^|\/)lib\//.test(b)) || a.length - b.length);
  if (found.length > 0) return [{ file: found[0]!, names: imp.names }];
  const name = imp.specifier.split("/")[0]!;
  return [{ external: { id: `ext:gem/${name}`, name, ecosystem: "gem" }, names: imp.names }];
}

/** Standard-library methods too common for a name-only match to mean anything. */
// biome-ignore format: a list of words reads better packed
const COMMON_MEMBERS = new Set([
  "each_with_object", "each_pair", "collect", "reject", "key?", "has_key?", "fetch", "dig", "merge", "merge!", "any?",
  "all?", "none?", "first", "last", "chomp", "gsub", "sub", "start_with?", "end_with?", "to_f", "inspect", "frozen?",
  "is_a?", "kind_of?", "instance_of?", "respond_to?", "public_send", "tap", "then", "closed?", "flush", "rewind",
  "seek", "eof?", "gets", "bytesize", "encoding", "force_encoding", "byteslice", "unpack", "unpack1", "pack",
  "upcase", "downcase", "capitalize", "to_proc", "stat", "exist?", "file?", "directory?", "basename", "dirname",
  "extname", "expand_path", "query", "path", "host", "port", "scheme", "sort_by", "uniq", "compact", "flatten", "zip",
  "group_by", "partition", "each_slice", "slice", "values_at", "delete_if", "keep_if", "rindex", "between?", "to_str",
  "to_ary", "hash", "eql?", "equal?", "instance_variable_get", "instance_variable_set", "define_method", "method",
  "methods", "object_id", "transform_values", "transform_keys", "filter_map", "step", "times", "upto", "downto",
  "succ", "abs", "round", "floor", "ceil", "chars", "lines", "each_line", "each_char", "match?", "string", "ord", "chr", "lstrip",
  "rstrip", "ljust", "rjust", "center", "squeeze", "scrub",
]);

export const ruby: LanguageSpec = {
  id: "ruby",
  grammar: "ruby",
  family: "ruby",
  query: QUERY,
  scopeBreakers: new Set(["method", "singleton_method", "block", "do_block", "lambda"]),
  selfNames: new Set(["self"]),
  importsAreExports: false,
  implicitSelf: true,
  globalTypes: true,
  commonMembers: COMMON_MEMBERS,
  ignoredNames: BUILTINS,
  classify,
  outer,
  exported,
  signature,
  doc,
  isIdentUsage,
  scanCalls,
  parseImport,
  resolveImport,
};
