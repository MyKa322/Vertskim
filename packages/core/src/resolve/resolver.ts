import { readFileSync } from "node:fs";
import { join } from "node:path";
import { specFor } from "../extract/index.js";
import { linkImplicitInterfaces } from "./interfaces.js";
import type { LanguageSpec, ResolveContext, ResolvedImport } from "../extract/spec.js";
import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import {
  SELF_QUALIFIER,
  TYPED_PREFIX,
  UNKNOWN_PREFIX,
  type Confidence,
  type EdgeKind,
  type FileRecord,
  type GraphNode,
  type RawRef,
  type RefKind,
} from "../types.js";
import { dirId, posixBasename, posixDirname, posixJoin, toPosix, yieldToEventLoop, decodeText } from "../util.js";

/** Where an imported name comes from. `files: null` marks a third-party or unresolved module. */
interface Binding {
  files: string[] | null;
  imported: string;
}

/** What a file can see. */
interface FileScope {
  /** Local name -> where it comes from. */
  bindings: Map<string, Binding>;
  /** Files whose exports are all in scope through an import (`from x import *`). */
  wildcards: string[];
  /** Files whose top-level symbols are in scope with no import at all: the rest of the package. */
  ambient: Set<string>;
  importedFiles: Set<string>;
  /** Files this (test) file already has a `tests` edge to. */
  tested: Set<string>;
}

interface Target {
  id: string;
  confidence: Confidence;
}

const EDGE_KIND: Record<RefKind, EdgeKind> = {
  calls: "calls",
  new: "calls",
  references: "references",
  type: "references",
  extends: "extends",
  implements: "implements",
  mentions: "mentions",
  links_to: "links_to",
};

/**
 * Method names so common on built-in types that a name-only match is noise.
 * Only consulted when the receiver's type is unknown.
 */
// biome-ignore format: a list of words reads better packed
const COMMON_MEMBER_NAMES = new Set([
  "get", "set", "has", "add", "delete", "clear", "keys", "values", "entries", "items", "forEach", "map", "filter",
  "reduce", "find", "some", "every", "includes", "indexOf", "push", "pop", "shift", "unshift", "slice", "splice",
  "concat", "join", "split", "sort", "reverse", "flat", "flatMap", "then", "catch", "finally", "toString",
  "valueOf", "toJSON", "trim", "replace", "replaceAll", "match", "test", "exec", "startsWith", "endsWith", "append",
  "extend", "update", "remove", "insert", "copy", "format", "strip", "lower", "upper", "encode", "decode", "read",
  "write", "close", "open", "send", "emit", "on", "off", "once", "call", "apply", "bind", "log", "warn", "error",
  "info", "debug", "parse", "stringify", "next", "run", "start", "stop", "init", "render", "dispose", "destroy",
  "connect", "disconnect", "save", "load", "create", "exists", "resolve", "reject", "count", "index", "length",
  "text", "all", "skip",
  // the same idea in languages that capitalise or snake-case their standard library
  "String", "Error", "Equals", "ToString", "GetHashCode", "Close", "Read", "Write", "Len", "unwrap", "expect",
  "clone", "into", "iter", "collect", "to_string", "as_str", "is_empty", "len", "equals", "hashCode", "size",
  "isEmpty", "contains", "Contains", "ToList", "ToArray", "Dispose",
  // C++ containers and strings, Ruby's Enumerable and Kernel
  "push_back", "emplace_back", "begin", "end", "empty", "erase", "at", "front", "back", "c_str", "data", "reset",
  "release", "swap", "substr", "resize", "reserve", "each", "each_with_index", "inject", "select", "detect",
  "to_s", "to_i", "to_a", "to_h", "to_sym", "freeze", "dup", "empty?", "include?", "nil?", "sum", "min", "max",
]);

const SYMBOL_KINDS = new Set(["class", "interface", "function", "method", "variable", "type"]);
/** Types that are part of the language, never of the project: a value of one has none of the project's methods. */
// biome-ignore format: a list of words reads better packed
const BUILTIN_TYPES = new Set([
  "string", "number", "boolean", "symbol", "bigint", "object", "void", "never", "null", "undefined", "Array", "{}",
  "int", "str", "float", "bool", "bytes", "list", "dict", "set", "tuple", "frozenset", "None",
]);
/** Built-in types whose values hold other values, which may well be the project's own. */
// biome-ignore format: a list of words reads better packed
const CONTAINER_TYPES = new Set([
  "Array", "ReadonlyArray", "Map", "ReadonlyMap", "WeakMap", "Set", "ReadonlySet", "WeakSet", "Promise", "Iterable",
  "IterableIterator", "AsyncIterable", "Iterator", "Generator", "AsyncGenerator", "Record", "Partial", "Readonly",
  "Required", "list", "dict", "set", "frozenset", "tuple", "Sequence", "Mapping", "Iterable", "Optional",
]);
/** Folders whose code exists for the tests, by name. */
const TEST_SUPPORT_DIRS = new Set([
  "testing",
  "test-utils",
  "testutils",
  "test_utils",
  "__mocks__",
  "__fixtures__",
  "fixtures",
  "spec",
]);

/**
 * What a receiver turned out to be: one of the project's types, a type from
 * outside it, one of the built-in types that hold other values (whose contents
 * may be the project's), or not known.
 */
type HintedType = GraphNode | "external" | "container" | "unknown";

/**
 * The plain name a call's receiver ends with, as a compiler index would see it before the
 * dot: `queue` for `queue` and for `this.queue`; "" when the receiver is not that simple.
 */
function receiverName(qualifier: string | null | undefined): string {
  if (!qualifier) return "";
  const plain = qualifier.startsWith(UNKNOWN_PREFIX) ? qualifier.slice(1) : qualifier;
  return /^[\p{L}\p{N}_$.]+$/u.test(plain) ? plain.slice(plain.lastIndexOf(".") + 1) : "";
}

/** `): Store`, `): Promise<Store>`, `-> Store`, Go's `func New() *Store`: the type a signature says is returned. */
function returnTypeOf(signature: string | null): string | null {
  if (!signature) return null;
  const match =
    /\)\s*:\s*(?:Promise\s*<\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(signature) ??
    /->\s*(?:Optional\[\s*)?([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/.exec(signature) ??
    // Go: after the parameters, the first result: `*Mux` in `func (mx *Mux) With(...) *Mux` or `(*Mux, error)`.
    /^func\s*(?:\([^()]*\)\s*)?\w+\s*(?:\[[^\]]*\])?\s*\((?:[^()]|\([^()]*\))*\)\s*\(?\s*\*?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/.exec(
      signature,
    );
  return match ? match[1]! : null;
}
const TYPE_KINDS = new Set(["class", "interface", "type"]);
const CHUNK = 40;

function familyOf(language: string | null | undefined): string | undefined {
  return specFor(language)?.family;
}

/** `a/b.go#Cart.Add` -> `Cart.Add`. */
function qnameOf(node: GraphNode): string {
  const hash = node.id.indexOf("#");
  return hash < 0 ? node.name : node.id.slice(hash + 1);
}

/**
 * Turns the raw references and imports stored for each file into edges.
 * Always works per origin file: a file's derived edges are deleted and rebuilt
 * as a unit, which is what makes incremental updates safe.
 */
export class Resolver {
  private files = new Map<string, FileRecord>();
  private ctx: ResolveContext = {
    hasFile: () => false,
    packages: new Map(),
    filesIn: () => [],
    filesInPackage: () => [],
    packageOf: () => null,
    filesNamed: () => [],
    read: () => null,
    memo: (_key, make) => make(),
  };
  private basenames: Map<string, string[]> | null = null;
  /** Lookups that cannot change while one resolve runs, since it only writes edges. */
  private readonly levelCache = new Map<string, GraphNode | null>();
  private readonly namedCache = new Map<string, GraphNode[]>();
  private readonly stepCache = new Map<string, boolean>();
  private readonly reexportCache = new Map<string, { file: string; names: ResolvedImport["names"] }[]>();
  /** The name-only guesses made for each file in this run, and how each name was written. */
  private readonly guesses = new Map<
    string,
    { src: string; kind: EdgeKind; dst: string; name: string; member: boolean; receiver: string }[]
  >();
  private readonly fileSets = new WeakMap<string[], Set<string>>();
  /** The symbols of the file being resolved, for lookups made once per reference. */
  private fileNodes: { path: string; byId: Map<string, GraphNode> } | null = null;

  constructor(
    private readonly store: GraphStore,
    private readonly root: string,
  ) {}

  async resolve(paths: Iterable<string>, onProgress?: (fraction: number) => void): Promise<number> {
    this.files = this.store.allFiles();
    this.basenames = null;
    this.stepCache.clear();
    this.reexportCache.clear();
    this.levelCache.clear();
    this.namedCache.clear();
    this.guesses.clear();
    this.fileNodes = null;
    this.ctx = this.buildContext();

    const list = [...new Set(paths)].filter((p) => this.files.has(p));
    const scopes = new Map<string, FileScope>();
    const total = list.length * 2 || 1;
    let done = 0;

    // Pass 1: imports and inheritance, so pass 2 can look methods up through base classes.
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      this.store.tx(() => {
        for (const path of chunk) {
          const scope = this.resolveImports(path);
          scopes.set(path, scope);
          this.resolveRefs(path, scope, true);
          this.resolveFields(path, scope);
        }
      });
      done += chunk.length;
      onProgress?.(done / total);
      await yieldToEventLoop();
    }
    // Pass 2: calls, references, doc links and mentions.
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      this.store.tx(() => {
        for (const path of chunk) {
          this.resolveRefs(path, scopes.get(path)!, false);
          this.applyCompilerFacts(path);
        }
      });
      done += chunk.length;
      onProgress?.(done / total);
      await yieldToEventLoop();
    }
    // Go types implement interfaces without saying so; any Go change can add or remove one.
    if (list.some((path) => this.files.get(path)?.language === "go")) {
      this.store.tx(() => linkImplicitInterfaces(this.store));
    }
    // What was looked up for this run is not needed until the next one, and can be large.
    this.levelCache.clear();
    this.namedCache.clear();
    this.stepCache.clear();
    this.reexportCache.clear();
    this.guesses.clear();
    this.fileNodes = null;
    return list.length;
  }

  private buildContext(): ResolveContext {
    const byDir = new Map<string, string[]>();
    const byPackage = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, path: string) => {
      const list = map.get(key);
      if (list) list.push(path);
      else map.set(key, [path]);
    };
    for (const [path, record] of this.files) {
      push(byDir, posixDirname(path), path);
      if (record.package) push(byPackage, record.package, path);
    }
    const memo = new Map<string, unknown>();
    return {
      hasFile: (p) => this.files.has(p),
      packages: this.loadPackages(),
      filesIn: (dir) => byDir.get(dir) ?? [],
      filesInPackage: (name) => byPackage.get(name) ?? [],
      packageOf: (p) => this.files.get(p)?.package ?? null,
      filesNamed: (base) => this.filesByBasename().get(base) ?? [],
      read: (p) => {
        try {
          return decodeText(readFileSync(join(this.root, p)));
        } catch {
          return null;
        }
      },
      memo: <T>(key: string, make: () => T): T => {
        if (!memo.has(key)) memo.set(key, make());
        return memo.get(key) as T;
      },
    };
  }

  private loadPackages(): Map<string, string> {
    const out = new Map<string, string>();
    for (const path of this.files.keys()) {
      if (posixBasename(path) !== "package.json") continue;
      try {
        const json = JSON.parse(readFileSync(join(this.root, path), "utf8")) as { name?: unknown };
        if (typeof json.name === "string") out.set(json.name, posixDirname(path));
      } catch {
        // unreadable or invalid manifest: not a workspace package we can resolve
      }
    }
    return out;
  }

  // ------------------------------------------------------------ imports

  private resolveImports(path: string): FileScope {
    this.store.deleteDerivedEdges(path);
    const scope: FileScope = {
      bindings: new Map(),
      wildcards: [],
      ambient: new Set(),
      importedFiles: new Set(),
      tested: new Set(),
    };
    const file = this.files.get(path)!;
    const spec = specFor(file.language);
    if (!spec) return scope;

    for (const imp of this.store.importsOf(path)) {
      for (const resolved of spec.resolveImport(imp, path, this.ctx)) {
        const files = resolved.files ?? (resolved.file ? [resolved.file] : null);
        if (files) {
          if (resolved.file) {
            if (resolved.file !== path) {
              this.addEdge(path, resolved.file, "imports", "exact", path, imp.line, 1);
              if (file.subkind === "test" && this.files.get(resolved.file)?.subkind !== "test") {
                this.addEdge(path, resolved.file, "tests", "resolved", path, imp.line, 1);
                scope.tested.add(resolved.file);
              }
            }
          } else if (resolved.dir !== undefined) {
            // A package rather than a file: the import is drawn to its directory.
            const dir = dirId(resolved.dir);
            if (this.store.hasNode(dir)) this.addEdge(path, dir, "imports", "exact", path, imp.line, 1);
          }
          for (const f of files) if (f !== path) scope.importedFiles.add(f);
          for (const name of resolved.names) {
            if (name.local === "*") scope.wildcards.push(...files);
            else scope.bindings.set(name.local, { files, imported: name.imported });
          }
        } else {
          if (resolved.external) {
            const ext = resolved.external;
            this.store.ensureExternal(ext.id, ext.name, ext.ecosystem);
            this.addEdge(path, ext.id, "imports", "exact", path, imp.line, 1);
          }
          for (const name of resolved.names) {
            if (name.local !== "*") scope.bindings.set(name.local, { files: null, imported: name.imported });
          }
        }
      }
    }
    if (spec.ambient) {
      for (const other of spec.ambient(path, this.ctx)) if (other !== path) scope.ambient.add(other);
    }
    return scope;
  }

  // --------------------------------------------------------------- refs

  private resolveRefs(path: string, scope: FileScope, inheritancePass: boolean): void {
    const file = this.files.get(path)!;
    const spec = specFor(file.language);
    for (const ref of this.store.refsOf(path)) {
      const isInheritance = ref.kind === "extends" || ref.kind === "implements";
      if (isInheritance !== inheritancePass) continue;
      let target: Target | null = null;
      if (ref.kind === "mentions") target = this.resolveMention(ref, path);
      else if (ref.kind === "links_to") target = this.resolveLink(ref, path);
      else if (spec) target = this.resolveCodeRef(ref, path, scope, spec);
      if (spec?.prototypes && target) target = this.definitionOf(target) ?? target;
      if (!target || target.id === ref.src) continue;
      let kind = EDGE_KIND[ref.kind];
      if (ref.kind === "extends" && spec?.basesByTarget && this.store.getNode(target.id)?.kind === "interface") {
        // A class with an interface among its bases implements it; an interface extends its bases.
        if (this.store.getNode(ref.src)?.kind !== "interface") kind = "implements";
      }
      this.addEdge(ref.src, target.id, kind, target.confidence, path, ref.line, ref.count);
      if (target.confidence === "heuristic" && spec) {
        const guess = {
          src: ref.src,
          kind,
          dst: target.id,
          name: ref.name,
          member: Boolean(ref.qualifier),
          receiver: receiverName(ref.qualifier),
        };
        const list = this.guesses.get(path);
        if (list) list.push(guess);
        else this.guesses.set(path, [guess]);
      }

      // Where code reaches the rest of its package without importing it, a test's
      // subjects are found from what it actually uses.
      if (spec?.ambient && file.subkind === "test" && target.confidence !== "heuristic") {
        const hash = target.id.indexOf("#");
        const targetFile = hash < 0 ? target.id : target.id.slice(0, hash);
        const other = this.files.get(targetFile);
        if (other && targetFile !== path && other.subkind !== "test" && !scope.tested.has(targetFile)) {
          scope.tested.add(targetFile);
          this.addEdge(path, targetFile, "tests", "resolved", path, ref.line, 1);
        }
      }
    }
  }

  /**
   * Where a compiler-backed index covers a file, and the file is unchanged
   * since that index was built, its relationships are facts. They confirm or
   * add to what syntax found, and a guess by name is dropped where the compiler
   * resolved that name, in that scope, to something else. Where the compiler
   * has no opinion (a value of unknown type), the guess stays a guess.
   */
  private applyCompilerFacts(path: string): void {
    if (!this.inStep(path)) return;
    // Inheritance first, so a plain mention of a base type in the class header is not drawn a second time.
    const facts = this.store
      .scipFactsOf(path)
      .sort((a, b) => Number(b.kind !== "references") - Number(a.kind !== "references"));
    /** Pairs the compiler connects, whatever the kind of relationship. */
    const connected = new Set<string>();
    for (const fact of facts) {
      // A fact joins two files; it holds only while both are as the index saw them.
      const hash = fact.dst.indexOf("#");
      if (!this.inStep(hash < 0 ? fact.dst : fact.dst.slice(0, hash))) continue;
      if (!this.store.hasNode(fact.src) || !this.store.hasNode(fact.dst)) continue;
      connected.add(`${fact.src}\u0000${fact.dst}`);
      if (fact.kind === "references" && this.store.inherits(fact.src, fact.dst)) continue;
      this.store.addExactEdge({
        src: fact.src,
        dst: fact.dst,
        kind: fact.kind,
        weight: fact.count,
        originFile: path,
        line: fact.line,
      });
    }
    const guesses = this.guesses.get(path);
    if (!guesses) return;
    const settled = this.store.scipSettled(path);
    // One edge can stand for several calls (`a.save()` and `b.save()`): it goes only when every one was resolved elsewhere.
    const byEdge = new Map<string, typeof guesses>();
    for (const guess of guesses) {
      const key = `${guess.src}\u0000${guess.kind}\u0000${guess.dst}`;
      const list = byEdge.get(key);
      if (list) list.push(guess);
      else byEdge.set(key, [guess]);
    }
    for (const list of byEdge.values()) {
      const { src, kind, dst } = list[0]!;
      if (connected.has(`${src}\u0000${dst}`)) this.store.confirmGuess(src, kind, dst);
      else if (list.every((g) => settled.has(`${g.src}\u0000${g.name}\u0000${g.member ? 1 : 0}\u0000${g.receiver}`))) {
        this.store.deleteGuess(src, kind, dst);
      }
    }
  }

  /** True when a compiler index describes the file and its content is still what the index saw. */
  private inStep(path: string): boolean {
    let known = this.stepCache.get(path);
    if (known === undefined) {
      const hash = this.store.scipHashOf(path);
      known = hash !== null && hash === this.files.get(path)?.hash;
      this.stepCache.set(path, known);
    }
    return known;
  }

  private addEdge(
    src: string,
    dst: string,
    kind: EdgeKind,
    confidence: Confidence,
    originFile: string,
    line: number,
    weight: number,
  ): void {
    this.store.addEdge({ src, dst, kind, weight, confidence, originFile, line });
  }

  private resolveCodeRef(ref: RawRef, path: string, scope: FileScope, spec: LanguageSpec): Target | null {
    const resolved = (node: GraphNode | null): Target | null => (node ? { id: node.id, confidence: "resolved" } : null);
    const qualifier = ref.qualifier;

    if (qualifier) {
      if (qualifier.startsWith(TYPED_PREFIX)) {
        // The receiver's type is known: it has this member, or nothing is drawn.
        const type = this.hintedType(qualifier.slice(TYPED_PREFIX.length), ref, path, scope, spec, 0);
        if (type === "unknown") return this.heuristicMember(ref, path, scope, spec);
        return type === "external" || type === "container" ? null : resolved(this.member(type, ref.name, 0));
      }
      if (qualifier.startsWith(UNKNOWN_PREFIX) && qualifier.length > 1) {
        // A chain whose start is a third-party value says nothing about the project's methods.
        return this.rootIsExternal(qualifier.slice(1), ref, path, scope, spec)
          ? null
          : this.heuristicMember(ref, path, scope, spec);
      }
      const isSelf = qualifier === SELF_QUALIFIER || spec.selfNames.has(qualifier);
      if (qualifier === "super" || isSelf) {
        const cls = this.enclosingClass(ref.src);
        if (cls && qualifier === "super") {
          for (const edge of this.store.edgesFrom(cls.id, "extends")) {
            const base = this.store.getNode(edge.dst);
            const member = base ? this.member(base, ref.name, 0) : null;
            if (member) return resolved(member);
          }
          return null;
        }
        const member = cls ? this.member(cls, ref.name, 0) : null;
        if (member) return resolved(member);
        // `this.x()` inside a class is that class's own `x`, or one it inherits: never another class's.
        return qualifier === "super" || cls ? null : this.heuristicMember(ref, path, scope, spec);
      }
      if (qualifier !== "?") {
        const binding = scope.bindings.get(qualifier);
        if (binding) {
          if (binding.files === null) return null;
          if (binding.imported === "*") return resolved(this.exportedFrom(binding.files, ref.name));
          const owner = this.exportedFrom(binding.files, binding.imported);
          return owner ? resolved(this.member(owner, ref.name, 0)) : null;
        }
        const type = this.typeNamed(qualifier, path, scope, ref.src);
        if (type) return resolved(this.member(type, ref.name, 0));
        // `Promise.all()`, `JSON.parse()`: the language's own objects, unless the file defines that name itself.
        if (spec.globals?.has(qualifier) && !this.visible(qualifier, path, scope)) return null;
        const moduleFile = spec.resolveQualifier?.(qualifier, path, this.ctx);
        if (moduleFile) return resolved(this.findExported(moduleFile, ref.name));
        // `path.posix.join(...)`: the receiver hangs off a third-party module.
        const head = qualifier.split(".")[0]!;
        if (head !== qualifier && scope.bindings.get(head)?.files === null) return null;
        // `shop::total()`: a namespace, which is no scope of its own here.
        if (spec.namespaceQualifiers) {
          const bare = this.visible(ref.name, path, scope);
          if (bare) return resolved(bare);
        }
        // `env_->RemoveFile()` in a method body: a field of the method's own class, written without `this`.
        if (spec.implicitSelf && !qualifier.includes(".")) {
          const cls = this.enclosingClass(ref.src);
          const field = cls ? this.fieldType(cls, qualifier, 0) : "unknown";
          if (field === "external" || field === "container") return null;
          if (field !== "unknown") return resolved(this.member(field, ref.name, 0));
        }
        // `Task.Run()`, `String::from()`, `File.stat`: a capitalised receiver is a type, and one the
        // project never defines is a library's, whose methods are not the project's. (Go is left out:
        // there a capital starts any exported name, variables included.)
        const typeLike = qualifier.replace(/^\.+/, "");
        if (spec.family !== "go" && /^[A-Z]\w*$/.test(typeLike) && !this.projectHasType(typeLike, spec.family)) {
          return null;
        }
      }
      return this.heuristicMember(ref, path, scope, spec);
    }

    // A bare call inside a class may be to one of its own methods, inherited ones included.
    if (spec.implicitSelf && ref.kind === "calls") {
      const cls = this.enclosingClass(ref.src);
      const member = cls ? this.member(cls, ref.name, 0) : null;
      if (member) return resolved(member);
    }
    // A function defined inside the calling function, or inside one around it.
    if (spec.nestedDefs) {
      const local = this.nestedVisible(ref.src, path, ref.name);
      if (local) return resolved(local);
    }
    // Otherwise a bare name is something defined in this file, imported into it, or in its package.
    const bare = this.visible(ref.name, path, scope);
    if (bare || !spec.globalTypes || ref.kind === "calls") return resolved(bare);
    return resolved(this.globalType(ref.name, path, ref.src));
  }

  /**
   * A bare name defined inside one of the functions that enclose `src`, innermost first.
   * Class bodies are not scopes for bare names, so the walk stops at one.
   */
  private nestedVisible(src: string, path: string, name: string): GraphNode | null {
    // Every bare call asks, so the file's symbols are read once and walked in memory.
    if (this.fileNodes?.path !== path) {
      this.fileNodes = { path, byId: new Map(this.store.nodesInFile(path).map((n) => [n.id, n])) };
    }
    const byId = this.fileNodes.byId;
    let node = byId.get(src);
    for (let i = 0; node && i < 8; i++) {
      if (TYPE_KINDS.has(node.kind)) return null;
      if (node.kind === "function" || node.kind === "method" || node.kind === "variable") {
        const inner = byId.get(`${node.id}.${name}`);
        if (inner) return inner;
      }
      node = node.parent ? byId.get(node.parent) : undefined;
    }
    return null;
  }

  /** What a bare name means in a file: its own symbols, then imports, then the rest of the package. */
  private visible(name: string, path: string, scope: FileScope): GraphNode | null {
    const local = this.fileLevel(path, name);
    if (local) return local;
    const binding = scope.bindings.get(name);
    if (binding) {
      if (binding.files === null || binding.imported === "*") return null;
      return this.exportedFrom(binding.files, binding.imported);
    }
    for (const wildcard of scope.wildcards) {
      const hit = this.findExported(wildcard, name);
      if (hit) return hit;
    }
    if (scope.ambient.size > 0) {
      for (const node of this.named(name)) {
        if (node.parent === node.path && scope.ambient.has(node.path)) return node;
      }
    }
    return null;
  }

  /** A class, interface or other named type visible in a file, by plain or `package.Type` name. */
  private typeNamed(name: string, path: string, scope: FileScope, src?: string): GraphNode | null {
    let node: GraphNode | null = null;
    const dot = name.indexOf(".");
    if (dot > 0) {
      const binding = scope.bindings.get(name.slice(0, dot));
      const rest = name.slice(dot + 1);
      if (binding?.files && binding.imported === "*" && !rest.includes("."))
        node = this.exportedFrom(binding.files, rest);
    } else {
      node = this.visible(name, path, scope);
    }
    if (node && TYPE_KINDS.has(node.kind)) return node;
    return specFor(this.files.get(path)?.language)?.globalTypes ? this.globalType(name, path, src) : null;
  }

  /**
   * A class or module by its full name, wherever it is defined (Ruby's constants):
   * `Shop.Cart` for `Shop::Cart`. A name written inside `module Shop` is looked for in
   * Shop first, then outside it, the way Ruby does. Of a module reopened in several files,
   * any one will do: {@link member} looks through them all.
   */
  private globalType(written: string, path: string, src?: string): GraphNode | null {
    const name = written.replace(/^\.+/, ""); // `::Rack::Utils` starts from the top level
    const family = familyOf(this.files.get(path)?.language);
    const last = name.slice(name.lastIndexOf(".") + 1);
    const types = this.named(last).filter((n) => TYPE_KINDS.has(n.kind) && familyOf(n.language) === family);
    const byQname = (qname: string) => types.find((n) => qnameOf(n) === qname) ?? null;
    if (src?.includes("#")) {
      const nesting = qnameOf(this.store.getNode(src) ?? ({ id: src } as GraphNode)).split(".");
      for (let i = nesting.length - 1; i > 0; i--) {
        const hit = byQname(`${nesting.slice(0, i).join(".")}.${name}`);
        if (hit) return hit;
      }
    }
    return byQname(name);
  }

  /**
   * The type a receiver hint stands for: `Store` (a type written down), `()receiver name`
   * (whatever that call returns), `.>receiver name` (that field of the receiver) or `@self`.
   */
  private hintedType(
    hint: string,
    ref: RawRef,
    path: string,
    scope: FileScope,
    spec: LanguageSpec,
    depth: number,
  ): HintedType {
    if (depth > 6) return "unknown";
    if (hint.startsWith("()")) return this.callResultType(hint.slice(2), ref, path, scope, spec, depth);
    if (hint.startsWith(".>")) return this.fieldResultType(hint.slice(2), ref, path, scope, spec, depth);
    if (hint === SELF_QUALIFIER) return this.enclosingClass(ref.src) ?? "unknown";
    const type = BUILTIN_TYPES.has(hint) ? null : this.typeNamed(hint, path, scope);
    return type ?? (CONTAINER_TYPES.has(hint) ? "container" : "external");
  }

  /** What a receiver expression in a hint is: a typed hint, `@self`, an imported module or a type used statically. */
  private exprType(
    expr: string,
    ref: RawRef,
    path: string,
    scope: FileScope,
    spec: LanguageSpec,
    depth: number,
  ): HintedType {
    if (expr.startsWith(TYPED_PREFIX))
      return this.hintedType(expr.slice(TYPED_PREFIX.length), ref, path, scope, spec, depth + 1);
    if (expr === SELF_QUALIFIER || spec.selfNames.has(expr)) return this.enclosingClass(ref.src) ?? "unknown";
    if (scope.bindings.get(expr)?.files === null) return "external";
    return this.typeNamed(expr, path, scope) ?? "unknown";
  }

  /** The type of a field of a receiver: `receiver name`. */
  private fieldResultType(
    body: string,
    ref: RawRef,
    path: string,
    scope: FileScope,
    spec: LanguageSpec,
    depth: number,
  ): HintedType {
    const space = body.lastIndexOf(" ");
    if (space < 0) return "unknown";
    const owner = this.exprType(body.slice(0, space), ref, path, scope, spec, depth);
    if (owner === "unknown") return "unknown";
    // A field of a library value is the library's; one of a Map or array is not known.
    if (owner === "external") return "external";
    if (owner === "container") return "unknown";
    return this.fieldType(owner, body.slice(space + 1), 0);
  }

  /** What is on record about a field of a type, looking through the types it extends. */
  private fieldType(owner: GraphNode, name: string, depth: number): HintedType {
    const resolved = this.store.fieldOf(owner.id, name);
    if (resolved !== undefined) {
      if (resolved === null) return "unknown";
      if (resolved === "!") return "external";
      if (resolved === "!c") return "container";
      return this.store.getNode(resolved) ?? "unknown";
    }
    if (depth >= 4) return "unknown";
    for (const edge of this.store.edgesFrom(owner.id, "extends")) {
      const base = this.store.getNode(edge.dst);
      if (!base) continue;
      const type = this.fieldType(base, name, depth + 1);
      if (type !== "unknown") return type;
    }
    return "unknown";
  }

  /** Work out the types of a file's fields in that file's scope, where their names mean what the file says. */
  private resolveFields(path: string, scope: FileScope): void {
    const spec = specFor(this.files.get(path)?.language);
    if (!spec) return;
    for (const field of this.store.fieldsOf(path)) {
      const ref: RawRef = {
        src: field.owner,
        kind: "references",
        name: field.name,
        qualifier: null,
        line: 0,
        count: 1,
      };
      const type = this.hintedType(field.type, ref, path, scope, spec, 0);
      const resolved = type === "unknown" ? null : type === "external" ? "!" : type === "container" ? "!c" : type.id;
      this.store.setFieldResolved(field.owner, field.name, resolved);
    }
  }

  /** The type of `callee()`'s result, from the return type its signature declares. */
  private callResultType(
    callee: string,
    ref: RawRef,
    path: string,
    scope: FileScope,
    spec: LanguageSpec,
    depth: number,
  ): HintedType {
    const space = callee.lastIndexOf(" ");
    const receiver = space < 0 ? null : callee.slice(0, space);
    const name = space < 0 ? callee : callee.slice(space + 1);
    let target: GraphNode | null = null;
    if (receiver === null) {
      target = this.visible(name, path, scope);
      if (!target && scope.bindings.get(name)?.files === null) return "external";
    } else if (receiver.startsWith(TYPED_PREFIX) || receiver === SELF_QUALIFIER || spec.selfNames.has(receiver)) {
      const type = this.exprType(receiver, ref, path, scope, spec, depth);
      // What comes out of a Map or an array may be one of the project's own values.
      if (type === "container") return "unknown";
      if (type === "external" || type === "unknown") return type;
      target = this.member(type, name, 0);
    } else {
      const binding = scope.bindings.get(receiver);
      if (binding?.files === null) return "external";
      if (binding?.imported === "*") target = this.exportedFrom(binding.files!, name);
      else {
        const owner = binding
          ? this.exportedFrom(binding.files!, binding.imported)
          : this.typeNamed(receiver, path, scope);
        target = owner ? this.member(owner, name, 0) : null;
      }
    }
    if (!target) return "unknown";
    // Calling a class makes an instance of it, as in Python.
    if (TYPE_KINDS.has(target.kind)) return target;
    const returned = returnTypeOf(target.signature ?? null);
    if (!returned) return "unknown";
    if (BUILTIN_TYPES.has(returned)) return "external";
    const owner = target.parent ? this.store.getNode(target.parent) : null;
    if (owner && TYPE_KINDS.has(owner.kind) && owner.name === returned) return owner;
    const local = this.fileLevel(target.path, returned);
    if (local && TYPE_KINDS.has(local.kind)) return local;
    const named = this.named(returned).filter((n) => TYPE_KINDS.has(n.kind) && familyOf(n.language) === spec.family);
    if (named.length === 1) return named[0]!;
    // A return type the project does not define is a library type.
    if (named.length === 0) return CONTAINER_TYPES.has(returned) ? "container" : "external";
    return "unknown";
  }

  /** True when an expression of unknown type starts from a third-party value or a value of a type outside the project. */
  private rootIsExternal(root: string, ref: RawRef, path: string, scope: FileScope, spec: LanguageSpec): boolean {
    if (root.startsWith(TYPED_PREFIX)) {
      return this.hintedType(root.slice(TYPED_PREFIX.length), ref, path, scope, spec, 0) === "external";
    }
    return scope.bindings.get(root)?.files === null;
  }

  /** Code that exists for the tests: test files, and helpers kept in folders such as `testing/` or `fixtures/`. */
  private isTestSupport(path: string): boolean {
    if (this.files.get(path)?.subkind === "test") return true;
    const segments = path.split("/");
    segments.pop();
    return segments.some((segment) => TEST_SUPPORT_DIRS.has(segment));
  }

  /** A method call on a receiver of unknown type: accept only an unambiguous name match. */
  private heuristicMember(ref: RawRef, path: string, scope: FileScope, spec: LanguageSpec): Target | null {
    if (ref.kind !== "calls") return null;
    if (ref.name.length < 3 || COMMON_MEMBER_NAMES.has(ref.name) || spec.commonMembers?.has(ref.name)) return null;
    // Ordinary code does not call into the tests' helpers.
    const fromTests = this.isTestSupport(path);
    const found = this.named(ref.name).filter(
      (n) => n.kind === "method" && familyOf(n.language) === spec.family && (fromTests || !this.isTestSupport(n.path)),
    );
    // Overloads of one method (`Send`, `Send~2`) are one candidate, and so are a C++
    // declaration and its definition: only the definition is kept.
    const base = (n: GraphNode) => qnameOf(n).replace(/~\d+$/, "");
    const defined = new Set(found.filter((n) => n.subkind !== "declaration").map(base));
    const distinct = new Map<string, GraphNode>();
    for (const n of found) {
      if (n.subkind === "declaration" && defined.has(base(n))) continue;
      const key = `${n.path}#${base(n)}`;
      if (!distinct.has(key)) distinct.set(key, n);
    }
    const candidates = [...distinct.values()];
    if (candidates.length === 1) return { id: candidates[0]!.id, confidence: "heuristic" };
    // Where everything is loaded everywhere (Ruby), an imported file does not single one out.
    if (candidates.length > 1 && !spec.globalTypes) {
      const near = candidates.filter(
        (c) => c.path === path || scope.importedFiles.has(c.path) || scope.ambient.has(c.path),
      );
      if (near.length === 1) return { id: near[0]!.id, confidence: "heuristic" };
    }
    return null;
  }

  /** Nodes with a name, remembered for the rest of the run. */
  private named(name: string): GraphNode[] {
    let nodes = this.namedCache.get(name);
    if (!nodes) {
      nodes = this.store.nodesNamed(name);
      this.namedCache.set(name, nodes);
    }
    return nodes;
  }

  private fileLevel(file: string, name: string): GraphNode | null {
    const key = `${file}\u0000${name}`;
    const cached = this.levelCache.get(key);
    if (cached !== undefined) return cached;
    const found = this.lookUpFileLevel(file, name);
    this.levelCache.set(key, found);
    return found;
  }

  private lookUpFileLevel(file: string, name: string): GraphNode | null {
    const row = this.store
      .stmt(
        `SELECT ${NODE_COLUMNS} FROM nodes
         WHERE parent = ? AND name = ? AND kind NOT IN ('section', 'file', 'directory')
         ORDER BY exported DESC LIMIT 1`,
      )
      .get(file, name);
    return row ? rowToNode(row) : null;
  }

  /** The symbol a set of files exposes under `name`; `Owner.member` reaches inside a type. */
  private exportedFrom(files: string[], name: string): GraphNode | null {
    const dot = name.indexOf(".");
    if (dot > 0) {
      let node = this.exportedFrom(files, name.slice(0, dot));
      for (const segment of name.slice(dot + 1).split(".")) node = node ? this.member(node, segment, 0) : null;
      return node;
    }
    if (files.length > 4) {
      // A large package: one lookup by name instead of one per file.
      let set = this.fileSets.get(files);
      if (!set) {
        set = new Set(files);
        this.fileSets.set(files, set);
      }
      for (const node of this.named(name)) {
        if (node.parent === node.path && set.has(node.path)) return node;
      }
      return null;
    }
    for (const file of files) {
      const hit = this.findExported(file, name);
      if (hit) return hit;
    }
    return null;
  }

  /** The symbol a module exposes under `name`, following re-exports. */
  private findExported(file: string, name: string, depth = 0, seen = new Set<string>()): GraphNode | null {
    if (name === "default") {
      const row = this.store
        .stmt(`SELECT ${NODE_COLUMNS} FROM nodes WHERE parent = ? AND exported = 2 LIMIT 1`)
        .get(file);
      if (row) return rowToNode(row);
    } else {
      const direct = this.fileLevel(file, name);
      if (direct) return direct;
    }
    if (depth >= 4 || seen.has(file)) return null;
    seen.add(file);

    for (const passed of this.reexportsOf(file)) {
      for (const n of passed.names) {
        if (n.local === name) {
          if (n.imported === "*") return this.store.getNode(passed.file);
          return this.findExported(passed.file, n.imported, depth + 1, seen);
        }
        if (n.local === "*" && n.imported === "*") {
          const hit = this.findExported(passed.file, name, depth + 1, seen);
          if (hit) return hit;
        }
      }
    }
    return null;
  }

  /**
   * The imports through which a file passes names on (re-exports, every import in Python,
   * every include in C), resolved once per run: lookups through a chain of C++ includes ask
   * for the same files over and over.
   */
  private reexportsOf(file: string): { file: string; names: ResolvedImport["names"] }[] {
    let list = this.reexportCache.get(file);
    if (list) return list;
    list = [];
    const spec = specFor(this.files.get(file)?.language);
    for (const imp of spec ? this.store.importsOf(file) : []) {
      if (!imp.reexport && !spec!.importsAreExports) continue;
      for (const resolved of spec!.resolveImport(imp, file, this.ctx)) {
        if (resolved.file) list.push({ file: resolved.file, names: resolved.names });
      }
    }
    this.reexportCache.set(file, list);
    return list;
  }

  /** A member of a class, looking through base classes resolved so far. */
  private member(owner: GraphNode, name: string, depth: number): GraphNode | null {
    const direct = this.store.getNode(`${owner.id}.${name}`);
    if (direct) return direct;
    const outside = this.memberWrittenOutside(owner, name);
    if (outside) return outside;
    const reopened = this.reopenings(owner);
    for (const other of reopened) {
      const found = this.store.getNode(`${other.id}.${name}`);
      if (found) return found;
    }
    if (depth >= 4) return null;
    for (const part of [owner, ...reopened]) {
      for (const edge of this.store.edgesFrom(part.id, "extends")) {
        if (edge.dst === part.id) continue;
        const base = this.store.getNode(edge.dst);
        const inherited = base ? this.member(base, name, depth + 1) : null;
        if (inherited) return inherited;
      }
    }
    return null;
  }

  /** True when some class, interface or type of this name exists anywhere in the project, in this language family. */
  private projectHasType(name: string, family: string): boolean {
    return this.named(name).some((n) => TYPE_KINDS.has(n.kind) && familyOf(n.language) === family);
  }

  /** The other places a Ruby class or module is opened: same full name, other files. */
  private reopenings(type: GraphNode): GraphNode[] {
    if (!specFor(type.language)?.globalTypes) return [];
    const qname = qnameOf(type);
    return this.named(type.name).filter(
      (n) => n.id !== type.id && TYPE_KINDS.has(n.kind) && n.language === type.language && qnameOf(n) === qname,
    );
  }

  /**
   * A method written outside its type and in another file: a Go method, a Rust
   * `impl` block. Those hang off their file, with the type's name in their id.
   */
  private memberWrittenOutside(owner: GraphNode, name: string): GraphNode | null {
    const suffix = `#${qnameOf(owner)}.${name}`;
    const family = familyOf(owner.language);
    const dir = posixDirname(owner.path);
    let only: GraphNode | null = null;
    let count = 0;
    for (const node of this.named(name)) {
      if (node.kind !== "method" || node.parent !== node.path || !node.id.endsWith(suffix)) continue;
      if (familyOf(node.language) !== family) continue;
      if (posixDirname(node.path) === dir) return node;
      only = node;
      count++;
    }
    return count === 1 ? only : null;
  }

  private enclosingClass(id: string): GraphNode | null {
    let node = this.store.getNode(id);
    for (let i = 0; node && i < 8; i++) {
      if (TYPE_KINDS.has(node.kind) && node.kind !== "type") return node;
      if (node.kind === "type" && i > 0) return node;
      if (node.kind === "file" || !node.parent) return null;
      if (node.parent === node.path) return this.ownerWrittenElsewhere(node);
      node = this.store.getNode(node.parent);
    }
    return null;
  }

  /**
   * The one definition of a function or method declared without a body (a C or C++
   * prototype), when there is exactly one; overloads and same-named statics leave the
   * use at the declaration.
   */
  private definitionOf(target: Target): Target | null {
    const node = this.store.getNode(target.id);
    if (node?.subkind !== "declaration") return null;
    const base = (n: GraphNode) => qnameOf(n).replace(/~\d+$/, "");
    const qname = base(node);
    const family = familyOf(node.language);
    const found = this.named(node.name).filter(
      (n) =>
        n.id !== node.id &&
        n.subkind !== "declaration" &&
        (n.kind === "function" || n.kind === "method") &&
        base(n) === qname &&
        familyOf(n.language) === family,
    );
    return found.length === 1 ? { id: found[0]!.id, confidence: target.confidence } : null;
  }

  /** The type a method belongs to when the two are in different files of a package. */
  private ownerWrittenElsewhere(method: GraphNode): GraphNode | null {
    const qname = qnameOf(method);
    const dot = qname.lastIndexOf(".");
    if (dot <= 0) return null;
    const ownerQname = qname.slice(0, dot);
    const family = familyOf(method.language);
    const dir = posixDirname(method.path);
    let only: GraphNode | null = null;
    let count = 0;
    for (const node of this.named(ownerQname.slice(ownerQname.lastIndexOf(".") + 1))) {
      if (!TYPE_KINDS.has(node.kind) || qnameOf(node) !== ownerQname || familyOf(node.language) !== family) continue;
      if (posixDirname(node.path) === dir) return node;
      only = node;
      count++;
    }
    return count === 1 ? only : null;
  }

  // --------------------------------------------------------------- docs

  private resolveLink(ref: RawRef, path: string): Target | null {
    const raw = ref.name;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null; // external URL
    const hash = raw.indexOf("#");
    let target = hash < 0 ? raw : raw.slice(0, hash);
    const anchor = hash < 0 ? "" : raw.slice(hash + 1).toLowerCase();
    try {
      target = decodeURIComponent(target);
    } catch {
      // keep the raw text
    }
    target = toPosix(target.split("?")[0]!);

    if (target === "") {
      const id = `${path}#${anchor}`;
      return anchor && this.store.hasNode(id) ? { id, confidence: "exact" } : null;
    }
    const resolved = target.startsWith("/") ? posixJoin(target.slice(1)) : posixJoin(posixDirname(path), target);
    if (resolved === null) return null;
    if (this.files.has(resolved)) {
      const sectionId = `${resolved}#${anchor}`;
      if (anchor && this.store.hasNode(sectionId)) return { id: sectionId, confidence: "exact" };
      return { id: resolved, confidence: "exact" };
    }
    const directory = dirId(resolved);
    return this.store.hasNode(directory) ? { id: directory, confidence: "exact" } : null;
  }

  private filesByBasename(): Map<string, string[]> {
    if (!this.basenames) {
      this.basenames = new Map();
      for (const path of this.files.keys()) {
        const base = posixBasename(path);
        const list = this.basenames.get(base);
        if (list) list.push(path);
        else this.basenames.set(base, [path]);
      }
    }
    return this.basenames;
  }

  /** A code span in prose: a file path if one matches, otherwise a uniquely named symbol. */
  private resolveMention(ref: RawRef, path: string): Target | null {
    const full = toPosix(ref.qualifier ?? ref.name).replace(/\/$/, "");

    if (this.files.has(full)) return { id: full, confidence: "resolved" };
    const relative = posixJoin(posixDirname(path), full);
    if (relative !== null && this.files.has(relative)) return { id: relative, confidence: "resolved" };
    if (full.includes("/") && this.store.hasNode(dirId(full))) return { id: dirId(full), confidence: "resolved" };
    const sameName = this.filesByBasename().get(posixBasename(full)) ?? [];
    const bySuffix = sameName.filter((p) => p === full || p.endsWith(`/${full}`));
    if (bySuffix.length === 1) return { id: bySuffix[0]!, confidence: "heuristic" };
    if (full.includes("/")) return null;

    const segments = full.split(/[.#:]+/).filter(Boolean);
    const name = segments[segments.length - 1];
    if (!name) return null;
    let candidates = this.named(name).filter((n) => SYMBOL_KINDS.has(n.kind));
    if (segments.length > 1) {
      // `Class.method`, or failing that `module.symbol`.
      const owner = segments[segments.length - 2]!;
      const qualified = `${owner}.${name}`;
      const members = candidates.filter((n) => {
        const qname = n.id.slice(n.id.indexOf("#") + 1);
        return qname === qualified || qname.endsWith(`.${qualified}`);
      });
      candidates =
        members.length > 0
          ? members
          : candidates.filter((n) => n.parent === n.path && posixBasename(n.path).startsWith(`${owner}.`));
    }
    if (candidates.length === 1) return { id: candidates[0]!.id, confidence: "heuristic" };
    const topLevel = candidates.filter((n) => n.exported > 0 && n.parent === n.path);
    return topLevel.length === 1 ? { id: topLevel[0]!.id, confidence: "heuristic" } : null;
  }
}
