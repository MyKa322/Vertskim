/**
 * Embedding models are not part of Vertskim. They run in something the user
 * already has: a local model server (Ollama, LM Studio, llama.cpp and anything
 * else speaking the OpenAI embeddings dialect) or, in-process, the optional
 * `@huggingface/transformers` package. This file is the only place that talks
 * to them.
 */

export const PROVIDERS = ["ollama", "openai", "transformers"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface EmbeddingConfig {
  provider: ProviderName;
  /** Model name as the provider knows it, e.g. `nomic-embed-text`. */
  model: string;
  /** Where the model server listens. Not used by the in-process provider. */
  url?: string;
  /** Permit a server that is not on this machine. Source text is sent to it. */
  allowRemote?: boolean;
  /** Name of an environment variable holding a key for servers that want one. The key is never stored. */
  apiKeyEnv?: string;
  /** Text put in front of a search query, overriding what is known about the model. */
  queryPrefix?: string;
  /** Text put in front of each piece of code or documentation, overriding what is known about the model. */
  documentPrefix?: string;
  /** How long Ollama keeps the model loaded after a request, in its own format (`30m`, `-1` for always). */
  keepAlive?: string;
}

/** Ollama unloads a model after five idle minutes by default, and loading it again delays the next search. */
const DEFAULT_KEEP_ALIVE = "30m";

export interface EmbedOptions {
  timeoutMs?: number;
  /** Aborting it abandons the request. */
  signal?: AbortSignal;
}

export interface Embedder {
  /** Names the vector space. Vectors made under different ids cannot be compared. */
  readonly id: string;
  embed(texts: string[], kind: "query" | "document", options?: EmbedOptions): Promise<Float32Array[]>;
}

/**
 * Where a provider's server is expected when no address is given: Ollama's
 * usual port, honouring `OLLAMA_HOST` as Ollama's own tools do, or LM Studio's.
 */
export function defaultUrl(provider: Exclude<ProviderName, "transformers">): string {
  if (provider === "openai") return "http://127.0.0.1:1234/v1";
  const host = process.env.OLLAMA_HOST?.trim();
  if (!host) return "http://127.0.0.1:11434";
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(host) ? host : `http://${host}`);
    // A server told to listen on every interface is reached on this one.
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (url.port === "" && !/^[a-z]+:\/\//i.test(host)) url.port = "11434";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "http://127.0.0.1:11434";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** True when the address can only be this machine. */
export function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Check a configuration read from disk or the command line, filling in defaults. Throws with a usable message. */
export function checkConfig(raw: unknown): EmbeddingConfig {
  const input = (raw ?? {}) as Record<string, unknown>;
  const provider = input.provider;
  if (typeof provider !== "string" || !(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`unknown embedding provider ${JSON.stringify(provider)}; use one of ${PROVIDERS.join(", ")}`);
  }
  if (typeof input.model !== "string" || input.model.trim() === "") {
    throw new Error("an embedding model has to be named");
  }
  const config: EmbeddingConfig = { provider: provider as ProviderName, model: input.model.trim() };
  if (config.provider !== "transformers") {
    const url =
      typeof input.url === "string" && input.url.trim() !== "" ? input.url.trim() : defaultUrl(config.provider);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${url} is not a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${url} is not an http(s) URL`);
    config.url = url.replace(/\/+$/, "");
    if (input.allowRemote === true) config.allowRemote = true;
    if (!config.allowRemote && !isLoopback(config.url)) {
      throw new Error(
        `${config.url} is not on this machine. Embedding sends source text to the model server; ` +
          "allow a remote one explicitly if that is what you want.",
      );
    }
    if (typeof input.apiKeyEnv === "string" && input.apiKeyEnv !== "") config.apiKeyEnv = input.apiKeyEnv;
  }
  if (typeof input.keepAlive === "string" && config.provider === "ollama") config.keepAlive = input.keepAlive;
  if (typeof input.queryPrefix === "string") config.queryPrefix = input.queryPrefix;
  if (typeof input.documentPrefix === "string") config.documentPrefix = input.documentPrefix;
  return config;
}

/**
 * Some models are trained with a short instruction in front of the text and
 * search noticeably worse without it. These are the ones in common local use.
 */
export function prefixesFor(config: EmbeddingConfig): { query: string; document: string } {
  const model = config.model.toLowerCase();
  let known = { query: "", document: "" };
  if (model.includes("nomic-embed")) known = { query: "search_query: ", document: "search_document: " };
  else if (/(^|[/_-])e5[_-]/.test(model)) known = { query: "query: ", document: "passage: " };
  else if (/(^|[/_-])bge-(small|base|large)/.test(model) || model.includes("mxbai-embed")) {
    known = { query: "Represent this sentence for searching relevant passages: ", document: "" };
  }
  return {
    query: config.queryPrefix ?? known.query,
    document: config.documentPrefix ?? known.document,
  };
}

function normalise(values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    out[i] = v;
    sum += v * v;
  }
  const length = Math.sqrt(sum);
  if (!Number.isFinite(length) || length === 0) throw new Error("the model returned an empty or invalid vector");
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / length;
  return out;
}

function checkVectors(vectors: Float32Array[], expected: number): Float32Array[] {
  if (vectors.length !== expected) {
    throw new Error(`asked for ${expected} vectors, the model returned ${vectors.length}`);
  }
  const dims = vectors[0]?.length ?? 0;
  if (dims === 0 || vectors.some((v) => v.length !== dims))
    throw new Error("the model returned vectors of differing sizes");
  return vectors;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: EmbedOptions,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
    });
  } catch (err) {
    const error = err as Error & { cause?: { code?: string } };
    if (options.signal?.aborted) throw new Error("stopped");
    if (error.name === "TimeoutError")
      throw new Error(`${url} did not answer within ${Math.round(timeoutMs / 1000)} s`);
    throw new Error(`could not reach ${url} (${error.cause?.code ?? error.message}); is the model server running?`);
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 300).trim();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      const inner = typeof parsed.error === "string" ? parsed.error : (parsed.error as { message?: unknown })?.message;
      if (typeof inner === "string") detail = inner;
    } catch {
      // not JSON: the raw text will do
    }
    throw new Error(`${url} answered ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} did not answer with JSON`);
  }
}

class HttpEmbedder implements Embedder {
  readonly id: string;
  private readonly prefixes: { query: string; document: string };

  constructor(private readonly config: EmbeddingConfig) {
    this.id = `${config.provider}:${config.model}`;
    this.prefixes = prefixesFor(config);
  }

  async embed(texts: string[], kind: "query" | "document", options: EmbedOptions = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const input = texts.map((text) => this.prefixes[kind] + text);
    const headers: Record<string, string> = {};
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
    if (key) headers.authorization = `Bearer ${key}`;

    if (this.config.provider === "ollama") {
      const body = { model: this.config.model, input, keep_alive: this.config.keepAlive ?? DEFAULT_KEEP_ALIVE };
      const reply = (await postJson(`${this.config.url}/api/embed`, body, headers, options)) as {
        embeddings?: number[][];
      };
      if (!Array.isArray(reply.embeddings)) throw new Error("the model server's reply has no embeddings in it");
      return checkVectors(reply.embeddings.map(normalise), texts.length);
    }
    const body = { model: this.config.model, input };
    const reply = (await postJson(`${this.config.url}/embeddings`, body, headers, options)) as {
      data?: { index?: number; embedding?: number[] }[];
    };
    if (!Array.isArray(reply.data)) throw new Error("the model server's reply has no embeddings in it");
    const ordered = [...reply.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return checkVectors(
      ordered.map((item) => normalise(item.embedding ?? [])),
      texts.length,
    );
  }
}

/** Runs the model inside this process with transformers.js, when that package has been installed. */
class TransformersEmbedder implements Embedder {
  readonly id: string;
  private readonly prefixes: { query: string; document: string };
  private pipeline: Promise<(texts: string[], options: object) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(private readonly config: EmbeddingConfig) {
    this.id = `transformers:${config.model}`;
    this.prefixes = prefixesFor(config);
  }

  private load(): Promise<(texts: string[], options: object) => Promise<{ tolist(): number[][] }>> {
    this.pipeline ??= (async () => {
      // Named through a variable so the package stays optional: nothing here needs it to build or run.
      const name = "@huggingface/transformers";
      let library: { pipeline(task: string, model: string): Promise<unknown> };
      try {
        library = (await import(name)) as typeof library;
      } catch {
        throw new Error(
          "the transformers provider needs the @huggingface/transformers package, which is not installed. " +
            "Install it next to vertskim (npm install @huggingface/transformers), or use a local model server instead.",
        );
      }
      return (await library.pipeline("feature-extraction", this.config.model)) as (
        texts: string[],
        options: object,
      ) => Promise<{ tolist(): number[][] }>;
    })();
    this.pipeline.catch(() => {
      this.pipeline = null; // let a later call try again
    });
    return this.pipeline;
  }

  async embed(texts: string[], kind: "query" | "document"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const run = await this.load();
    const output = await run(
      texts.map((text) => this.prefixes[kind] + text),
      { pooling: "mean", normalize: true },
    );
    return checkVectors(output.tolist().map(normalise), texts.length);
  }
}

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return config.provider === "transformers" ? new TransformersEmbedder(config) : new HttpEmbedder(config);
}

const EMBEDDING_MODEL_NAME = /embed|bge|e5|minilm|gte|arctic/i;

/**
 * Ask an Ollama server which models it has that are made for embedding.
 * Null when nothing answers at that address.
 */
export async function ollamaEmbeddingModels(
  url: string = defaultUrl("ollama"),
  timeoutMs = 1500,
): Promise<string[] | null> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as { models?: { name?: unknown }[] };
    if (!Array.isArray(body.models)) return null;
    return body.models
      .map((m) => (typeof m.name === "string" ? m.name : ""))
      .filter((name) => EMBEDDING_MODEL_NAME.test(name));
  } catch {
    return null;
  }
}
