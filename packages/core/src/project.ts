import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { buildContext, type ContextOptions, type ContextResult } from "./analyze/context.js";
import { impact, type ImpactOptions, type ImpactResult } from "./analyze/impact.js";
import { overview, type Overview } from "./analyze/overview.js";
import { findPath, type PathOptions, type PathResult } from "./analyze/path.js";
import { ViewBuilder, type GraphView, type ViewOptions } from "./analyze/view.js";
import { Embeddings, type EmbedProgress, type EmbedResult, type EmbeddingStatus } from "./embed/embeddings.js";
import type { EmbeddingConfig } from "./embed/provider.js";
import { EXTRACTOR_VERSION } from "./extract/index.js";
import { Indexer } from "./indexer.js";
import { MAX_NOTE_LENGTH, NoteStore, type Note, type NoteView } from "./notes/notes.js";
import { details, type NodeDetails } from "./query/details.js";
import { neighbors, type NeighborOptions, type NeighborResult } from "./query/neighbors.js";
import { closeInMeaning, mergeByMeaning, search, type SearchOptions, type SearchResult } from "./query/search.js";
import { ScipIndexes, type ScipSourceStatus } from "./scip/indexes.js";
import { GraphStore, SCHEMA_VERSION } from "./store/store.js";
import type { GraphNode, IndexStatus, SyncResult } from "./types.js";
import { sha1, toPosix } from "./util.js";
import { withFileLock } from "./watch/lock.js";
import { watchProject, type WatchHandle } from "./watch/watcher.js";

export interface OpenOptions {
  /** Project root. Never written to. */
  root: string;
  /** Where the database lives. Defaults to a per-project folder in the user data directory. */
  dataDir?: string;
  /** Receives diagnostics. Must not write to stdout when serving MCP over stdio. */
  log?: (message: string) => void;
  /** Called after every sync that changed the graph. */
  onSync?: (result: SyncResult) => void;
}

export interface SyncRequest {
  /** Walk the whole project instead of only the paths known to have changed. */
  full?: boolean;
  /** Project-relative files or directories to re-examine. */
  paths?: string[];
}

export interface SourceSlice {
  path: string;
  startLine: number;
  endLine: number;
  /** Lines in the whole file. */
  totalLines: number;
  text: string;
}

export interface ProjectStatus extends IndexStatus {
  /** True when the file limit stopped the walk early. */
  truncated: boolean;
  error: string | null;
  /** True when file changes are picked up as they happen. */
  watching: boolean;
}

/** Without a watcher: shortest gap between two automatic re-scans of the project tree. */
const MIN_REFRESH_INTERVAL_MS = 1500;
/** Quiet period after a file event before syncing, so a burst of saves is handled once. */
const DEBOUNCE_MS = 120;
/** A burst larger than this is handled as a full scan. */
const MAX_TARGETED_PATHS = 2000;
/** While watching, how often a full scan double-checks that no event was missed. */
const FULL_RESCAN_INTERVAL_MS = 10 * 60_000;

/** At most this many starting points for a task come from what it means rather than the names in it. */
const MAX_MEANING_SEEDS = 6;

const EMPTY_RESULT: SyncResult = { added: 0, changed: 0, removed: 0, resolvedFiles: 0, durationMs: 0 };

/** Base directory for all Vertskim data, outside any project. */
export function dataRoot(): string {
  const override = process.env.VERTSKIM_DATA_DIR;
  if (override) return resolve(override);
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "vertskim");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "vertskim");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "vertskim");
}

/** The data folder for a project: readable name plus a hash of its real path. */
export function projectDataDir(root: string): string {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const name = basename(root).replace(/[^\w.-]+/g, "_") || "project";
  return join(dataRoot(), `${name}-${sha1(key).slice(0, 12)}`);
}

/**
 * An indexed project: the single entry point for the MCP layer, the CLI and
 * (later) the visualizer. Reads the project, writes only to its data folder.
 */
export class Project {
  private watcher: WatchHandle | null = null;
  /** Paths reported as changed that no sync has looked at yet. */
  private readonly pending = new Set<string>();
  private fullScanNeeded = true;
  private resetNeeded = false;
  private running: Promise<SyncResult> | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private waitingForLock = false;
  private closed = false;
  private lastSyncAt: number | null = null;
  private lastFullScanAt = 0;
  private lastSyncMs: number | null = null;
  private lastError: string | null = null;
  private readonly views: ViewBuilder;
  private readonly noteStore: NoteStore;
  private readonly scip: ScipIndexes;
  private readonly embeddings: Embeddings;
  /** True in long-running hosts: vectors are then kept current after every sync. */
  private autoEmbed = false;
  private embedding: Promise<void> | null = null;
  private embedAgain = false;
  private embeddedOnce = false;

  private constructor(
    readonly root: string,
    readonly dataDir: string,
    readonly store: GraphStore,
    private readonly indexer: Indexer,
    private readonly log: (message: string) => void,
    private readonly onSync: ((result: SyncResult) => void) | undefined,
  ) {
    this.views = new ViewBuilder(store);
    this.noteStore = new NoteStore(join(dataDir, "notes.db"));
    this.scip = new ScipIndexes(store, root, dataDir, log);
    this.embeddings = new Embeddings(store, dataDir, (path) => this.readLines(path), log);
  }

  static open(options: OpenOptions): Project {
    const root = realpathSync(resolve(options.root));
    const dataDir = options.dataDir ? resolve(options.dataDir) : projectDataDir(root);
    const log = options.log ?? (() => {});
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "graph.db");

    let store = new GraphStore(dbPath);
    const schema = store.getMeta("schema_version");
    if (schema !== null && schema !== String(SCHEMA_VERSION)) {
      // The layout changed: the database is a cache, so rebuild it.
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
      store = new GraphStore(dbPath);
    }
    store.setMeta("schema_version", String(SCHEMA_VERSION));
    if (store.getMeta("extractor_version") !== String(EXTRACTOR_VERSION)) {
      store.reset();
      store.setMeta("extractor_version", String(EXTRACTOR_VERSION));
    }
    try {
      writeFileSync(join(dataDir, "project.json"), `${JSON.stringify({ root }, null, 2)}\n`);
    } catch {
      // informational only
    }
    return new Project(root, dataDir, store, new Indexer(store, root, log), log, options.onSync);
  }

  /** Stop watching, let a sync in flight finish, and close the database. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close().catch(() => undefined);
    await this.running?.catch(() => undefined);
    await this.embeddings.stop();
    await this.embedding;
    this.embeddings.close();
    this.noteStore.close();
    this.store.close();
  }

  // ------------------------------------------------------------ indexing

  get watching(): boolean {
    return this.watcher !== null;
  }

  /**
   * Start following file changes. Returns false when no watcher is available
   * on this platform, in which case the project is re-scanned before queries.
   */
  async watch(): Promise<boolean> {
    // Whoever watches a project stays around, so it is also the one to keep vectors current.
    if (!this.closed) this.autoEmbed = true;
    if (this.watcher || this.closed) return this.watcher !== null;
    this.watcher = await watchProject(this.root, {
      onChange: (paths) => {
        for (const path of paths) this.pending.add(path);
        this.schedule();
      },
      onError: (error) => {
        this.log(`watcher error (${error.message}); re-scanning the project`);
        this.fullScanNeeded = true;
        this.schedule();
      },
    });
    if (!this.watcher) this.log("file watching is unavailable here; the project is re-scanned before each query");
    return this.watcher !== null;
  }

  private schedule(): void {
    if (this.closed) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.drain().catch(() => undefined);
    }, DEBOUNCE_MS);
  }

  /**
   * Bring the graph up to date and report what changed. With no arguments this
   * handles whatever the watcher has reported, or walks the whole project when
   * nothing is watching.
   */
  sync(request: SyncRequest = {}): Promise<SyncResult> {
    for (const path of request.paths ?? []) this.pending.add(path);
    if (request.full || (!this.watcher && !request.paths)) this.fullScanNeeded = true;
    return this.drain();
  }

  /** Throw the index away and build it again from the files on disk. */
  rebuild(): Promise<SyncResult> {
    this.resetNeeded = true;
    this.fullScanNeeded = true;
    return this.drain();
  }

  /** Run syncs until nothing is outstanding. Concurrent callers share one run. */
  private drain(): Promise<SyncResult> {
    if (this.closed) return Promise.resolve({ ...EMPTY_RESULT });
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.running ??= this.runSyncs().finally(() => {
      this.running = null;
      // Something arrived in the instant between the last check and here.
      if (this.fullScanNeeded || this.pending.size > 0) this.schedule();
    });
    return this.running;
  }

  private async runSyncs(): Promise<SyncResult> {
    const total: SyncResult = { ...EMPTY_RESULT };
    const lockPath = join(this.dataDir, "sync.lock");
    while (this.fullScanNeeded || this.pending.size > 0) {
      const full = this.fullScanNeeded || this.pending.size > MAX_TARGETED_PATHS;
      const paths = full ? undefined : [...this.pending];
      const reset = this.resetNeeded;
      this.pending.clear();
      this.fullScanNeeded = false;
      this.resetNeeded = false;
      try {
        // One process at a time rewrites the graph; others wait and then find little left to do.
        const result = await withFileLock(
          lockPath,
          async () => {
            if (reset) this.store.reset();
            const synced = await this.indexer.sync({ paths });
            // A compiler index that appeared or changed is read once the files it describes are current.
            const relinked = await this.indexer.relink(this.scip.refresh());
            if (relinked > 0) {
              synced.resolvedFiles += relinked;
              synced.changed += synced.added + synced.changed + synced.removed === 0 ? 1 : 0;
            }
            return synced;
          },
          () => {
            this.waitingForLock = true;
          },
        );
        this.lastSyncAt = Date.now();
        if (full) this.lastFullScanAt = this.lastSyncAt;
        this.lastSyncMs = result.durationMs;
        this.lastError = null;
        total.added += result.added;
        total.changed += result.changed;
        total.removed += result.removed;
        total.resolvedFiles += result.resolvedFiles;
        total.durationMs += result.durationMs;
        if (result.added + result.changed + result.removed > 0) {
          this.log(
            `synced: +${result.added} ~${result.changed} -${result.removed}, ` +
              `${result.resolvedFiles} files resolved in ${Math.round(result.durationMs)} ms`,
          );
          this.onSync?.(result);
        }
      } catch (err) {
        // The paths taken for this run are gone; a full scan will pick them up again.
        this.fullScanNeeded = true;
        this.lastError = (err as Error).message;
        this.log(`sync failed: ${this.lastError}`);
        throw err;
      } finally {
        this.waitingForLock = false;
      }
    }
    if (total.added + total.changed + total.removed > 0 || !this.embeddedOnce) this.kickEmbedding();
    return total;
  }

  /** Bring vectors up to date in the background, if this process is the kind that does. */
  private kickEmbedding(): void {
    if (!this.autoEmbed || this.closed || !this.embeddings.config()) return;
    if (this.embedding) {
      this.embedAgain = true;
      return;
    }
    this.embeddedOnce = true;
    this.embedding = this.embeddings
      .update()
      .then(
        () => undefined,
        (err: Error) => {
          if (!this.closed) this.log(`embedding stopped: ${err.message}`);
        },
      )
      .finally(() => {
        this.embedding = null;
        if (this.embedAgain) {
          this.embedAgain = false;
          this.kickEmbedding();
        }
      });
  }

  /**
   * Make sure the graph is current before answering a query. `ids` are the
   * nodes the query names: their files are checked on disk directly, so an
   * edit made a moment ago is seen even if the watcher has not reported it.
   *
   * A slow sync is not waited for beyond `waitMs`; the caller then answers
   * from what is indexed so far and says so.
   */
  async refresh(ids: string[] = [], waitMs = 15_000): Promise<void> {
    if (this.closed) return;
    if (this.scip.changed()) this.fullScanNeeded = true;
    if (this.watcher) {
      for (const path of this.staleFiles(ids)) this.pending.add(path);
      if (!this.running && !this.fullScanNeeded && this.pending.size === 0) {
        if (Date.now() - this.lastFullScanAt > FULL_RESCAN_INTERVAL_MS) {
          // Safety net for missed events; not worth holding the answer for.
          this.fullScanNeeded = true;
          this.drain().catch(() => undefined);
        }
        return;
      }
    } else {
      const interval = Math.max(MIN_REFRESH_INTERVAL_MS, this.indexer.lastWalkMs * 10);
      const due = this.lastSyncAt === null || Date.now() - this.lastSyncAt >= interval;
      if (!this.running && !due) return;
      if (due) this.fullScanNeeded = true;
    }
    const pending = this.drain().then(
      () => undefined,
      () => undefined,
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((done) => {
      timer = setTimeout(done, waitMs);
    });
    await Promise.race([pending, timeout]);
    clearTimeout(timer);
  }

  /** Files behind the given node ids whose size or modification time differs from what is indexed. */
  private staleFiles(ids: string[]): string[] {
    const stale: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const node = this.node(id);
      if (node && (node.kind === "directory" || node.kind === "external")) continue;
      const hash = id.indexOf("#");
      const path = node ? node.path : toPosix(hash < 0 ? id : id.slice(0, hash)).replace(/^\.\//, "");
      if (!path || seen.has(path) || path.endsWith("/") || isAbsolute(path) || path.split("/").includes("..")) continue;
      seen.add(path);
      const record = this.store.getFile(path);
      let onDisk: { size: number; mtimeMs: number } | null = null;
      try {
        const st = lstatSync(join(this.root, path));
        if (st.isFile()) onDisk = { size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        // missing
      }
      if (!onDisk) {
        if (record) stale.push(path);
      } else if (!record || record.size !== onDisk.size || record.mtimeMs !== onDisk.mtimeMs) {
        stale.push(path);
      }
    }
    return stale;
  }

  status(): ProjectStatus {
    const counts = this.store.counts();
    const busy = this.indexer.progress.state === "indexing" || this.waitingForLock;
    return {
      state: busy ? "indexing" : "idle",
      progress: this.waitingForLock ? 0 : this.indexer.progress.progress,
      ...counts,
      lastSyncAt: this.lastSyncAt,
      lastSyncMs: this.lastSyncMs,
      truncated: this.indexer.truncated,
      error: this.lastError,
      watching: this.watcher !== null,
    };
  }

  // ------------------------------------------------------------- queries

  search(options: SearchOptions): SearchResult {
    return search(this.store, options);
  }

  /**
   * Look a node up by id, tolerating the ways ids get mangled: backslashes,
   * `./` prefixes, absolute paths, a missing trailing slash on directories.
   */
  node(input: string): GraphNode | null {
    let id = input.trim();
    if (id === "" || id === "." || id === "/") return this.store.getNode("./");
    const direct = this.store.getNode(id);
    if (direct) return direct;

    const hash = id.indexOf("#");
    let path = hash < 0 ? id : id.slice(0, hash);
    const fragment = hash < 0 ? "" : id.slice(hash);
    if (isAbsolute(path)) {
      const rel = relative(this.root, path);
      if (!rel.startsWith("..") && !isAbsolute(rel)) path = rel;
    }
    path = toPosix(path).replace(/^\.\//, "");
    id = path + fragment;
    return (
      this.store.getNode(id) ??
      (fragment === "" ? this.store.getNode(`${path.replace(/\/$/, "")}/`) : null) ??
      this.store.getNode(id.replace(/:\d+(-\d+)?$/, ""))
    );
  }

  details(node: GraphNode): NodeDetails {
    return details(this.store, node);
  }

  neighbors(node: GraphNode, options: Omit<NeighborOptions, "id">): NeighborResult {
    return neighbors(this.store, node, { ...options, id: node.id });
  }

  /** Everything that depends on the given nodes, directly or indirectly. */
  impact(targets: GraphNode[], options: ImpactOptions = {}): ImpactResult {
    return impact(this.store, targets, options);
  }

  /** The shortest chain of relationships from one node to another, if any. */
  path(from: GraphNode, to: GraphNode, options: PathOptions = {}): PathResult | null {
    return findPath(this.store, from, to, options);
  }

  /** A map of a directory, by default the whole project. */
  overview(scope?: GraphNode, depth?: number): Overview {
    return overview(this.store, scope ?? this.store.getNode("./")!, depth);
  }

  /** The nodes most relevant to a task or to a set of starting nodes. */
  context(options: ContextOptions): ContextResult {
    return buildContext(this.store, (id) => this.node(id), options);
  }

  /** A drawable view of the graph: some containers opened, the rest collapsed. */
  view(options: ViewOptions = {}): GraphView {
    return this.views.build(options);
  }

  /** Containers to open, outermost first, so that a node becomes visible in a view. */
  reveal(id: string): string[] {
    return this.views.reveal(id);
  }

  /** Changes whenever the graph does, in this process or another. */
  graphVersion(): string {
    return this.views.version();
  }

  // ---------------------------------------------------------- embeddings

  embeddingStatus(): EmbeddingStatus {
    return this.embeddings.status();
  }

  /**
   * Choose the embedding model for this project. The model is asked for one
   * vector first, so a wrong name or a server that is not running is reported
   * here rather than later. Throws when it cannot be used.
   */
  enableEmbeddings(config: unknown): Promise<EmbeddingConfig> {
    return this.embeddings.configure(config);
  }

  /** Switch search by meaning off and delete the vectors. */
  disableEmbeddings(): Promise<void> {
    return this.embeddings.disable();
  }

  /** Make vectors for whatever lacks one, after bringing the graph up to date. Does nothing when no model is chosen. */
  async embed(onProgress?: (progress: EmbedProgress) => void): Promise<EmbedResult> {
    await this.sync();
    return this.embeddings.update(onProgress);
  }

  /**
   * Search by name and, when embeddings are on, by meaning as well. A single
   * word is a name: the model is only asked when there are several words or
   * the name matched nothing.
   */
  async searchWithMeaning(options: SearchOptions): Promise<SearchResult> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const words = options.query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || !this.embeddings.ready()) return this.search(options);
    const byName = this.search({ ...options, limit: Math.min(limit * 2, 50) });
    if (words.length < 2 && byName.hits.length > 0) {
      return { hits: byName.hits.slice(0, limit), partial: byName.partial };
    }
    const candidates = await this.embeddings.search(options.query, limit * 4);
    if (!candidates) return { hits: byName.hits.slice(0, limit), partial: byName.partial };
    return mergeByMeaning(this.store, options, byName, candidates);
  }

  /** As {@link context}, with starting points also chosen by what the task means when embeddings are on. */
  async contextWithMeaning(options: ContextOptions): Promise<ContextResult> {
    if (!options.task || !this.embeddings.ready()) return this.context(options);
    const candidates = await this.embeddings.search(options.task, MAX_MEANING_SEEDS * 3);
    const close = closeInMeaning(candidates ?? []).slice(0, MAX_MEANING_SEEDS);
    const top = close[0]?.lift ?? 0;
    const extraSeeds = close.map((c) => {
      // The same curve as for matches by name, so neither kind of evidence drowns the other.
      const relative = top > 0 ? c.lift / top : 0;
      return { id: c.id, weight: 0.25 + 0.6 * relative * relative };
    });
    return this.context({ ...options, extraSeeds: [...(options.extraSeeds ?? []), ...extraSeeds] });
  }

  // ------------------------------------------------------ compiler index

  /** Use a SCIP index file from now on, and read it straight away. */
  async addCompilerIndex(path: string): Promise<ScipSourceStatus | null> {
    const abs = this.scip.add(path);
    await this.sync({ full: true });
    return this.scip.status().find((s) => s.path === abs) ?? null;
  }

  /** Stop using a SCIP index file. Returns false when it was not in use. */
  async forgetCompilerIndex(path: string): Promise<boolean> {
    const known = this.scip.forget(path);
    await this.sync({ full: true });
    return known;
  }

  /** The SCIP index files in use and how much of the project each one covers. */
  compilerIndexes(): ScipSourceStatus[] {
    return this.scip.status();
  }

  // --------------------------------------------------------------- notes

  /**
   * Attach a note to a node. Notes are kept in the data folder, never in the
   * project, and survive re-indexing. Throws when the node does not exist.
   */
  addNote(id: string, text: string, author: string | null = null): NoteView {
    const node = this.node(id);
    if (!node) throw new Error(`${id}: no such node`);
    const clean = text.replace(/\r\n?/g, "\n").trim();
    if (clean === "") throw new Error("the note is empty");
    if (clean.length > MAX_NOTE_LENGTH) {
      throw new Error(`the note is ${clean.length} characters; the limit is ${MAX_NOTE_LENGTH}`);
    }
    const note = this.noteStore.add(node.id, clean, author, this.fingerprint(node));
    return { ...note, stale: false, orphaned: false };
  }

  removeNote(noteId: number): Note | null {
    const note = this.noteStore.get(noteId);
    return note && this.noteStore.remove(noteId) ? note : null;
  }

  /** Notes on the given nodes, by node id, oldest first. */
  notesFor(ids: string[]): Map<string, NoteView[]> {
    const out = new Map<string, NoteView[]>();
    const fingerprints = new Map<string, string | null>();
    for (const note of this.noteStore.forNodes(ids)) {
      const view = this.viewNote(note, fingerprints);
      const list = out.get(note.nodeId);
      if (list) list.push(view);
      else out.set(note.nodeId, [view]);
    }
    return out;
  }

  /** Every note in the project, newest first. */
  listNotes(limit = 200): NoteView[] {
    const fingerprints = new Map<string, string | null>();
    return this.noteStore.all(limit).map((note) => this.viewNote(note, fingerprints));
  }

  /** Notes whose text contains every word of the query, newest first. */
  searchNotes(query: string, limit = 10): NoteView[] {
    const words = query.split(/\s+/).filter((w) => w.length > 1);
    const fingerprints = new Map<string, string | null>();
    return this.noteStore.matching(words, limit).map((note) => this.viewNote(note, fingerprints));
  }

  noteCounts(): { notes: number; nodes: number } {
    return this.noteStore.counts();
  }

  /** Changes whenever a note is added or removed, in this process or another. */
  noteStamp(): string {
    return this.noteStore.stamp();
  }

  private viewNote(note: Note, fingerprints: Map<string, string | null>): NoteView {
    const node = this.store.getNode(note.nodeId);
    if (!node) return { ...note, stale: false, orphaned: true };
    let now = fingerprints.get(node.id);
    if (now === undefined) {
      now = this.fingerprint(node);
      fingerprints.set(node.id, now);
    }
    return { ...note, stale: note.anchor !== null && now !== note.anchor, orphaned: false };
  }

  /** What a node's source looks like right now, reduced to a hash. Null where there is no source. */
  private fingerprint(node: GraphNode): string | null {
    if (node.kind === "directory" || node.kind === "external") return null;
    if (node.kind === "file") return this.store.getFile(node.path)?.hash ?? null;
    const slice = this.readSource(node);
    return slice ? sha1(slice.text) : null;
  }

  /** Nodes an unknown id probably meant, for "did you mean" replies. */
  suggest(input: string, limit = 5): GraphNode[] {
    const id = toPosix(input.trim());
    const hash = id.indexOf("#");
    const path = hash < 0 ? id : id.slice(0, hash);
    const fragment = hash < 0 ? "" : id.slice(hash + 1);
    const seen = new Map<string, GraphNode>();

    // Right file, wrong symbol: point at the file so its outline can be read.
    const container = fragment ? this.node(path) : null;
    if (container) seen.set(container.id, container);

    const base = path.split("/").filter(Boolean).pop() ?? "";
    const queries = fragment ? [fragment, fragment.split(".").pop()!] : [base, base.replace(/\.[^.]+$/, "")];
    for (const query of queries) {
      if (query.length < 2) continue;
      const result = this.search({ query, limit });
      if (result.partial) continue;
      for (const hit of result.hits) if (!seen.has(hit.node.id)) seen.set(hit.node.id, hit.node);
    }
    return [...seen.values()].slice(0, limit);
  }

  /**
   * Read a node's lines from disk. Source text is never stored in the
   * database. Pass the same `cache` to several calls to read each file once.
   */
  readSource(node: GraphNode, cache?: Map<string, string[] | null>): SourceSlice | null {
    if (node.kind === "directory" || node.kind === "external" || !node.path) return null;
    let lines = cache?.get(node.path);
    if (lines === undefined) {
      lines = this.readLines(node.path);
      cache?.set(node.path, lines);
    }
    if (lines === null) return null;
    const startLine = Math.max(node.startLine ?? 1, 1);
    const endLine = Math.min(node.endLine ?? lines.length, lines.length);
    return {
      path: node.path,
      startLine,
      endLine,
      totalLines: lines.length,
      text: lines.slice(startLine - 1, endLine).join("\n"),
    };
  }

  private readLines(path: string): string[] | null {
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return null;
    }
    if (text.includes("\u0000")) return null; // binary
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
}
