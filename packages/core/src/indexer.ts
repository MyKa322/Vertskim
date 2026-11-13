import { readFile } from "node:fs/promises";
import { RULE_FILES, walkPaths, walkProject, type DiscoveredFile } from "./discovery/walk.js";
import { EMPTY_EXTRACTION, extractFile, isParseable, MAX_PARSE_BYTES } from "./extract/index.js";
import { Resolver } from "./resolve/resolver.js";
import type { GraphStore } from "./store/store.js";
import type { Extraction, FileRecord, SyncResult } from "./types.js";
import { countLines, decodeText, posixBasename, posixDirname, sha1, toPosix, yieldToEventLoop } from "./util.js";

/** Above this many affected files it is cheaper to re-resolve everything. */
const FULL_RESOLVE_THRESHOLD = 500;
const FILES_PER_TICK = 16;
/** Files that say how imports map to directories; a change to one re-links the whole project. */
const MANIFESTS = new Set(["package.json", "go.mod", "Cargo.toml", "composer.json", ".luaurc"]);

function isManifest(path: string): boolean {
  const name = posixBasename(path);
  return MANIFESTS.has(name) || /^[jt]sconfig(\..+)?\.json$/.test(name) || name.endsWith(".project.json");
}

export interface IndexProgress {
  state: "idle" | "indexing";
  progress: number;
}

export interface SyncOptions {
  /** Project-relative files or directories to examine instead of walking everything. */
  paths?: string[];
}

/** Posix, de-duplicated, without paths that sit inside another listed path. */
function normalizePaths(paths: string[]): string[] {
  const clean = new Set<string>();
  for (const raw of paths) {
    const path = toPosix(raw).replace(/^\.\//, "").replace(/\/+$/, "");
    // Only paths inside the project are ever examined.
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) continue;
    clean.add(path === "." ? "" : path);
  }
  if (clean.has("")) return [""];
  // Shortest first, so a directory is seen before anything inside it.
  const kept = new Set<string>();
  for (const path of [...clean].sort((a, b) => a.length - b.length)) {
    let covered = false;
    for (let i = path.indexOf("/"); i >= 0 && !covered; i = path.indexOf("/", i + 1)) {
      covered = kept.has(path.slice(0, i));
    }
    if (!covered) kept.add(path);
  }
  return [...kept];
}

/**
 * Keeps the store in step with the files on disk. Each `sync` walks the
 * project, re-extracts files whose content changed, and re-resolves only the
 * files those changes can affect.
 */
export class Indexer {
  readonly progress: IndexProgress = { state: "idle", progress: 1 };
  /** Duration of the most recent directory walk, used to pace refreshes. */
  lastWalkMs = 0;
  truncated = false;
  private readonly resolver: Resolver;

  constructor(
    private readonly store: GraphStore,
    private readonly root: string,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.resolver = new Resolver(store, root);
  }

  /**
   * Bring the store up to date. With `paths`, only those files and directories
   * are examined (what a file watcher reports); without, the whole project is
   * walked. A targeted sync falls back to a full one whenever it cannot be
   * trusted: nothing indexed yet, an interrupted sync, or changed ignore rules.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const started = performance.now();
    // Set while a sync is in flight; still set at the next start means the last one was interrupted.
    const interrupted = this.store.getMeta("dirty") === "1";
    const paths = options.paths ? normalizePaths(options.paths) : null;
    const targeted =
      paths !== null &&
      !interrupted &&
      !paths.includes("") &&
      !paths.some((p) => RULE_FILES.includes(posixBasename(p))) &&
      this.store.counts().files > 0;

    let current: Map<string, DiscoveredFile>;
    let known: Map<string, FileRecord>;
    if (targeted) {
      current = (await walkPaths(this.root, paths)).files;
      known = new Map();
      for (const path of paths) for (const record of this.store.filesAt(path)) known.set(record.path, record);
    } else {
      const walk = await walkProject(this.root);
      this.lastWalkMs = performance.now() - started;
      this.truncated = walk.truncated;
      current = walk.files;
      known = this.store.allFiles();
    }
    const firstIndex = !targeted && known.size === 0;

    const removed: string[] = [];
    for (const path of known.keys()) if (!current.has(path)) removed.push(path);
    const added: DiscoveredFile[] = [];
    const modified: DiscoveredFile[] = [];
    for (const file of current.values()) {
      const before = known.get(file.path);
      if (!before) added.push(file);
      else if (before.size !== file.size || before.mtimeMs !== file.mtimeMs) modified.push(file);
    }

    const result: SyncResult = { added: 0, changed: 0, removed: removed.length, resolvedFiles: 0, durationMs: 0 };
    if (removed.length === 0 && added.length === 0 && modified.length === 0 && !interrupted) {
      result.durationMs = performance.now() - started;
      return result;
    }

    this.progress.state = "indexing";
    this.progress.progress = 0;
    try {
      /** Files whose edges must be rebuilt. */
      const affected = new Set<string>();
      /** Symbol names that appeared or disappeared; anything referring to them is affected. */
      const names = new Set<string>();
      let resolveAll = firstIndex || interrupted;
      this.store.setMeta("dirty", "1");

      const noteOldState = (path: string) => {
        for (const file of this.store.filesWithEdgesInto(path)) affected.add(file);
        for (const name of this.store.namesInFile(path)) names.add(name);
      };

      /** Files whose own content changed, as opposed to files merely affected by that. */
      const changedPaths: string[] = [];
      for (const path of removed) {
        noteOldState(path);
        if (isManifest(path)) resolveAll = true;
        this.store.removeFile(path);
        changedPaths.push(path);
      }

      const queue = [...added, ...modified];
      const addedPaths = new Set(added.map((f) => f.path));
      for (let start = 0; start < queue.length; start += FILES_PER_TICK) {
        await this.store.batch(async () => {
          for (let i = start; i < Math.min(start + FILES_PER_TICK, queue.length); i++) {
            const file = queue[i]!;
            const before = known.get(file.path);
            const parse = isParseable(file.language) && file.size <= MAX_PARSE_BYTES;
            let hash = `${file.size}:${file.mtimeMs}`;
            let extraction: Extraction = EMPTY_EXTRACTION;
            let lines = 0;

            if (parse) {
              let text: string;
              try {
                text = decodeText(await readFile(file.abs));
              } catch {
                continue; // vanished or unreadable since the walk
              }
              hash = sha1(text);
              if (before && before.hash === hash) {
                this.store.touchFile(file.path, file.size, file.mtimeMs);
                continue;
              }
              lines = countLines(text);
              try {
                extraction = await extractFile(file.path, file.language, text);
              } catch (err) {
                this.log(`extract failed for ${file.path}: ${(err as Error).message}`);
              }
            }

            // An edit in progress often leaves a file that does not parse, and the parser then sees
            // far less of it. Until it parses again, the symbols of the last version that did are kept.
            // A file that never parsed cleanly (C full of macros, syntax newer than the grammar) is
            // just read again: its errors are not an edit in progress.
            const storedIsClean = before && (before.syntaxError == null || before.keptSymbols);
            if (
              storedIsClean &&
              extraction.syntaxError &&
              extraction.nodes.length < this.store.symbolCount(file.path)
            ) {
              this.store.keepSymbols(
                { ...before, hash, size: file.size, mtimeMs: file.mtimeMs, lines },
                extraction.syntaxError,
              );
              result.changed++;
              continue;
            }
            if (before) noteOldState(file.path);
            this.store.replaceFile(
              {
                path: file.path,
                hash,
                size: file.size,
                mtimeMs: file.mtimeMs,
                language: file.language,
                subkind: file.subkind,
                lines,
              },
              extraction,
            );
            for (const node of extraction.nodes) names.add(node.name);
            affected.add(file.path);
            changedPaths.push(file.path);
            if (isManifest(file.path)) resolveAll = true;
            if (addedPaths.has(file.path)) {
              result.added++;
              if (!resolveAll) {
                for (const other of this.filesPossiblyReferencing(file.path)) affected.add(other);
              }
            } else {
              result.changed++;
            }
          }
        });
        this.progress.progress = (0.7 * Math.min(start + FILES_PER_TICK, queue.length)) / queue.length;
        await yieldToEventLoop();
      }
      this.progress.progress = 0.7;

      if (!resolveAll) {
        for (const file of this.store.filesReferencingNames([...names])) affected.add(file);
        this.propagateThroughBarrels(changedPaths, affected);
        if (affected.size > FULL_RESOLVE_THRESHOLD) resolveAll = true;
      }
      const targets = resolveAll ? this.store.allFiles().keys() : affected;
      result.resolvedFiles = await this.resolver.resolve(targets, (fraction) => {
        this.progress.progress = 0.7 + 0.3 * fraction;
      });
      this.store.prune();
      // Anything showing the graph (in this process or another) compares this to know it changed.
      this.store.setMeta("graph_version", String(Number(this.store.getMeta("graph_version") ?? 0) + 1));
      this.store.setMeta("dirty", "0");
    } finally {
      this.progress.state = "idle";
      this.progress.progress = 1;
    }
    result.durationMs = performance.now() - started;
    return result;
  }

  /** Rebuild the edges of the given files without re-reading them, as after new compiler-index facts. */
  async relink(paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const count = await this.resolver.resolve(paths);
    this.store.prune();
    this.store.setMeta("graph_version", String(Number(this.store.getMeta("graph_version") ?? 0) + 1));
    return count;
  }

  /**
   * A change to a file is visible to anything that imports it through a
   * re-exporting module (`export * from`, a Python `__init__.py`), however many
   * such modules sit in between. Adds those importers to `affected`.
   */
  private propagateThroughBarrels(changed: string[], affected: Set<string>): void {
    const importers = this.store.stmt("SELECT DISTINCT src FROM edges WHERE dst = ? AND kind = 'imports'");
    const reexports = this.store.stmt("SELECT 1 FROM imports WHERE origin_file = ? AND reexport = 1 LIMIT 1");
    const isBarrel = (path: string) => posixBasename(path) === "__init__.py" || reexports.get(path) !== undefined;
    const queue = [...changed];
    const seen = new Set(queue);
    for (let i = 0; i < queue.length && affected.size <= FULL_RESOLVE_THRESHOLD; i++) {
      for (const row of importers.all(queue[i]!)) {
        const importer = row.src as string;
        affected.add(importer);
        if (!seen.has(importer) && isBarrel(importer)) {
          seen.add(importer);
          queue.push(importer);
        }
      }
    }
  }

  /**
   * Files that may hold an import, link or mention which a newly added file
   * now satisfies. Deliberately broad: a false positive only costs a re-resolve.
   */
  private filesPossiblyReferencing(path: string): string[] {
    const base = posixBasename(path);
    const dot = base.indexOf(".");
    let stem = dot > 0 ? base.slice(0, dot) : base;
    // A file that stands for its folder is imported by the folder's name (Luau's `init.luau` too).
    if (stem === "index" || stem === "__init__" || (stem === "init" && /\.luau?$/.test(base))) {
      stem = posixBasename(posixDirname(path)) || stem;
    }
    const like = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    const out = new Set<string>();
    for (const row of this.store
      .stmt("SELECT DISTINCT origin_file AS f FROM imports WHERE specifier LIKE ? ESCAPE '\\'")
      .all(like(stem))) {
      out.add(row.f as string);
    }
    for (const row of this.store
      .stmt(
        `SELECT DISTINCT origin_file AS f FROM refs
         WHERE kind IN ('links_to', 'mentions') AND (name LIKE ? ESCAPE '\\' OR qualifier LIKE ? ESCAPE '\\')`,
      )
      .all(like(stem), like(stem))) {
      out.add(row.f as string);
    }
    return [...out];
  }
}
