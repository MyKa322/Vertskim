import type { Node } from "@vscode/tree-sitter-wasm";
import type { Exported, ImportDecl, ImportName, NodeKind } from "../types.js";

/** A definition matched by a language query, before it is accepted. */
export interface RawDef {
  /** The definition node captured as `@def.<kind>`. */
  node: Node;
  /** The node captured as `@name`. */
  nameNode: Node;
  /** The `<kind>` part of the capture name. */
  kind: string;
  name: string;
}

/** A definition that has been accepted into the graph. */
export interface SymbolInfo {
  id: string;
  /** Qualified name within the file, e.g. `Class.method`. */
  qname: string;
  name: string;
  kind: NodeKind;
  exported: Exported;
  /** The definition this one is written inside, if any. */
  parent: SymbolInfo | null;
  /** Qualified name of the type it belongs to when written outside it. */
  owner: string | null;
  /** Name its own receiver goes by inside the body (a Go receiver variable). */
  selfName: string | null;
  start: number;
  end: number;
}

export interface DefDecision {
  kind: NodeKind;
  subkind?: string;
  /** Override the name taken from the `@name` capture. */
  name?: string;
  /**
   * Qualified name of the type this definition belongs to when it is written
   * outside that type: a Go method's receiver, a Rust `impl` block.
   */
  owner?: string;
  /** Name the receiver goes by inside the body, when the language lets the author choose it. */
  selfName?: string;
}

export interface DocInfo {
  text: string | null;
  /** 1-based line where the doc comment starts, when it sits above the definition. */
  startLine?: number;
}

/** Where an import specifier points. */
export interface ResolvedImport {
  /** Project file the import resolves to. */
  file?: string;
  /** Project files that together make up the imported package (Go, Java, C#). */
  files?: string[];
  /** Directory the import is drawn to when it names a package rather than a file. */
  dir?: string;
  /** Third-party or built-in module. */
  external?: { id: string; name: string; ecosystem: string };
  names: ImportName[];
}

export interface ResolveContext {
  hasFile(path: string): boolean;
  /** Workspace package name -> directory, from the project's package.json files. */
  packages: Map<string, string>;
  /** Files directly inside a directory (`""` for the project root). */
  filesIn(dir: string): string[];
  /** Files that declare this package or namespace. */
  filesInPackage(name: string): string[];
  /** The package or namespace a file declares, if any. */
  packageOf(path: string): string | null;
  /** Every indexed file with this base name. */
  filesNamed(basename: string): string[];
  /** Text of a project file, or null when it cannot be read. */
  read(path: string): string | null;
  /** A value worked out once per resolve run and shared by every file in it. */
  memo<T>(key: string, make: () => T): T;
}

/**
 * Everything language-specific. Adding a language means writing one of these:
 * a tree-sitter query using the shared capture names plus a few small hooks.
 *
 * Capture names understood by the engine:
 *   @def.<kind> + @name      a definition
 *   @ref.call | @ref.new     a call, with @name and optional @qualifier
 *   @ref.extends | @ref.implements   inheritance, with @name, optional @qualifier and
 *                            optional @subject (the type doing the inheriting, when the
 *                            statement is written outside it)
 *   @ref.type                a type name used in an annotation
 *   @ref.ident               any identifier; kept only if it names an import or a file-level
 *                            symbol, or the language's `keepIdent` says so
 *   @import                  an import statement, handed to parseImport
 *   @export.named | @export.default   a name exported separately from its definition, with @name
 *   @typeparam               a generic parameter name, excluded from @ref.type
 *   @var + @vartype          a variable, parameter or field and its declared type, used to
 *                            work out what `variable.method()` calls
 */
export interface LanguageSpec {
  /** Language label, matching `languageOf()`. */
  id: string;
  /** Grammar file name: `tree-sitter-<grammar>.wasm`. */
  grammar: string;
  /** Languages in one family can call each other's symbols. */
  family: string;
  query: string;
  /** Node types that end the scope in which definitions are indexed (function bodies and the like). */
  scopeBreakers: Set<string>;
  /** Receiver names that mean "the enclosing class". */
  selfNames: Set<string>;
  /** Receiver names that mean "the base class", besides `super` (C#'s `base`). */
  superNames?: Set<string>;
  /** True when anything a module imports can be imported from it in turn (Python). */
  importsAreExports: boolean;
  /** True when a bare call inside a class may be to one of its own methods (Java, C#). */
  implicitSelf?: boolean;
  /** Type and identifier names never worth recording (built-in types). */
  ignoredNames?: Set<string>;

  /** Accept or reject a definition and settle its kind. */
  classify(def: RawDef, parent: SymbolInfo | null): DefDecision | null;
  /** Outermost node belonging to the definition (export wrapper, decorators). */
  outer(def: RawDef): Node;
  exported(def: RawDef, outer: Node, parent: SymbolInfo | null): Exported;
  signature(def: RawDef, outer: Node, source: string): string | null;
  doc(def: RawDef, outer: Node, source: string): DocInfo;
  /** False when an identifier is a declaration rather than a use. */
  isIdentUsage(node: Node): boolean;
  /** True for identifiers worth recording even though nothing in this file defines or imports them. */
  keepIdent?(name: string): boolean;
  parseImport(node: Node): ImportDecl[];
  resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[];
  /** The package or namespace the file declares (Go, Java, C#). */
  packageOf?(root: Node): string | null;
  /** Files whose top-level symbols are in scope without an import: the rest of the package. */
  ambient?(fromFile: string, ctx: ResolveContext): string[];
  /** The file a path-like qualifier names when it is not an imported name (`crate::a::b`). */
  resolveQualifier?(qualifier: string, fromFile: string, ctx: ResolveContext): string | null;
}
