import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphStore } from "../store/store.js";
import type { EdgeKind, GraphNode, ScipFact } from "../types.js";
import { posixJoin, toPosix } from "../util.js";
import {
  ENCODING_UTF32,
  ENCODING_UTF8,
  readScip,
  ROLE_DEFINITION,
  ROLE_IMPORT,
  symbolName,
  type ScipDocument,
  type ScipOccurrence,
} from "./reader.js";

export interface ScipSourceStatus {
  /** The index file. */
  path: string;
  /** False when the file is listed but could not be found or read. */
  present: boolean;
  tool: string;
  importedAt: number | null;
  /** Documents in the index. */
  documents: number;
  /** Documents that are files of this project. */
  matched: number;
  /** Matched documents left out because the file no longer agrees with the index. */
  outOfStep: number;
  facts: number;
  /** Files whose edges currently come from the index: imported and unchanged since. */
  filesInUse: number;
}

/** Name of the index file every SCIP indexer writes by default. */
const DEFAULT_NAME = "index.scip";
const MAX_INDEX_BYTES = 512 * 1024 * 1024;
/** How often the index files are looked at, at most. */
const CHECK_INTERVAL_MS = 1000;
/** A document is trusted when at least this share of its definitions sit where the index says. */
const AGREEMENT = 0.8;
const TYPE_KINDS = new Set(["class", "interface", "type"]);
const IDENTIFIER = /^[\p{L}\p{N}_$]+$/u;
/**
 * Symbols for types end in `#`, for functions, methods, fields and variables in `.`.
 * Everything else is left alone: parameters, type parameters, packages, and the
 * made-up names indexers give to members of anonymous object types (`path0:`).
 */
const DECLARATION = /[#.]$/;
const DECLARATION_FILE = /\.d\.[cm]?ts`\/$/;

/** The parts of a symbol that say which package it is in, which file, and what in that file. */
function splitSymbol(symbol: string): { pkg: string; dirs: string[]; stem: string; tail: string; declaration: boolean } | null {
  const parts = symbol.split(" ");
  if (parts.length < 5) return null;
  const descriptors = parts.slice(4).join(" ");
  // The last `/` outside backticks closes the namespace, which for TypeScript is the file.
  let cut = -1;
  let quoted = false;
  for (let i = 0; i < descriptors.length; i++) {
    const ch = descriptors[i];
    if (ch === "`") quoted = !quoted;
    else if (ch === "/" && !quoted) cut = i;
  }
  if (cut < 0) return null;
  const namespace = descriptors.slice(0, cut + 1);
  const segments = namespace.split("/").filter(Boolean).map((s) => s.replace(/^`|`$/g, ""));
  const file = segments.pop() ?? "";
  return {
    pkg: `${parts[1]} ${parts[2]}`,
    dirs: segments,
    stem: file.replace(/(\.d)?\.[cm]?[jt]sx?$/, ""),
    tail: descriptors.slice(cut + 1),
    declaration: DECLARATION_FILE.test(namespace),
  };
}

function commonSuffix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
const CONSTRUCTOR_NAMES = new Set(["constructor", "__init__", "__new__", "new"]);

/** What a symbol of the index stands for in the graph. */
interface Target {
  id: string;
  /** The text a use of the symbol must have for the index and the file to agree. */
  name: string;
  /** True for a field or other member with no node of its own: uses of it count as uses of its type. */
  viaType: boolean;
}

function sameOrInside(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return toPosix(rel);
}

/** Position of an offset in a line as a JavaScript string index. */
function toIndex(line: string, offset: number, encoding: number): number {
  if (encoding === ENCODING_UTF8) {
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7f]*$/.test(line)) return offset;
    return Buffer.from(line, "utf8").subarray(0, offset).toString("utf8").length;
  }
  if (encoding === ENCODING_UTF32) {
    if (!/[\ud800-\udfff]/.test(line)) return offset;
    return Array.from(line).slice(0, offset).join("").length;
  }
  return offset; // UTF-16, which is also what unlabelled indexes are read as
}

/** Lines (0-based) taken up by import statements, which are not uses of what they name. */
function importLines(lines: string[], starts: number[]): Set<number> {
  const out = new Set<number>();
  for (const start of starts) {
    let depth = 0;
    for (let i = start - 1; i < lines.length && i < start + 80; i++) {
      out.add(i);
      for (const ch of lines[i] ?? "") {
        if (ch === "{" || ch === "(") depth++;
        else if (ch === "}" || ch === ")") depth--;
      }
      if (depth <= 0) break;
    }
  }
  return out;
}

class FileView {
  readonly lines: string[];
  /** Symbols of the file, smallest first, so the first one containing a line is the innermost. */
  readonly nodes: GraphNode[];

  constructor(text: string, nodes: GraphNode[]) {
    this.lines = text.split(/\r?\n/);
    this.nodes = nodes
      .filter((n) => n.startLine && n.endLine)
      .sort((a, b) => a.endLine! - a.startLine! - (b.endLine! - b.startLine!));
  }

  text(occurrence: ScipOccurrence, encoding: number): string | null {
    const line = this.lines[occurrence.line];
    if (line === undefined || occurrence.end <= occurrence.start) return null;
    return line.slice(toIndex(line, occurrence.start, encoding), toIndex(line, occurrence.end, encoding));
  }

  /** True when the text after the occurrence opens an argument list. */
  isCall(occurrence: ScipOccurrence, encoding: number): boolean {
    const line = this.lines[occurrence.line];
    if (line === undefined) return false;
    const rest = line.slice(toIndex(line, occurrence.end, encoding));
    // `name(`, `name<T>(`, `name::<T>(`, the optional call `name?.(`, and a macro `name!(`.
    return /^\s*(?:\?\.)?\s*(?:(?:::)?<[^<>(){};]*>\s*)?\(/.test(rest) || /^!\s*[([{]/.test(rest);
  }

  /** True when the occurrence is the member in `value.member`, as opposed to a name standing alone. */
  isMember(occurrence: ScipOccurrence, encoding: number): boolean {
    const line = this.lines[occurrence.line];
    if (line === undefined) return false;
    return /(\.|::|->)\s*$/.test(line.slice(0, toIndex(line, occurrence.start, encoding)));
  }

  innermost(line: number, name?: string): GraphNode | null {
    const oneBased = line + 1;
    for (const node of this.nodes) {
      if (node.startLine! <= oneBased && oneBased <= node.endLine! && (name === undefined || node.name === name)) {
        return node;
      }
    }
    return null;
  }

  /**
   * The node a definition in the index corresponds to. A constructor stands for
   * its class, as it does everywhere else in the graph, and a member that has
   * no node (a field, an enum value) stands for the type that declares it.
   */
  target(line: number, text: string, byId: (id: string) => GraphNode | null): Target | null {
    const node = this.innermost(line, text);
    if (node) {
      const isConstructor =
        node.kind === "method" && (node.subkind === "constructor" || CONSTRUCTOR_NAMES.has(node.name));
      const owner = isConstructor && node.parent ? byId(node.parent) : null;
      if (owner && TYPE_KINDS.has(owner.kind)) return { id: owner.id, name: owner.name, viaType: false };
      return { id: node.id, name: text, viaType: false };
    }
    const around = this.innermost(line);
    if (around && TYPE_KINDS.has(around.kind) && IDENTIFIER.test(text)) {
      return { id: around.id, name: text, viaType: true };
    }
    return null;
  }
}

/**
 * Compiler-accurate relationships from SCIP indexes.
 *
 * An index is a snapshot: it describes the files as they were when the indexer
 * ran. Its facts are therefore kept per file together with the file's content
 * hash, and used only while that hash is unchanged. Edit a file and its edges
 * fall back to what the syntax tree shows, until the indexer runs again.
 */
export class ScipIndexes {
  private lastCheck = 0;
  private lastAnswer = false;

  constructor(
    private readonly store: GraphStore,
    private readonly root: string,
    private readonly dataDir: string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  private get configPath(): string {
    return join(this.dataDir, "scip.json");
  }

  /** Index files added by hand, as absolute paths. */
  private listed(): string[] {
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as { sources?: unknown };
      return Array.isArray(parsed.sources) ? parsed.sources.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return [];
    }
  }

  private save(sources: string[]): void {
    writeFileSync(this.configPath, `${JSON.stringify({ sources }, null, 2)}\n`);
  }

  /** Use this index file from now on. */
  add(path: string): string {
    const abs = resolve(path);
    statSync(abs); // throws a clear error when it is not there
    const listed = this.listed();
    if (!listed.includes(abs)) this.save([...listed, abs]);
    this.lastCheck = 0;
    return abs;
  }

  /** Stop using an index file. Returns false when it was not listed. */
  forget(path: string): boolean {
    const abs = resolve(path);
    const listed = this.listed();
    if (!listed.includes(abs)) return false;
    this.save(listed.filter((s) => s !== abs));
    this.lastCheck = 0;
    return true;
  }

  /** Every index file in use: the project's own `index.scip` when there is one, plus those added by hand. */
  sources(): string[] {
    const out = new Set(this.listed());
    out.add(join(this.root, DEFAULT_NAME));
    return [...out];
  }

  private stat(path: string): { size: number; mtimeMs: number } | null {
    try {
      const st = statSync(path);
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  /** True when an index file has appeared, changed or gone since it was last imported. Cheap enough to ask often. */
  changed(): boolean {
    const now = Date.now();
    if (now - this.lastCheck < CHECK_INTERVAL_MS) return this.lastAnswer;
    this.lastCheck = now;
    this.lastAnswer = this.pending().length > 0;
    return this.lastAnswer;
  }

  private pending(): { path: string; stat: { size: number; mtimeMs: number } | null }[] {
    const known = new Map(this.store.scipSources().map((s) => [s.path, s]));
    const out: { path: string; stat: { size: number; mtimeMs: number } | null }[] = [];
    const wanted = new Set(this.sources());
    for (const path of wanted) {
      const stat = this.stat(path);
      const before = known.get(path);
      if (!stat) {
        if (before) out.push({ path, stat: null });
      } else if (!before || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs) {
        out.push({ path, stat });
      }
    }
    for (const path of known.keys()) if (!wanted.has(path)) out.push({ path, stat: null });
    return out;
  }

  /**
   * Import whatever changed. Returns the files whose edges have to be rebuilt:
   * those that had facts before and those that have them now.
   */
  refresh(): string[] {
    const affected = new Set<string>();
    for (const { path, stat } of this.pending()) {
      for (const file of this.store.scipFilesOf(path)) affected.add(file);
      if (!stat) {
        this.store.removeScipSource(path);
        this.log(`compiler index ${path} is gone; its facts were dropped`);
        continue;
      }
      try {
        for (const file of this.import(path, stat)) affected.add(file);
      } catch (err) {
        // Remember the attempt, so a broken file is not re-read on every query.
        this.store.removeScipSource(path);
        this.store.putScipSource({ path, ...stat, tool: "", documents: 0, matched: 0, outOfStep: 0, facts: 0 });
        this.log(`could not read compiler index ${path}: ${(err as Error).message}`);
      }
    }
    this.lastCheck = 0;
    return [...affected];
  }

  /** Directory the index's document paths are relative to, as a project-relative path. */
  private baseDir(indexPath: string, projectRoot: string): string | null {
    if (projectRoot.startsWith("file:")) {
      try {
        const inside = sameOrInside(this.root, fileURLToPath(projectRoot));
        if (inside !== null) return inside;
      } catch {
        // a URI from another machine or operating system: fall back to where the index file is
      }
    }
    return sameOrInside(this.root, dirname(indexPath));
  }

  private import(indexPath: string, stat: { size: number; mtimeMs: number }): string[] {
    if (stat.size > MAX_INDEX_BYTES) throw new Error("larger than 512 MB");
    const data = readFileSync(indexPath);
    const views = new Map<string, FileView | null>();
    const symbolNode = new Map<string, Target>();
    const byId = (id: string) => this.store.getNode(id);
    const outOfStep = new Set<string>();
    /** Symbols defined in files that no longer match the index: nothing can be said about them. */
    const unknown = new Set<string>();
    let documents = 0;
    let base: string | null = null;

    const pathOf = (doc: ScipDocument): string | null =>
      base === null ? null : posixJoin(base, toPosix(doc.relativePath));
    const view = (path: string): FileView | null => {
      let v = views.get(path);
      if (v === undefined) {
        v = null;
        if (this.store.getFile(path)) {
          try {
            v = new FileView(readFileSync(join(this.root, path), "utf8"), this.store.nodesInFile(path));
          } catch {
            // unreadable: treated as not part of the project
          }
        }
        views.set(path, v);
      }
      return v;
    };

    // The project root is in the metadata, which a first pass has to find before paths mean anything.
    const metadata = readScip(data, () => {
      documents++;
    });
    base = this.baseDir(indexPath, metadata.projectRoot);

    // Pass 1: where every symbol is defined, and whether each file still matches the index.
    readScip(data, (doc) => {
      const path = pathOf(doc);
      const file = path === null ? null : view(path);
      if (path === null || !file) return;
      const found: string[] = [];
      const declared: string[] = [];
      let checkable = 0;
      let agree = 0;
      for (const occurrence of doc.occurrences) {
        if ((occurrence.roles & ROLE_DEFINITION) === 0 || occurrence.symbol.startsWith("local ")) continue;
        declared.push(occurrence.symbol);
        if (!DECLARATION.test(occurrence.symbol)) continue;
        const text = file.text(occurrence, doc.positionEncoding);
        if (text === null) continue;
        const expected = symbolName(occurrence.symbol);
        if (expected !== null && IDENTIFIER.test(expected)) {
          checkable++;
          if (expected === text) agree++;
        }
        const target = file.target(occurrence.line, text, byId);
        if (target) {
          symbolNode.set(occurrence.symbol, target);
          found.push(occurrence.symbol);
        }
      }
      if (checkable >= 3 && agree / checkable < AGREEMENT) {
        outOfStep.add(path);
        for (const symbol of found) symbolNode.delete(symbol);
        for (const symbol of declared) unknown.add(symbol);
      }
    });

    // A package used through its built declaration files has two symbols for everything:
    // one in `dist/x.d.ts`, which is what its users refer to, and one in `src/x.ts`, which
    // is the definition. The first stands for the second when exactly one fits.
    let twins: Map<string, { symbol: string; dirs: string[]; stem: string }[]> | null = null;
    const aliases = new Map<string, Target | "unknown" | null>();
    const alias = (symbol: string): Target | "unknown" | null => {
      let target = aliases.get(symbol);
      if (target !== undefined) return target;
      target = null;
      const parts = splitSymbol(symbol);
      if (parts?.declaration && DECLARATION.test(symbol)) {
        if (!twins) {
          twins = new Map();
          for (const known of [...symbolNode.keys(), ...unknown]) {
            const p = splitSymbol(known);
            if (!p || p.declaration) continue;
            const key = `${p.pkg}|${p.tail}`;
            const list = twins.get(key);
            if (list) list.push({ symbol: known, dirs: p.dirs, stem: p.stem });
            else twins.set(key, [{ symbol: known, dirs: p.dirs, stem: p.stem }]);
          }
        }
        const candidates = (twins.get(`${parts.pkg}|${parts.tail}`) ?? []).filter((c) => c.stem === parts.stem);
        let best: string | null = null;
        if (candidates.length === 1) best = candidates[0]!.symbol;
        else if (candidates.length > 1) {
          // Several files of that name: the one whose folders match furthest, if one stands out.
          const scored = candidates.map((c) => ({ symbol: c.symbol, score: commonSuffix(c.dirs, parts.dirs) }));
          scored.sort((a, b) => b.score - a.score);
          if (scored[0]!.score > scored[1]!.score) best = scored[0]!.symbol;
        }
        if (best) target = symbolNode.get(best) ?? (unknown.has(best) ? "unknown" : null);
      }
      aliases.set(symbol, target);
      return target;
    };
    /** Names a guess could point at. A name no node has needs no record of where it really leads. */
    const nodeNames = new Set(
      this.store.db
        .prepare("SELECT DISTINCT name FROM nodes WHERE kind NOT IN ('file', 'directory', 'external')")
        .all()
        .map((row) => row.name as string),
    );

    // Pass 2: every use of a known symbol becomes a fact about the file it is in.
    const seen = new Set<string>();
    let totalFacts = 0;
    readScip(data, (doc) => {
      const path = pathOf(doc);
      const file = path === null ? null : view(path);
      if (path === null || !file || outOfStep.has(path)) return;
      const record = this.store.getFile(path)!;
      const skip = importLines(
        file.lines,
        this.store.importsOf(path).map((imp) => imp.line),
      );
      const facts = new Map<string, ScipFact>();
      const add = (src: string, kind: EdgeKind, dst: string, line: number) => {
        if (src === dst) return;
        const key = `${src}\u0000${kind}\u0000${dst}`;
        const existing = facts.get(key);
        if (existing) existing.count++;
        else facts.set(key, { src, kind, dst, line, count: 1 });
      };

      /**
       * Every use the compiler resolved, by scope, name and whether it was written `x.name`:
       * a guess made for the same name, used the same way in the same scope, is thereby
       * either confirmed by a fact or shown to be wrong.
       */
      const settled = new Set<string>();
      for (const occurrence of doc.occurrences) {
        if ((occurrence.roles & (ROLE_DEFINITION | ROLE_IMPORT)) !== 0) continue;
        if (skip.has(occurrence.line) || unknown.has(occurrence.symbol)) continue;
        const text = file.text(occurrence, doc.positionEncoding);
        if (text === null) continue;
        const target = symbolNode.get(occurrence.symbol) ?? alias(occurrence.symbol);
        if (target === "unknown") continue;
        // The file may have changed in ways the definitions do not show: only a use
        // that still reads as the symbol's name is taken from the index.
        const expected = target ? target.name : symbolName(occurrence.symbol);
        if (expected !== null && IDENTIFIER.test(expected) && expected !== text) continue;
        const src = file.innermost(occurrence.line)?.id ?? path;
        if (nodeNames.has(text)) {
          settled.add(`${src}\u0000${text}\u0000${file.isMember(occurrence, doc.positionEncoding) ? 1 : 0}`);
        }
        // A library's method, a parameter, a local: nothing the graph has a node for.
        if (!target) continue;
        if (target.viaType) {
          // Code inside a type using that type's own fields says nothing new.
          if (src === target.id || src.startsWith(`${target.id}.`)) continue;
          add(src, "references", target.id, occurrence.line + 1);
        } else {
          const kind = file.isCall(occurrence, doc.positionEncoding) ? "calls" : "references";
          add(src, kind, target.id, occurrence.line + 1);
        }
      }
      for (const symbol of doc.symbols) {
        const source = symbolNode.get(symbol.symbol);
        const from = source && !source.viaType ? this.store.getNode(source.id) : null;
        if (!from || from.path !== path) continue;
        for (const relationship of symbol.relationships) {
          if (!relationship.isImplementation) continue;
          const dst = symbolNode.get(relationship.symbol);
          const to = dst && !dst.viaType ? this.store.getNode(dst.id) : null;
          if (!to) continue;
          if (TYPE_KINDS.has(from.kind) !== TYPE_KINDS.has(to.kind)) continue;
          // Between types this is inheritance. Between members one stands in for the other:
          // it implements what an interface declares and overrides anything else.
          const declaredBy = TYPE_KINDS.has(to.kind) ? to : to.parent ? this.store.getNode(to.parent) : null;
          add(from.id, declaredBy?.kind === "interface" ? "implements" : "extends", to.id, from.startLine ?? 1);
        }
      }
      this.store.replaceScipFile(
        path,
        indexPath,
        record.hash,
        [...facts.values()],
        [...settled],
      );
      seen.add(path);
      totalFacts += facts.size;
    });

    const before = this.store.scipFilesOf(indexPath);
    for (const path of before) if (!seen.has(path)) this.store.removeScipFile(path);
    this.store.putScipSource({
      path: indexPath,
      ...stat,
      tool: [metadata.toolName, metadata.toolVersion].filter(Boolean).join(" "),
      documents,
      matched: seen.size + outOfStep.size,
      outOfStep: outOfStep.size,
      facts: totalFacts,
    });
    this.log(
      `compiler index ${indexPath}: ${seen.size} of ${documents} documents in use, ${totalFacts} relationships` +
        (outOfStep.size > 0 ? `, ${outOfStep.size} files left out because they no longer match it` : ""),
    );
    return [...new Set([...before, ...seen])];
  }

  status(): ScipSourceStatus[] {
    const known = new Map(this.store.scipSources().map((s) => [s.path, s]));
    const out: ScipSourceStatus[] = [];
    for (const path of new Set([...this.sources(), ...known.keys()])) {
      const row = known.get(path);
      const present = this.stat(path) !== null;
      // The default location is only worth reporting when something is there.
      if (!row && !present && !this.listed().includes(path)) continue;
      out.push({
        path,
        present,
        tool: row?.tool ?? "",
        importedAt: row?.importedAt ?? null,
        documents: row?.documents ?? 0,
        matched: row?.matched ?? 0,
        outOfStep: row?.outOfStep ?? 0,
        facts: row?.facts ?? 0,
        filesInUse: this.store.scipFilesInUse(path),
      });
    }
    return out;
  }
}
