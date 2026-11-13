import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Project } from "@vertskim/core";
import { pageLink, removeUiRecord, writeUiRecord } from "./registry.js";
import { locateAssets, serveStatic } from "./static.js";

export interface UiServerOptions {
  /** Port to listen on. Default 4517; another free port is used if it is taken. */
  port?: number;
  log?: (message: string) => void;
  /** Folder with the built visualizer. Default: the one shipped with @vertskim/ui. */
  assetsDir?: string | null;
}

export interface TrailEvent {
  tool: string;
  ids: string[];
  at: number;
}

export interface UiServer {
  readonly origin: string;
  readonly port: number;
  readonly token: string;
  /** Page address, optionally opening on a node. */
  link(focus?: string): string;
  /** Show on the page which nodes were just queried. */
  trail(tool: string, ids: string[]): void;
  /** Make the page fly to a node. */
  focus(id: string): void;
  close(): Promise<void>;
}

export const DEFAULT_PORT = 4517;
const MAX_BODY_BYTES = 1_000_000;
const MAX_SOURCE_LINES = 400;
const TRAIL_KEPT = 30;
const POLL_MS = 700;
const HEARTBEAT_MS = 20_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "request body must be a JSON object");
  }
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new HttpError(400, `${name} must be a list of strings`);
  }
  return value as string[];
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // Loopback only: the graph and the source it can show never leave this machine.
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Serve the visualizer and the API behind it for one project.
 *
 * Reachable from this machine only, and only with the token in the page link:
 * requests must name a loopback host (which defeats DNS rebinding) and every
 * API call must carry the token (which keeps other local users out).
 */
export async function startUiServer(project: Project, options: UiServerOptions = {}): Promise<UiServer> {
  const log = options.log ?? (() => {});
  const assetsDir = options.assetsDir === undefined ? locateAssets() : options.assetsDir;
  const token = randomBytes(18).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const clients = new Set<ServerResponse>();
  const recentTrail: TrailEvent[] = [];
  let origin = "";
  let allowedHosts = new Set<string>();

  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  };
  const statusPayload = () => ({
    name: basename(project.root),
    root: project.root,
    version: project.graphVersion(),
    ...project.status(),
  });

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization;
    const given = header?.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("t") ?? "");
    const bytes = Buffer.from(given);
    return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
  };

  const requireNode = (url: URL) => {
    const id = url.searchParams.get("id");
    if (!id) throw new HttpError(400, "id is required");
    const node = project.node(id);
    if (!node) throw new HttpError(404, `no such node: ${id}`);
    return node;
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/status":
        return sendJson(res, 200, statusPayload());

      case "POST /api/view": {
        const body = await readJson(req);
        await project.refresh([], 3000);
        const maxNodes = typeof body.maxNodes === "number" ? body.maxNodes : undefined;
        const root = typeof body.root === "string" ? body.root : undefined;
        return sendJson(res, 200, project.view({ root, expanded: stringList(body.expanded, "expanded"), maxNodes }));
      }

      case "GET /api/tree": {
        await project.refresh([], 3000);
        // Paths only: the page builds the folders of its explorer from them.
        const files = [...project.store.allFiles().values()].map((file) => ({
          path: file.path,
          language: file.language,
          subkind: file.subkind,
          lines: file.lines,
          syntaxError: file.syntaxError ?? null,
        }));
        return sendJson(res, 200, { version: project.graphVersion(), files });
      }

      case "GET /api/node": {
        const id = url.searchParams.get("id") ?? "";
        await project.refresh(id ? [id] : [], 3000);
        const node = requireNode(url);
        return sendJson(res, 200, {
          ...project.details(node),
          reveal: project.reveal(node.id),
          notes: project.notesFor([node.id]).get(node.id) ?? [],
        });
      }

      case "GET /api/notes":
        return sendJson(res, 200, { notes: project.listNotes(60), counts: project.noteCounts() });

      case "POST /api/notes": {
        const body = await readJson(req);
        if (typeof body.id !== "string" || typeof body.text !== "string") {
          throw new HttpError(400, "id and text are required");
        }
        if (!project.node(body.id)) throw new HttpError(404, `no such node: ${body.id}`);
        try {
          const note = project.addNote(body.id, body.text, "3D view");
          announceNotes();
          return sendJson(res, 200, { note });
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }

      case "POST /api/notes/remove": {
        const body = await readJson(req);
        if (typeof body.note !== "number") throw new HttpError(400, "note (its number) is required");
        const removed = project.removeNote(body.note);
        if (!removed) throw new HttpError(404, `no note #${body.note}`);
        announceNotes();
        return sendJson(res, 200, { ok: true });
      }

      case "GET /api/source": {
        const node = requireNode(url);
        const slice = project.readSource(node);
        if (!slice) return sendJson(res, 200, { available: false });
        const lines = slice.text.split("\n");
        const shown = lines.slice(0, MAX_SOURCE_LINES);
        return sendJson(res, 200, {
          available: true,
          path: slice.path,
          startLine: slice.startLine,
          endLine: slice.startLine + shown.length - 1,
          totalLines: slice.totalLines,
          truncated: lines.length > shown.length,
          text: shown.join("\n"),
        });
      }

      case "GET /api/search": {
        const query = url.searchParams.get("q") ?? "";
        const asked = Number(url.searchParams.get("limit") ?? 12);
        const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 100) : 12;
        const result = await project.searchWithMeaning({ query, limit });
        return sendJson(res, 200, {
          partial: result.partial,
          hits: result.hits.map((hit) => ({ node: hit.node, fanIn: hit.fanIn, byMeaning: hit.byMeaning === true })),
        });
      }

      case "GET /api/reveal": {
        const node = requireNode(url);
        return sendJson(res, 200, { id: node.id, expand: project.reveal(node.id) });
      }

      case "GET /api/events": {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(
          `retry: 1500\nevent: hello\ndata: ${JSON.stringify({ status: statusPayload(), trail: recentTrail })}\n\n`,
        );
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      case "POST /api/trail": {
        const body = await readJson(req);
        const ids = stringList(body.ids, "ids") ?? [];
        publishTrail(typeof body.tool === "string" ? body.tool : "tool", ids);
        return sendJson(res, 200, { ok: true });
      }

      case "POST /api/focus": {
        const body = await readJson(req);
        if (typeof body.id !== "string") throw new HttpError(400, "id is required");
        const node = project.node(body.id);
        if (!node) throw new HttpError(404, `no such node: ${body.id}`);
        broadcast("focus", { id: node.id });
        return sendJson(res, 200, { ok: true, id: node.id });
      }

      default:
        throw new HttpError(404, "no such endpoint");
    }
  };

  // Notes can be written here, by an assistant in this process, or by another process.
  let lastNotes = project.noteStamp();
  const announceNotes = () => {
    const stamp = project.noteStamp();
    if (stamp === lastNotes) return;
    lastNotes = stamp;
    broadcast("notes", { counts: project.noteCounts() });
  };

  const publishTrail = (tool: string, ids: string[]) => {
    const known = [...new Set(ids)].filter((id) => project.node(id) !== null).slice(0, 40);
    if (known.length === 0) return;
    const event: TrailEvent = { tool, ids: known, at: Date.now() };
    recentTrail.push(event);
    if (recentTrail.length > TRAIL_KEPT) recentTrail.shift();
    broadcast("trail", event);
  };

  const server = createServer((req, res) => {
    const handle = async () => {
      if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) throw new HttpError(403, "forbidden host");
      const url = new URL(req.url ?? "/", origin);
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
        return serveStatic(res, assetsDir, url.pathname, req.headers["accept-encoding"]);
      }
      // A page on another site may not use the API even if it somehow learned the token.
      const from = req.headers.origin;
      if (from !== undefined && from !== origin && from !== origin.replace("127.0.0.1", "localhost")) {
        throw new HttpError(403, "forbidden origin");
      }
      if (!authorized(req, url)) throw new HttpError(401, "missing or wrong token; use the link printed by vertskim");
      await api(req, res, url);
    };
    handle().catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`request failed: ${(err as Error).message}`);
      if (res.headersSent) res.end();
      else sendJson(res, status, { error: err instanceof HttpError ? err.message : "internal error" });
    });
  });

  let port: number;
  try {
    port = await listen(server, options.port ?? DEFAULT_PORT);
  } catch (err) {
    // The preferred port is busy and the caller did not insist on it: take any free one.
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || options.port !== undefined) throw err;
    port = await listen(server, 0);
  }
  origin = `http://127.0.0.1:${port}`;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  writeUiRecord(project.dataDir, { pid: process.pid, port, token, startedAt: Date.now() });

  // Graph changes can come from this process or another one sharing the database,
  // so the version and status are watched rather than pushed.
  let lastVersion = project.graphVersion();
  let lastState = "";
  const poll = setInterval(() => {
    if (clients.size === 0) return;
    announceNotes();
    const status = statusPayload();
    const state = `${status.state}:${Math.round(status.progress * 20)}:${status.watching}:${status.error ?? ""}`;
    if (status.version !== lastVersion) {
      lastVersion = status.version;
      lastState = state;
      broadcast("changed", { status });
    } else if (state !== lastState) {
      lastState = state;
      broadcast("status", { status });
    }
  }, POLL_MS);
  poll.unref();
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let closed = false;
  return {
    origin,
    port,
    token,
    link: (focus) => pageLink(origin, token, focus),
    trail: publishTrail,
    focus: (id) => broadcast("focus", { id }),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      removeUiRecord(project.dataDir, process.pid);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
