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
 *   @scan                    a node the language reads more calls from (see scanCalls)
 *   @export.named | @export.default   a name exported separately from its definition, with @name
 *   @typeparam               a generic parameter name, excluded from @ref.type
 *   @fieldvar                instead of @var: a field of the enclosing type, wherever it is
 *                            written (a constructor parameter property, `this.x = new X()`)
 *   @newtype                 instead of @vartype: the class a variable is constructed from;
 *                            ranks below a written type
 *   @varcall                 instead of @vartype: the function or method whose result the
 *                            variable holds; its declared return type is looked up later
 *   @varvalue                instead of @vartype: another value the variable is set to
 *                            (`const db = this.store.db`), whose type it then shares
 *   @var + @vartype          a variable, parameter or field and its declared type, used to
 *                            work out what `variable.method()` calls
 */
/** A function defined inside another needs at least this many lines to be worth a node of its own. */
export const MIN_NESTED_LINES = 3;

/** A call read from plain tokens: `name(…)`, `a.b.name(…)`, `a::name(…)` or `name!(…)`. */
export interface TokenCall {
  /** The called name. */
  name: Node;
  /**
   * What is written before the name, with `.` between segments (`a.b`, `crate.cart`);
   * `?` when it cannot be read; null for a plain call.
   */
  receiver: string | null;
  /** True when a call result sits between the receiver and the name, so `receiver` is only where the chain starts. */
  chained: boolean;
}

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
  /**
   * True when the syntax does not say which base types are classes and which interfaces
   * (C#'s `class A : B, C`): bases are captured as `extends`, and one that resolves to an
   * interface is drawn as `implements`.
   */
  basesByTarget?: boolean;
  /**
   * True when a qualifier can be a namespace that is no scope of its own here (C++'s
   * `shop::total()`): when it names nothing else, the name is looked up as if written bare.
   */
  namespaceQualifiers?: boolean;
  /**
   * True when functions are declared in one place and defined in another (C and C++
   * headers): a use that reaches a declaration, a node of subkind `declaration`, is drawn
   * to its definition when there is exactly one.
   */
  prototypes?: boolean;
  /**
   * True when classes and modules are visible everywhere by their full name, whatever
   * file defines them, and may be reopened in several files (Ruby's constants).
   */
  globalTypes?: boolean;
  /**
   * True when importing a module binds one name to whatever the module returns (Luau's
   * `local Cart = require("./cart")`). That is the symbol the module returns when it names
   * one; when it returns a table put together on the spot, the name stands for the
   * functions that table lists. The types a module exports are reached through the same
   * name (`Cart.Item`).
   */
  moduleValues?: boolean;
  /** Type and identifier names never worth recording (built-in types). */
  ignoredNames?: Set<string>;

  /** Accept or reject a definition and settle its kind. */
  /**
   * Decide what a matched definition is, or null to leave it out. `nested` is true when it
   * sits inside a function body, a callback or an object literal rather than directly in
   * its parent (only for languages with {@link nestedDefs}).
   */
  classify(def: RawDef, parent: SymbolInfo | null, nested?: boolean): DefDecision | null;
  /**
   * Let definitions through the scope breakers when a named symbol encloses them:
   * functions inside functions, methods of object literals. Those shorter than
   * {@link MIN_NESTED_LINES} are left out.
   */
  nestedDefs?: boolean;
  /** Outermost node belonging to the definition (export wrapper, decorators). */
  outer(def: RawDef): Node;
  exported(def: RawDef, outer: Node, parent: SymbolInfo | null): Exported;
  signature(def: RawDef, outer: Node, source: string): string | null;
  doc(def: RawDef, outer: Node, source: string): DocInfo;
  /** False when an identifier is a declaration rather than a use. */
  isIdentUsage(node: Node): boolean;
  /** True for identifiers worth recording even though nothing in this file defines or imports them. */
  keepIdent?(name: string): boolean;
  /**
   * The type name a captured @vartype node stands for, or null when it says
   * nothing usable (`any`, a union of unrelated types). Defaults to the node's text.
   */
  hintType?(node: Node): string | null;
  /** Names of the language's global objects: a call on one (`Promise.all`) is never the project's. */
  globals?: Set<string>;
  /**
   * Method names of the language's standard library common enough that matching one by name
   * alone says nothing (Java's `getName`, Ruby's `each`), on top of the shared list.
   */
  commonMembers?: Set<string>;
  /**
   * Calls the grammar does not show as calls, read by the language itself from each node
   * the query captures as `@scan`: the tokens of a Rust macro call, a Ruby method calling
   * another by its bare name.
   */
  scanCalls?(node: Node): TokenCall[];
  /**
   * When a file does not parse, a version of its text to try instead: what a preprocessor
   * would remove (C's annotation and export macros), blanked with spaces so that every
   * position stays where it was. The parse with fewer errors is kept. Null when there is
   * nothing to remove. `root` is the failed parse, for telling code from comments.
   */
  reparse?(source: string, root: Node): string | null;
  parseImport(node: Node): ImportDecl[];
  resolveImport(imp: ImportDecl, fromFile: string, ctx: ResolveContext): ResolvedImport[];
  /** The package or namespace the file declares (Go, Java, C#). */
  packageOf?(root: Node): string | null;
  /** Files whose top-level symbols are in scope without an import: the rest of the package. */
  ambient?(fromFile: string, ctx: ResolveContext): string[];
  /** The file a path-like qualifier names when it is not an imported name (`crate::a::b`). */
  resolveQualifier?(qualifier: string, fromFile: string, ctx: ResolveContext): string | null;
}
