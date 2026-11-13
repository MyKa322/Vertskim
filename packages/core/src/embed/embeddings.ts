import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import type { GraphNode } from "../types.js";
import { sha1 } from "../util.js";
import { withFileLock } from "../watch/lock.js";
import { checkConfig, createEmbedder, type Embedder, type EmbeddingConfig } from "./provider.js";
import { EMBEDDED_KINDS, embeddingText, TEXT_VERSION } from "./text.js";
import { VectorStore, type VectorRow } from "./vectors.js";

export interface EmbeddingStatus {
  /** True when a model has been chosen for this project. */
  enabled: boolean;
  provider: string | null;
  model: string | null;
  url: string | null;
  /** Nodes that have a vector made by the current model. */
  embedded: number;
  /** Nodes that should have one. */
  total: number;
  /** True when the project has more nodes than are embedded at most. */
  capped: boolean;
  running: boolean;
  /** Why the last attempt to reach the model failed, if it did. */
  error: string | null;
}

export interface EmbedProgress {
  done: number;
  total: number;
}

export interface EmbedResult {
  /** Vectors made in this pass. */
  embedded: number;
  /** Vectors dropped because their node is gone. */
  removed: number;
  /** Nodes that have a vector now. */
  total: number;
}

/** A node found by meaning. */
export interface SemanticHit {
  id: string;
  /** Cosine similarity to the query, -1 to 1. */
  similarity: number;
  /** How far above the typical node that is, in standard deviations: comparable between models. */
  lift: number;
}

const CONFIG_FILE = "embeddings.json";
const BATCH_SIZE = 32;
const BATCH_CHARS = 24_000;
/** Vectors are searched in memory; this keeps a huge repository from taking it all. */
export const MAX_VECTORS = 80_000;
/** A query waits this long for the model before the search goes ahead without it. */
const QUERY_TIMEOUT_MS = 6000;
/** The first query of a process may have to wait for the model to be loaded. */
const FIRST_QUERY_TIMEOUT_MS = 20_000;
/** After the model fails to answer a query it is left alone for this long. */
const COOL_OFF_MS = 30_000;
const CONFIG_CHECK_MS = 1000;
const QUERY_CACHE = 12;

/**
 * Optional search by meaning. Off until a model is chosen; from then on every
 * function, class, doc section and file gets a vector, remade only when its
 * text changes. The model itself runs outside Vertskim (see provider.ts).
 */
export class Embeddings {
  private readonly vectors: VectorStore;
  private loaded: { mtimeMs: number; config: EmbeddingConfig | null; embedder: Embedder | null } | null = null;
  private lastConfigCheck = 0;
  private running: Promise<EmbedResult> | null = null;
  private abort: AbortController | null = null;
  private lastError: string | null = null;
  private quietUntil = 0;
  private readonly queries = new Map<string, Float32Array>();
  private wanted = 0;
  private capped = false;
  private answered = false;
  private warmed = false;

  constructor(
    private readonly store: GraphStore,
    private readonly dataDir: string,
    private readonly readLines: (path: string) => string[] | null,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.vectors = new VectorStore(join(dataDir, "vectors.db"));
  }

  private get configPath(): string {
    return join(this.dataDir, CONFIG_FILE);
  }

  private load(): { config: EmbeddingConfig | null; embedder: Embedder | null } {
    const now = Date.now();
    if (this.loaded && now - this.lastConfigCheck < CONFIG_CHECK_MS) return this.loaded;
    this.lastConfigCheck = now;
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.configPath).mtimeMs;
    } catch {
      // no file: embeddings are off
    }
    if (this.loaded?.mtimeMs === mtimeMs) return this.loaded;
    let config: EmbeddingConfig | null = null;
    if (mtimeMs >= 0) {
      try {
        config = checkConfig(JSON.parse(readFileSync(this.configPath, "utf8")));
      } catch (err) {
        this.lastError = `${CONFIG_FILE}: ${(err as Error).message}`;
        this.log(`embeddings are off: ${this.lastError}`);
      }
    }
    this.loaded = { mtimeMs, config, embedder: config ? createEmbedder(config) : null };
    this.queries.clear();
    this.quietUntil = 0;
    return this.loaded;
  }

  /** The model chosen for this project, or null when embeddings are off. */
  config(): EmbeddingConfig | null {
    return this.load().config;
  }

  /** True when a search by meaning can be answered: a model is chosen and it has made vectors. */
  ready(): boolean {
    const { embedder } = this.load();
    return embedder !== null && this.vectors.model() === embedder.id && this.vectors.count() > 0;
  }

  /**
   * Choose a model, after making sure it answers. Vectors from a different
   * model are discarded the next time vectors are made.
   */
  async configure(raw: unknown): Promise<EmbeddingConfig> {
    const config = checkConfig(raw);
    await createEmbedder(config).embed(["a short test sentence"], "query", { timeoutMs: 60_000 });
    writeFileSync(this.configPath, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`);
    this.loaded = null;
    this.lastError = null;
    return config;
  }

  /** Switch embeddings off and delete what was made. */
  async disable(): Promise<void> {
    this.abort?.abort();
    await this.running?.catch(() => undefined);
    rmSync(this.configPath, { force: true });
    this.vectors.clear();
    this.loaded = null;
    this.lastError = null;
    this.wanted = 0;
    this.capped = false;
  }

  status(): EmbeddingStatus {
    const { config, embedder } = this.load();
    const current = embedder !== null && this.vectors.model() === embedder.id;
    return {
      enabled: config !== null,
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      url: config?.url ?? null,
      embedded: current ? this.vectors.count() : 0,
      total: config ? this.wanted || this.countWanted() : 0,
      capped: this.capped,
      running: this.running !== null,
      error: this.lastError,
    };
  }

  private kindList(): string {
    return EMBEDDED_KINDS.map((k) => `'${k}'`).join(", ");
  }

  private countWanted(): number {
    const row = this.store
      .stmt(
        `SELECT COUNT(*) AS c FROM nodes n WHERE n.kind IN (${this.kindList()})
         AND (n.kind != 'file' OR EXISTS (SELECT 1 FROM files f WHERE f.path = n.path AND f.lines > 0))`,
      )
      .get();
    return Math.min(Number(row?.c ?? 0), MAX_VECTORS);
  }

  /**
   * Make vectors for everything that lacks one or whose text changed, and drop
   * those whose node is gone. Concurrent callers share one pass; several
   * processes take turns.
   */
  update(onProgress?: (progress: EmbedProgress) => void, maxNew = Infinity): Promise<EmbedResult> {
    this.running ??= this.runUpdate(onProgress, maxNew).finally(() => {
      this.running = null;
      this.abort = null;
    });
    return this.running;
  }

  /** True while the model is being left alone after failing to answer. */
  coolingOff(): boolean {
    return Date.now() < this.quietUntil;
  }

  /** Have the model loaded before the first search needs it. Errors are left for the search to report. */
  warmUp(): void {
    const { embedder } = this.load();
    if (!embedder || this.warmed) return;
    this.warmed = true;
    embedder.embed(["warm up"], "query", { timeoutMs: FIRST_QUERY_TIMEOUT_MS }).then(
      () => {
        this.answered = true;
      },
      () => undefined,
    );
  }

  /** Stop a pass in flight; what it has stored so far is kept. */
  async stop(): Promise<void> {
    this.abort?.abort();
    await this.running?.catch(() => undefined);
  }

  close(): void {
    this.abort?.abort();
    this.vectors.close();
  }

  private async runUpdate(
    onProgress: ((progress: EmbedProgress) => void) | undefined,
    maxNew: number,
  ): Promise<EmbedResult> {
    const { embedder } = this.load();
    if (!embedder) return { embedded: 0, removed: 0, total: 0 };
    const abort = new AbortController();
    this.abort = abort;
    try {
      const result = await withFileLock(join(this.dataDir, "embed.lock"), () =>
        this.pass(embedder, abort.signal, onProgress, maxNew),
      );
      // Only a pass that got vectors out of the model shows that it answers again.
      if (result.embedded > 0) {
        this.lastError = null;
        this.quietUntil = 0;
      }
      return result;
    } catch (err) {
      if (!abort.signal.aborted) this.lastError = (err as Error).message;
      throw err;
    }
  }

  private async pass(
    embedder: Embedder,
    signal: AbortSignal,
    onProgress?: (progress: EmbedProgress) => void,
    maxNew = Infinity,
  ): Promise<EmbedResult> {
    if (this.vectors.model() !== embedder.id) {
      // Only the first vector creates the database; until then there is nothing to reset.
      if (this.vectors.model() !== null || this.vectors.count() > 0) this.vectors.reset(embedder.id);
    }
    const known = this.vectors.known();
    // Texts made by an older recipe are worked out again; only those that came out different are re-embedded.
    const recipeChanged = known.size > 0 && this.vectors.textVersion() !== TEXT_VERSION;
    const files = this.store.allFiles();
    // An empty or half-built graph says nothing about which vectors are still wanted.
    const settled = files.size > 0 && this.store.getMeta("dirty") !== "1";
    if (files.size === 0) return { embedded: 0, removed: 0, total: this.vectors.count() };
    const rows = this.store.db
      .prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE kind IN (${this.kindList()}) ORDER BY path, start_line`)
      .all();

    const queue: { id: string; text: string; textHash: string; fileHash: string }[] = [];
    const unchanged: { id: string; fileHash: string }[] = [];
    const wanted = new Set<string>();
    this.capped = false;

    const flushFile = (path: string, nodes: GraphNode[]) => {
      const record = files.get(path);
      if (!record) return;
      // A file that was not parsed (an image, a lock file) has nothing to say beyond its name.
      const usable = nodes.filter((n) => n.kind !== "file" || record.lines > 0);
      if (usable.length === 0) return;
      const fresh = !recipeChanged && usable.every((n) => known.get(n.id)?.fileHash === record.hash);
      const lines = fresh ? null : this.readLines(path);
      for (const node of usable) {
        if (wanted.size >= MAX_VECTORS) {
          this.capped = true;
          return;
        }
        wanted.add(node.id);
        if (fresh) continue;
        const members =
          node.kind === "file" || node.kind === "class" || node.kind === "interface"
            ? this.store.children(node.id).map((child) => child.name)
            : [];
        const text = embeddingText(node, lines, members);
        const textHash = sha1(text);
        if (known.get(node.id)?.textHash === textHash) unchanged.push({ id: node.id, fileHash: record.hash });
        else queue.push({ id: node.id, text, textHash, fileHash: record.hash });
      }
    };

    let path: string | null = null;
    let group: GraphNode[] = [];
    for (const row of rows) {
      const node = rowToNode(row);
      if (node.path !== path) {
        if (path !== null) flushFile(path, group);
        path = node.path;
        group = [];
      }
      group.push(node);
    }
    if (path !== null) flushFile(path, group);
    this.wanted = wanted.size;

    const gone: string[] = [];
    if (settled && !this.capped) for (const id of known.keys()) if (!wanted.has(id)) gone.push(id);
    this.vectors.remove(gone);
    this.vectors.touch(unchanged);

    if (queue.length > maxNew) {
      // Too much changed to embed before answering: the search goes ahead with the vectors there are.
      this.log(
        `embeddings: ${queue.length} nodes changed since their vectors were made; run vertskim embed to bring them up to date`,
      );
      return { embedded: 0, removed: gone.length, total: this.vectors.count() };
    }
    let done = 0;
    onProgress?.({ done, total: queue.length });
    for (let i = 0; i < queue.length; ) {
      if (signal.aborted) throw new Error("stopped");
      const batch: typeof queue = [];
      let chars = 0;
      while (
        i < queue.length &&
        batch.length < BATCH_SIZE &&
        (batch.length === 0 || chars + queue[i]!.text.length <= BATCH_CHARS)
      ) {
        chars += queue[i]!.text.length;
        batch.push(queue[i++]!);
      }
      const made = await embedder.embed(
        batch.map((item) => item.text),
        "document",
        { signal },
      );
      if (this.vectors.model() !== embedder.id) this.vectors.reset(embedder.id);
      const stored: VectorRow[] = batch.map((item, n) => ({
        id: item.id,
        textHash: item.textHash,
        fileHash: item.fileHash,
        vector: made[n]!,
      }));
      this.vectors.put(stored);
      done += batch.length;
      onProgress?.({ done, total: queue.length });
    }
    if (this.vectors.count() > 0 || queue.length > 0) this.vectors.setTextVersion(TEXT_VERSION);
    if (queue.length > 0 || gone.length > 0) {
      this.log(`embeddings: ${queue.length} made, ${gone.length} dropped, ${this.vectors.count()} in all`);
    }
    return { embedded: queue.length, removed: gone.length, total: this.vectors.count() };
  }

  /**
   * The nodes whose text is closest in meaning to the query, best first. Null
   * when embeddings are off, nothing is embedded yet, or the model did not
   * answer in time: the caller then makes do with matching by name.
   */
  async search(query: string, limit: number): Promise<SemanticHit[] | null> {
    const { embedder } = this.load();
    if (!embedder || Date.now() < this.quietUntil) return null;
    if (this.vectors.model() !== embedder.id) return null;
    const matrix = this.vectors.matrix();
    if (!matrix || matrix.ids.length === 0) return null;

    const text = query.trim().slice(0, 2000);
    if (text === "") return null;
    let vector = this.queries.get(text);
    if (!vector) {
      try {
        [vector] = await embedder.embed([text], "query", {
          timeoutMs: this.answered ? QUERY_TIMEOUT_MS : FIRST_QUERY_TIMEOUT_MS,
        });
        this.answered = true;
      } catch (err) {
        this.lastError = (err as Error).message;
        this.quietUntil = Date.now() + COOL_OFF_MS;
        this.log(`search by meaning is unavailable (${this.lastError}); matching by name only for now`);
        return null;
      }
      if (!vector) return null;
      if (this.queries.size >= QUERY_CACHE) this.queries.delete(this.queries.keys().next().value!);
      this.queries.set(text, vector);
    }
    const { ids, dims, data } = matrix;
    if (vector.length !== dims) return null;

    const count = ids.length;
    const scores = new Float32Array(count);
    let sum = 0;
    let squares = 0;
    for (let n = 0, offset = 0; n < count; n++, offset += dims) {
      let dot = 0;
      for (let i = 0; i < dims; i++) dot += data[offset + i]! * vector[i]!;
      scores[n] = dot;
      sum += dot;
      squares += dot * dot;
    }
    const mean = sum / count;
    const deviation = Math.sqrt(Math.max(squares / count - mean * mean, 0));
    const order = Array.from({ length: count }, (_, n) => n).sort((a, b) => scores[b]! - scores[a]!);
    return order.slice(0, Math.max(limit, 1)).map((n) => ({
      id: ids[n]!,
      similarity: scores[n]!,
      lift: deviation > 1e-6 ? (scores[n]! - mean) / deviation : 0,
    }));
  }
}
