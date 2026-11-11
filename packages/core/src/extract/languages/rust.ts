import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl } from "../../types.js";
import { posixBasename, posixDirname, posixJoin } from "../../util.js";
import type { DefDecision, DocInfo, LanguageSpec, RawDef, ResolveContext, ResolvedImport, SymbolInfo } from "../spec.js";
import { ancestor, commentAbove, fieldIs, signatureBeforeBody } from "./common.js";

const QUERY = `
(function_item name: (identifier) @name) @def.function
(function_signature_item name: (identifier) @name) @def.function
(struct_item name: (type_identifier) @name) @def.struct
(union_item name: (type_identifier) @name) @def.struct
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.trait
(type_item name: (type_identifier) @name) @def.type
(const_item name: (identifier) @name) @def.variable
(static_item name: (identifier) @name) @def.variable
(macro_definition name: (identifier) @name) @def.macro

(call_expression function: (identifier) @name) @ref.call
(call_expression function: (field_expression value: (_) @qualifier field: (field_identifier) @name)) @ref.call
(call_expression function: (scoped_identifier path: (_) @qualifier name: (identifier) @name)) @ref.call
(call_expression function: (generic_function function: (identifier) @name)) @ref.call
(call_expression function: (generic_function function: (scoped_identifier path: (_) @qualifier name: (identifier) @name))) @ref.call
(call_expression function: (generic_function function: (field_expression value: (_) @qualifier field: (field_identifier) @name))) @ref.call
(macro_invocation macro: (identifier) @name) @ref.call
(struct_expression name: (type_identifier) @name) @ref.new

(impl_item trait: (type_identifier) @name type: (type_identifier) @subject) @ref.implements
(impl_item trait: (generic_type type: (type_identifier) @name) type: (type_identifier) @subject) @ref.implements
(impl_item trait: (scoped_type_identifier path: (_) @qualifier name: (type_identifier) @name) type: (type_identifier) @subject) @ref.implements
(trait_item bounds: (trait_bounds (type_identifier) @name)) @ref.extends

(scoped_type_identifier path: (_) @qualifier name: (type_identifier) @name) @ref.type
(type_parameter name: (type_identifier) @typeparam)
(type_identifier) @ref.type
(identifier) @ref.ident

(use_declaration) @import
(mod_item !body) @import

(parameter pattern: (identifier) @var type: (type_identifier) @vartype)
(parameter pattern: (identifier) @var type: (reference_type type: (type_identifier) @vartype))
(let_declaration pattern: (identifier) @var type: (type_identifier) @vartype)
(let_declaration pattern: (identifier) @var type: (reference_type type: (type_identifier) @vartype))
(let_declaration pattern: (identifier) @var value: (struct_expression name: (type_identifier) @vartype))
(let_declaration
  pattern: (identifier) @var
  value: (call_expression function: (scoped_identifier path: (identifier) @vartype name: (identifier)))
  (#match? @vartype "^[A-Z]"))
(field_declaration name: (field_identifier) @var type: (type_identifier) @vartype)
`;

const BUILTINS = new Set([
  "Self", "String", "Vec", "Option", "Result", "Box", "Rc", "Arc", "HashMap", "HashSet", "BTreeMap", "BTreeSet",
  "Some", "None", "Ok", "Err", "str", "bool", "char", "usize", "isize", "u8", "u16", "u32", "u64", "u128", "i8",
  "i16", "i32", "i64", "i128", "f32", "f64",
]);

const ATTRIBUTES = new Set(["attribute_item"]);

/** `Foo`, `Foo<T>`, `&Foo` or `a::Foo` -> `Foo`. */
function typeName(node: Node | null): string | null {
  for (let n = node; n; ) {
    if (n.type === "type_identifier") return n.text;
    if (n.type === "generic_type" || n.type === "reference_type") n = n.childForFieldName("type");
    else if (n.type === "scoped_type_identifier") n = n.childForFieldName("name");
    else return null;
  }
  return null;
}

function classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null {
  const impl = ancestor(def.node, "impl_item");
  switch (def.kind) {
    case "function": {
      if (parent) return parent.kind === "interface" ? { kind: "method" } : null;
      if (!impl) return { kind: "function" };
      const owner = typeName(impl.childForFieldName("type"));
      return owner ? { kind: "method", owner } : null;
    }
    case "struct":
      return parent ? null : { kind: "class", subkind: def.node.type === "union_item" ? "union" : "struct" };
    case "enum":
      return parent ? null : { kind: "type", subkind: "enum" };
    case "trait":
      return parent ? null : { kind: "interface", subkind: "trait" };
    case "type":
      return parent || impl ? null : { kind: "type" };
    case "variable":
      return parent || impl ? null : { kind: "variable", subkind: def.node.type === "const_item" ? "const" : "static" };
    case "macro":
      return parent ? null : { kind: "function", subkind: "macro" };
    default:
      return null;
  }
}

function outer(def: RawDef): Node {
  return def.node;
}

function exported(def: RawDef, _outer: Node, parent: SymbolInfo | null): Exported {
  if (parent) return parent.exported ? 1 : 0; // a trait's methods are as visible as the trait
  for (const child of def.node.namedChildren) if (child?.type === "visibility_modifier") return 1;
  // Methods of `impl Trait for Type` carry no `pub`; they are reachable through the trait.
  const impl = ancestor(def.node, "impl_item");
  return impl?.childForFieldName("trait") ? 1 : 0;
}

function signature(def: RawDef, _outer: Node, source: string): string | null {
  return signatureBeforeBody(def, source);
}

function doc(_def: RawDef, outerNode: Node): DocInfo {
  return commentAbove(outerNode, ATTRIBUTES);
}

function isIdentUsage(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case "parameter":
    case "let_declaration":
    case "for_expression":
      return !fieldIs(parent, "pattern", node);
    case "function_item":
    case "function_signature_item":
    case "const_item":
    case "static_item":
    case "mod_item":
    case "macro_definition":
    case "enum_variant":
      return !fieldIs(parent, "name", node);
    case "field_expression":
      return fieldIs(parent, "value", node);
    case "closure_parameters":
    case "tuple_pattern":
    case "tuple_struct_pattern":
    case "struct_pattern":
    case "field_pattern":
    case "ref_pattern":
    case "mut_pattern":
    case "captured_pattern":
    case "attribute":
    case "lifetime":
    case "label":
    case "meta_item":
      return false;
    default:
      return true;
  }
}

/** Flatten a `use` tree into one path per imported name. */
function usePaths(node: Node, prefix: string[], out: { path: string[]; alias: string | null; glob: boolean }[]): void {
  switch (node.type) {
    case "identifier":
    case "crate":
    case "self":
    case "super":
    case "scoped_identifier":
      out.push({ path: [...prefix, ...node.text.split("::").map((s) => s.trim())], alias: null, glob: false });
      return;
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      const alias = node.childForFieldName("alias");
      if (path) out.push({ path: [...prefix, ...path.text.split("::").map((s) => s.trim())], alias: alias?.text ?? null, glob: false });
      return;
    }
    case "use_wildcard": {
      const path = node.namedChild(0);
      out.push({ path: [...prefix, ...(path ? path.text.split("::").map((s) => s.trim()) : [])], alias: null, glob: true });
      return;
    }
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      const list = node.childForFieldName("list");
      const next = path ? [...prefix, ...path.text.split("::").map((s) => s.trim())] : prefix;
      if (list) usePaths(list, next, out);
      return;
    }
    case "use_list":
      for (const child of node.namedChildren) if (child) usePaths(child, prefix, out);
      return;
    default:
      return;
  }
}

function parseImport(node: Node): ImportDecl[] {
  const line = node.startPosition.row + 1;
  const reexport = node.namedChildren.some((c) => c?.type === "visibility_modifier");
  if (node.type === "mod_item") {
    const name = node.childForFieldName("name")?.text;
    return name ? [{ specifier: `mod ${name}`, line, names: [{ local: name, imported: "*" }], reexport }] : [];
  }
  const argument = node.childForFieldName("argument");
  if (!argument) return [];
  const paths: { path: string[]; alias: string | null; glob: boolean }[] = [];
  usePaths(argument, [], paths);
  // Inline modules (`mod tests { ... }`) are not separate nodes here, so each
  // one the statement sits in cancels a leading `super`.
  let depth = 0;
  for (let a = node.parent; a; a = a.parent) if (a.type === "mod_item") depth++;
  const out: ImportDecl[] = [];
  for (const { path: written, alias, glob } of paths) {
    let path = written;
    let cancelled = 0;
    while (cancelled < depth && path[cancelled] === "super") cancelled++;
    if (cancelled > 0) path = path[cancelled] === "super" ? path.slice(cancelled) : ["self", ...path.slice(cancelled)];
    // `use a::b::{self}` names the module itself.
    const segments = path[path.length - 1] === "self" && path.length > 1 ? path.slice(0, -1) : path;
    const last = segments[segments.length - 1];
    if (!last) continue;
    out.push({
      specifier: segments.join("::"),
      line,
      names: glob ? [{ local: "*", imported: "*" }] : [{ local: alias ?? last, imported: last }],
      reexport,
    });
  }
  return out;
}

/** Directory that holds the child modules of the module written in `file`. */
function moduleDir(file: string): string {
  const base = posixBasename(file);
  const dir = posixDirname(file);
  if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") return dir;
  return posixJoin(dir, base.replace(/\.rs$/, "")) ?? dir;
}

function moduleFile(dir: string, name: string, ctx: ResolveContext): string | null {
  for (const candidate of [posixJoin(dir, `${name}.rs`), posixJoin(dir, name, "mod.rs")]) {
    if (candidate !== null && ctx.hasFile(candidate)) return candidate;
  }
  return null;
}

interface Crate {
  name: string;
  /** Directory of the crate's root module, usually `<crate>/src`. */
  src: string;
}

function crates(ctx: ResolveContext): Crate[] {
  return ctx.memo("rust.crates", () => {
    const out: Crate[] = [];
    for (const manifest of ctx.filesNamed("Cargo.toml")) {
      const text = ctx.read(manifest) ?? "";
      const name = /\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(text)?.[1];
      if (!name) continue;
      out.push({ name: name.replace(/-/g, "_"), src: posixJoin(posixDirname(manifest), "src") ?? "src" });
    }
    // Deepest first, so a file finds the crate it actually belongs to.
    return out.sort((a, b) => b.src.length - a.src.length);
  });
}

function crateOf(file: string, ctx: ResolveContext): Crate | null {
  return crates(ctx).find((c) => file.startsWith(`${c.src}/`) || file.startsWith(`${posixDirname(c.src)}/`)) ?? null;
}

function rootFile(crate: Crate, ctx: ResolveContext): string | null {
  for (const name of ["lib.rs", "main.rs"]) {
    const candidate = posixJoin(crate.src, name);
    if (candidate !== null && ctx.hasFile(candidate)) return candidate;
  }
  return null;
}

interface PathTarget {
  /** Module file the path leads into; null when it leaves the project. */
  file: string | null;
  /** Segments left over once no further module file matched: names inside `file`. */
  rest: string[];
  external: string | null;
}

/** Follow a `::` path through module files as far as it goes. */
function followPath(segments: string[], fromFile: string, ctx: ResolveContext): PathTarget {
  const own = crateOf(fromFile, ctx);
  let dir: string;
  let file: string | null = null;
  let i = 0;
  const head = segments[0]!;

  if (head === "crate") {
    if (!own) return { file: null, rest: segments, external: null };
    dir = own.src;
    file = rootFile(own, ctx);
    i = 1;
  } else if (head === "self") {
    dir = moduleDir(fromFile);
    file = fromFile;
    i = 1;
  } else if (head === "super") {
    // The parent module's children live beside this file, or one level up from a mod.rs.
    dir = posixBasename(fromFile) === "mod.rs" ? posixDirname(posixDirname(fromFile)) : posixDirname(fromFile);
    i = 1;
    while (segments[i] === "super") {
      dir = posixDirname(dir);
      i++;
    }
    file = moduleFile(posixDirname(dir), posixBasename(dir), ctx);
    if (!file && own && dir === own.src) file = rootFile(own, ctx);
  } else if (moduleFile(moduleDir(fromFile), head, ctx)) {
    dir = moduleDir(fromFile); // a child module declared with `mod head;`
  } else if (own && head === own.name) {
    dir = own.src;
    file = rootFile(own, ctx);
    i = 1;
  } else {
    const other = crates(ctx).find((c) => c.name === head);
    if (!other) return { file: null, rest: segments, external: head };
    dir = other.src;
    file = rootFile(other, ctx);
    i = 1;
  }

  for (; i < segments.length; i++) {
    const next = moduleFile(dir, segments[i]!, ctx);
    if (!next) break;
    file = next;
    dir = moduleDir(next);
  }
  return { file, rest: segments.slice(i), external: null };
}

function resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[] {
  if (imp.specifier.startsWith("mod ")) {
    const file = moduleFile(moduleDir(fromFile), imp.specifier.slice(4), ctx);
    return file ? [{ file, names: imp.names }] : [{ names: imp.names }];
  }
  const target = followPath(imp.specifier.split("::"), fromFile, ctx);
  if (target.external) {
    const std = target.external === "std" || target.external === "core" || target.external === "alloc";
    const name = std ? "std" : target.external;
    return [{ external: { id: `ext:${std ? "rust" : "cargo"}/${name}`, name, ecosystem: std ? "rust" : "cargo" }, names: imp.names }];
  }
  if (!target.file) return [{ names: imp.names }];
  const glob = imp.names.some((n) => n.local === "*");
  if (glob || target.rest.length === 0) {
    // The path named a module: bind it whole.
    return [{ file: target.file, names: glob ? imp.names : imp.names.map((n) => ({ ...n, imported: "*" })) }];
  }
  // What is left names something inside the module; a second segment is a variant or associated item.
  return [{ file: target.file, names: imp.names.map((n) => ({ ...n, imported: target.rest[0]! })) }];
}

function resolveQualifier(qualifier: string, fromFile: string, ctx: ResolveContext): string | null {
  const target = followPath(qualifier.split("."), fromFile, ctx);
  return target.file && target.rest.length === 0 && target.file !== fromFile ? target.file : null;
}

export const rust: LanguageSpec = {
  id: "rust",
  grammar: "rust",
  family: "rust",
  query: QUERY,
  scopeBreakers: new Set(["block", "closure_expression"]),
  selfNames: new Set(["self", "Self"]),
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
  resolveQualifier,
};
