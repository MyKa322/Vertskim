import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for a local embedding model server, speaking both dialects the
 * providers do (Ollama's and OpenAI's). Its "model" is a table of concepts:
 * words that mean the same thing land on the same axis, so text is close to
 * other text about the same subject whatever words it uses. That is all the
 * tests need of a model, and it is the same on every run.
 */

const CONCEPTS: string[][] = [
  ["login", "authenticate", "authentication", "credentials", "session", "sessions", "auth", "signin"],
  ["refresh", "rotate", "rotates", "renew", "renewal", "ttl", "invalidating", "expired", "expire"],
  ["persist", "store", "stores", "save", "database", "redis", "storage", "key"],
  ["report", "summary", "summarise", "render", "formatting", "format"],
  ["warn", "warning", "log", "info", "stderr", "diagnostics"],
  ["route", "routes", "handler", "middleware", "request", "requests", "endpoint"],
];
const DIMS = 32;
/** Instruction prefixes models are trained with; they carry no meaning of their own. */
const IGNORED = new Set(["search", "query", "document", "search_query", "search_document", "passage"]);

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 1 && !IGNORED.has(w));
}

export function fakeVector(text: string, scale = 1): number[] {
  const out = new Array<number>(DIMS).fill(0);
  for (const word of words(text)) {
    const concept = CONCEPTS.findIndex((group) => group.includes(word));
    if (concept >= 0) out[concept]! += 1;
    else {
      // Everything else is spread thinly over the remaining axes.
      let hash = 2166136261;
      for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619);
      out[CONCEPTS.length + ((hash >>> 0) % (DIMS - CONCEPTS.length))]! += 0.15;
    }
  }
  if (!out.some((v) => v !== 0)) out[DIMS - 1] = 1;
  // Deliberately not unit length: real servers do not all normalise either.
  return out.map((v) => v * scale);
}

export interface FakeModelServer {
  /** Base address for the Ollama dialect. */
  url: string;
  /** Base address for the OpenAI dialect. */
  openaiUrl: string;
  /** Every text the server was asked to embed, in order. */
  texts: string[];
  /** Number of embedding requests received. */
  requests: number;
  /** The `authorization` header of the last request, if it had one. */
  lastAuthorization: string | null;
  /** The body of the last embedding request. */
  lastBody: Record<string, unknown> | null;
  /** Answer every embedding request with this status from now on; 0 for normal service. */
  failWith: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startFakeModelServer(
  models = ["nomic-embed-text:latest", "all-minilm:latest", "llama3.2:latest"],
): Promise<FakeModelServer> {
  const state = {
    texts: [] as string[],
    requests: 0,
    lastAuthorization: null as string | null,
    lastBody: null as Record<string, unknown> | null,
    failWith: 0,
  };
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      if (req.method === "GET" && req.url === "/api/tags")
        return send(200, { models: models.map((name) => ({ name })) });
      const ollama = req.url === "/api/embed";
      if (req.method !== "POST" || (!ollama && req.url !== "/v1/embeddings")) return send(404, { error: "not found" });
      const body = JSON.parse(await readBody(req)) as { model: string; input: string[] };
      state.requests++;
      state.lastAuthorization = req.headers.authorization ?? null;
      state.lastBody = body as unknown as Record<string, unknown>;
      if (state.failWith) return send(state.failWith, { error: "the model is not loaded" });
      if (!models.some((name) => name === body.model || name.startsWith(`${body.model}:`))) {
        const message = `model "${body.model}" not found, try pulling it first`;
        return send(404, ollama ? { error: message } : { error: { message } });
      }
      state.texts.push(...body.input);
      // A second model has a space of its own: same axes, different size, so the two can be told apart.
      const dims = body.model.startsWith("nomic") ? DIMS : DIMS - 8;
      const vectors = body.input.map((text) => fakeVector(text, 3).slice(0, dims));
      if (ollama) return send(200, { model: body.model, embeddings: vectors });
      // Out of order on purpose: the reply's `index` says where each vector belongs.
      const data = vectors.map((embedding, index) => ({ object: "embedding", index, embedding })).reverse();
      return send(200, { object: "list", data, model: body.model });
    })().catch((err: Error) => send(500, { error: err.message }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
