import { readFileSync } from "node:fs";
import { join } from "node:path";
import { specFor } from "../extract/index.js";
import type { LanguageSpec, ResolveContext } from "../extract/spec.js";
import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import {
  SELF_QUALIFIER,
  TYPED_PREFIX,
  type Confidence,
  type EdgeKind,
  type FileRecord,
  type GraphNode,
  type RawRef,
  type RefKind,
} from "../types.js";
import { dirId, posixBasename, posixDirname, posixJoin, toPosix, yieldToEventLoop } from "../util.js";

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
const COMMON_MEMBER_NAMES = new Set([
  "get", "set", "has", "add", "delete", "clear", "keys", "values", "entries", "items", "forEach", "map", "filter",
  "reduce", "find", "some", "every", "includes", "indexOf", "push", "pop", "shift", "unshift", "slice", "splice",
  "concat", "join", "split", "sort", "reverse", "flat", "flatMap", "then", "catch", "finally", "toString",
  "valueOf", "toJSON", "trim", "replace", "replaceAll", "match", "test", "exec", "startsWith", "endsWith", "append",
  "extend", "update", "remove", "insert", "copy", "format", "strip", "lower", "upper", "encode", "decode", "read",
  "write", "close", "open", "send", "emit", "on", "off", "once", "call", "apply", "bind", "log", "warn", "error",
  "info", "debug", "parse", "stringify", "next", "run", "start", "stop", "init", "render", "dispose", "destroy",
  "connect", "disconnect", "save", "load", "create", "exists", "resolve", "reject", "count", "index", "length",
  // the same idea in languages that capitalise or snake-case their standard library
  "String", "Error", "Equals", "ToString", "GetHashCode", "Close", "Read", "Write", "Len", "unwrap", "expect",
  "clone", "into", "iter", "collect", "to_string", "as_str", "is_empty", "len", "equals", "hashCode", "size",
  "isEmpty", "contains", "Contains", "ToList", "ToArray", "Dispose",
]);

const SYMBOL_KINDS = new Set(["class", "interface", "function", "method", "variable", "type"]);
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
  private readonly stepCache = new Map<string, boolean>();
  /** The name-only guesses made for each file in this run, and how each name was written. */
  private readonly guesses = new Map<string, { src: string; kind: EdgeKind; dst: string; name: string; member: boolean }[]>();
  private readonly fileSets = new WeakMap<string[], Set<string>>();

  constructor(
    private readonly store: GraphStore,
    private readonly root: string,
  ) {}

  async resolve(paths: Iterable<string>, onProgress?: (fraction: number) => void): Promise<number> {
    this.files = this.store.allFiles();
    this.basenames = null;
    this.stepCache.clear();
    this.guesses.clear();
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
          return readFileSync(join(this.root, p), "utf8");
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
      if (!target || target.id === ref.src) continue;
      this.addEdge(ref.src, target.id, EDGE_KIND[ref.kind], target.confidence, path, ref.line, ref.count);
      if (target.confidence === "heuristic" && spec) {
        const guess = { src: ref.src, kind: EDGE_KIND[ref.kind], dst: target.id, name: ref.name, member: Boolean(ref.qualifier) };
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
    for (const guess of guesses) {
      if (connected.has(`${guess.src}\u0000${guess.dst}`)) this.store.confirmGuess(guess.src, guess.kind, guess.dst);
      else if (settled.has(`${guess.src}\u0000${guess.name}\u0000${guess.member ? 1 : 0}`)) {
        this.store.deleteGuess(guess.src, guess.kind, guess.dst);
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
    const resolved = (node: GraphNode | null): Target | null =>
      node ? { id: node.id, confidence: "resolved" } : null;
    const qualifier = ref.qualifier;

    if (qualifier) {
      if (qualifier.startsWith(TYPED_PREFIX)) {
        // The receiver's type is written down: it has this member, or nothing is drawn.
        const type = this.typeNamed(qualifier.slice(TYPED_PREFIX.length), path, scope);
        return type ? resolved(this.member(type, ref.name, 0)) : null;
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
        return qualifier === "super" ? null : this.heuristicMember(ref, path, scope, spec);
      }
      if (qualifier !== "?") {
        const binding = scope.bindings.get(qualifier);
        if (binding) {
          if (binding.files === null) return null;
          if (binding.imported === "*") return resolved(this.exportedFrom(binding.files, ref.name));
          const owner = this.exportedFrom(binding.files, binding.imported);
          return owner ? resolved(this.member(owner, ref.name, 0)) : null;
        }
        const type = this.typeNamed(qualifier, path, scope);
        if (type) return resolved(this.member(type, ref.name, 0));
        const moduleFile = spec.resolveQualifier?.(qualifier, path, this.ctx);
        if (moduleFile) return resolved(this.findExported(moduleFile, ref.name));
        // `path.posix.join(...)`: the receiver hangs off a third-party module.
        const head = qualifier.split(".")[0]!;
        if (head !== qualifier && scope.bindings.get(head)?.files === null) return null;
      }
      return this.heuristicMember(ref, path, scope, spec);
    }

    // A bare call inside a class may be to one of its own methods, inherited ones included.
    if (spec.implicitSelf && ref.kind === "calls") {
      const cls = this.enclosingClass(ref.src);
      const member = cls ? this.member(cls, ref.name, 0) : null;
      if (member) return resolved(member);
    }
    // Otherwise a bare name is something defined in this file, imported into it, or in its package.
    return resolved(this.visible(ref.name, path, scope));
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
      for (const node of this.store.nodesNamed(name)) {
        if (node.parent === node.path && scope.ambient.has(node.path)) return node;
      }
    }
    return null;
  }

  /** A class, interface or other named type visible in a file, by plain or `package.Type` name. */
  private typeNamed(name: string, path: string, scope: FileScope): GraphNode | null {
    let node: GraphNode | null;
    const dot = name.indexOf(".");
    if (dot > 0) {
      const binding = scope.bindings.get(name.slice(0, dot));
      const rest = name.slice(dot + 1);
      if (!binding?.files || binding.imported !== "*" || rest.includes(".")) return null;
      node = this.exportedFrom(binding.files, rest);
    } else {
      node = this.visible(name, path, scope);
    }
    return node && TYPE_KINDS.has(node.kind) ? node : null;
  }

  /** A method call on a receiver of unknown type: accept only an unambiguous name match. */
  private heuristicMember(ref: RawRef, path: string, scope: FileScope, spec: LanguageSpec): Target | null {
    if (ref.kind !== "calls") return null;
    if (ref.name.length < 3 || COMMON_MEMBER_NAMES.has(ref.name)) return null;
    const candidates = this.store
      .nodesNamed(ref.name)
      .filter((n) => n.kind === "method" && familyOf(n.language) === spec.family);
    if (candidates.length === 1) return { id: candidates[0]!.id, confidence: "heuristic" };
    if (candidates.length > 1) {
      const near = candidates.filter(
        (c) => c.path === path || scope.importedFiles.has(c.path) || scope.ambient.has(c.path),
      );
      if (near.length === 1) return { id: near[0]!.id, confidence: "heuristic" };
    }
    return null;
  }

  private fileLevel(file: string, name: string): GraphNode | null {
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
      if (!set) this.fileSets.set(files, (set = new Set(files)));
      for (const node of this.store.nodesNamed(name)) {
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

    const spec = specFor(this.files.get(file)?.language);
    if (!spec) return null;
    for (const imp of this.store.importsOf(file)) {
      if (!imp.reexport && !spec.importsAreExports) continue;
      for (const resolved of spec.resolveImport(imp, file, this.ctx)) {
        if (!resolved.file) continue;
        for (const n of resolved.names) {
          if (n.local === name) {
            if (n.imported === "*") return this.store.getNode(resolved.file);
            return this.findExported(resolved.file, n.imported, depth + 1, seen);
          }
          if (n.local === "*" && n.imported === "*") {
            const hit = this.findExported(resolved.file, name, depth + 1, seen);
            if (hit) return hit;
          }
        }
      }
    }
    return null;
  }

  /** A member of a class, looking through base classes resolved so far. */
  private member(owner: GraphNode, name: string, depth: number): GraphNode | null {
    const direct = this.store.getNode(`${owner.id}.${name}`);
    if (direct) return direct;
    const outside = this.memberWrittenOutside(owner, name);
    if (outside) return outside;
    if (depth >= 4) return null;
    for (const edge of this.store.edgesFrom(owner.id, "extends")) {
      if (edge.dst === owner.id) continue;
      const base = this.store.getNode(edge.dst);
      const inherited = base ? this.member(base, name, depth + 1) : null;
      if (inherited) return inherited;
    }
    return null;
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
    for (const node of this.store.nodesNamed(name)) {
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
    for (const node of this.store.nodesNamed(ownerQname.slice(ownerQname.lastIndexOf(".") + 1))) {
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
    const resolved = target.startsWith("/")
      ? posixJoin(target.slice(1))
      : posixJoin(posixDirname(path), target);
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
    let candidates = this.store.nodesNamed(name).filter((n) => SYMBOL_KINDS.has(n.kind));
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
