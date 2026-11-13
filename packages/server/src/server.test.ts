import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Project } from "@vertskim/core";
import { UiBridge } from "./bridge.js";
import { findRunningUi } from "./registry.js";
import { startUiServer, type UiServer } from "./server.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/sample", import.meta.url));
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `vertskim-${prefix}-`));
  temps.push(dir);
  return dir;
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A raw request, for the things `fetch` will not let a caller set (the Host header). */
function raw(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Collects server-sent events from one connection. */
class EventLog {
  readonly events: { event: string; data: unknown }[] = [];
  private readonly controller = new AbortController();
  private waiters: (() => void)[] = [];

  constructor(url: string) {
    void this.read(url);
  }

  private async read(url: string): Promise<void> {
    try {
      const response = await fetch(url, { signal: this.controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event && data) this.events.push({ event, data: JSON.parse(data) });
          for (const wake of this.waiters.splice(0)) wake();
        }
      }
    } catch {
      // closed
    }
  }

  async next(event: string, timeoutMs = 5000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((e) => e.event === event);
      if (found) {
        this.events.splice(this.events.indexOf(found), 1);
        return found.data;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no "${event}" event within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 100));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  close(): void {
    this.controller.abort();
  }
}

describe("the local server", () => {
  let root: string;
  let project: Project;
  let server: UiServer;
  let assets: string;
  const get = (path: string, token = server.token) =>
    fetch(`${server.origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  // biome-ignore lint/suspicious/noExplicitAny: JSON from the API under test; the assertions check its shape
  const json = async (path: string) => (await get(path)).json() as Promise<Record<string, any>>;

  before(async () => {
    root = tempDir("project");
    cpSync(FIXTURE, root, { recursive: true });
    assets = tempDir("assets");
    mkdirSync(join(assets, "assets"));
    writeFileSync(join(assets, "index.html"), "<!doctype html><title>test page</title>");
    writeFileSync(join(assets, "assets", "app-abc123.js"), "console.log('app');");
    writeFileSync(join(tempDir("outside"), "secret.txt"), "secret");
    project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
    server = await startUiServer(project, { port: 0, assetsDir: assets });
  });
  after(async () => {
    await server.close();
    await project.close();
  });

  test("listens on loopback only and hands out a link carrying the token", () => {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(server.link(), `${server.origin}/?t=${server.token}`);
    assert.equal(server.link("src/a.ts#B"), `${server.origin}/?t=${server.token}#focus=src%2Fa.ts%23B`);
    assert.ok(server.token.length >= 20);
  });

  test("refuses API calls without the token, from another host name, or from another site", async () => {
    assert.equal((await fetch(`${server.origin}/api/status`)).status, 401);
    assert.equal((await get("/api/status", "wrong-token")).status, 401);
    assert.equal((await get("/api/status")).status, 200);
    assert.equal((await fetch(`${server.origin}/api/status?t=${server.token}`)).status, 200);

    const auth = { Authorization: `Bearer ${server.token}` };
    // DNS rebinding: the request reaches us, but under a name that is not ours.
    assert.equal((await raw(server.port, "/api/status", { ...auth, Host: "evil.example" })).status, 403);
    assert.equal((await raw(server.port, "/", { Host: `evil.example:${server.port}` })).status, 403);
    assert.equal((await raw(server.port, "/api/status", { ...auth, Host: `localhost:${server.port}` })).status, 200);
    const foreign = await raw(server.port, "/api/status", {
      ...auth,
      Host: `127.0.0.1:${server.port}`,
      Origin: "https://evil.example",
    });
    assert.equal(foreign.status, 403);
  });

  test("serves the page and its files, and nothing outside them", async () => {
    const page = await fetch(`${server.origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(await page.text(), /test page/);

    const script = await fetch(`${server.origin}/assets/app-abc123.js`);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(script.headers.get("cache-control") ?? "", /immutable/);
    // Sent compressed to a browser that accepts it (fetch asks for gzip and unpacks it), plain otherwise.
    assert.equal(script.headers.get("content-encoding"), "gzip");
    const plain = await raw(server.port, "/assets/app-abc123.js", { Host: `127.0.0.1:${server.port}` });
    assert.equal(plain.status, 200);
    assert.match(plain.body, /app/);

    assert.equal((await fetch(`${server.origin}/assets/missing.js`)).status, 404);
    // a path that is not a file is the page itself, as in any single-page app
    assert.match(await (await fetch(`${server.origin}/some/route`)).text(), /test page/);
    for (const path of ["/../secret.txt", "/..%2f..%2fsecret.txt", "/assets/..%5c..%5csecret.txt"]) {
      const response = await raw(server.port, path, { Host: `127.0.0.1:${server.port}` });
      assert.doesNotMatch(response.body, /^secret$/);
    }
    assert.equal((await fetch(`${server.origin}/`, { method: "POST" })).status, 405);
  });

  test("answers the questions the page asks", async () => {
    const status = await json("/api/status");
    assert.equal(status.files, 18);
    assert.equal(typeof status.version, "string");

    const view = await (
      await fetch(`${server.origin}/api/view`, {
        method: "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expanded: [] }),
      })
    ).json();
    assert.equal((view as { nodes: unknown[] }).nodes.length, 8);

    const node = await json(`/api/node?id=${encodeURIComponent("src/auth/session.ts#SessionStore.refresh")}`);
    assert.equal(node.node.kind, "method");
    assert.deepEqual(node.reveal.slice(0, 2), ["src/", "src/auth/"]);
    assert.ok(node.edges.some((g: { kind: string; direction: string }) => g.kind === "calls" && g.direction === "out"));

    const source = await json(`/api/source?id=${encodeURIComponent("src/auth/tokens.ts#rotate")}`);
    assert.equal(source.available, true);
    assert.equal(source.startLine, 10);
    assert.match(source.text, /export function rotate/);
    assert.equal((await json("/api/source?id=src/")).available, false);

    const search = await json("/api/search?q=rotate");
    assert.equal(search.hits[0].node.id, "src/auth/tokens.ts#rotate");
    // Search by meaning is off here, so nothing is marked as found by it.
    assert.equal(search.hits[0].byMeaning, false);
    assert.deepEqual((await json("/api/reveal?id=README.md")).expand, []);

    // The explorer's list of files: every one of them, each a node of the graph.
    const tree = await json("/api/tree");
    assert.equal(tree.files.length, status.files);
    assert.equal(tree.version, status.version);
    const session = tree.files.find((f: { path: string }) => f.path === "src/auth/session.ts");
    assert.equal(session.language, "typescript");
    assert.equal(session.subkind, "source");
    assert.equal(session.syntaxError, null);

    assert.equal((await get("/api/node?id=src/nope.ts")).status, 404);
    assert.equal((await get("/api/node")).status, 400);
    assert.equal((await get("/api/unknown")).status, 404);
    const bad = await fetch(`${server.origin}/api/view`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}` },
      body: "not json",
    });
    assert.equal(bad.status, 400);
  });

  test("pushes activity, focus requests and graph changes to open pages", async () => {
    const log = new EventLog(`${server.origin}/api/events?t=${server.token}`);
    const hello = (await log.next("hello")) as { status: { files: number }; trail: unknown[] };
    assert.equal(hello.status.files, 18);

    server.trail("graph_node", ["src/auth/tokens.ts#rotate", "no/such/node.ts"]);
    const trail = (await log.next("trail")) as { tool: string; ids: string[] };
    assert.equal(trail.tool, "graph_node");
    assert.deepEqual(trail.ids, ["src/auth/tokens.ts#rotate"]); // unknown ids are dropped

    const posted = await fetch(`${server.origin}/api/focus`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "src/index.ts" }),
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(await log.next("focus"), { id: "src/index.ts" });

    const file = join(root, "src", "utils", "clock.ts");
    writeFileSync(file, "export function now(): number {\n  return Date.now();\n}\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    await project.sync({ paths: ["src/utils/clock.ts"] });
    const changed = (await log.next("changed")) as { status: { files: number } };
    assert.equal(changed.status.files, 19);

    // A page that connects later is told what happened recently.
    const second = new EventLog(`${server.origin}/api/events?t=${server.token}`);
    const replay = (await second.next("hello")) as { trail: { tool: string }[] };
    assert.equal(replay.trail.at(-1)?.tool, "graph_node");
    log.close();
    second.close();
  });
});

describe("notes through the local server", () => {
  test("are saved, listed, removed, and announced to open pages", async () => {
    const root = tempDir("project");
    cpSync(FIXTURE, root, { recursive: true });
    const project = Project.open({ root, dataDir: tempDir("data") });
    await project.sync();
    const server = await startUiServer(project, { port: 0, assetsDir: null });
    const auth = { Authorization: `Bearer ${server.token}` };
    const post = (path: string, body: unknown) =>
      fetch(`${server.origin}${path}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const get = async (path: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: JSON from the API under test; the assertions check its shape
      (await (await fetch(`${server.origin}${path}`, { headers: auth })).json()) as Record<string, any>;
    const log = new EventLog(`${server.origin}/api/events?t=${server.token}`);
    await log.next("hello");

    const id = "src/auth/tokens.ts#rotate";
    const added = await post("/api/notes", { id, text: "Keep it idempotent." });
    assert.equal(added.status, 200);
    const { note } = (await added.json()) as { note: { id: number; author: string } };
    assert.equal(note.author, "3D view");
    assert.deepEqual(await log.next("notes"), { counts: { notes: 1, nodes: 1 } });

    assert.equal((await get(`/api/node?id=${encodeURIComponent(id)}`)).notes[0].text, "Keep it idempotent.");
    assert.deepEqual((await get("/api/node?id=src/index.ts")).notes, []);
    assert.equal((await get("/api/notes")).notes[0].nodeId, id);

    // A note written elsewhere, as an assistant's would be, reaches the page as well.
    project.addNote("src/index.ts", "Entry point.", "assistant");
    assert.deepEqual(await log.next("notes"), { counts: { notes: 2, nodes: 2 } });

    assert.equal((await post("/api/notes", { id: "src/nope.ts", text: "x" })).status, 404);
    assert.equal((await post("/api/notes", { id, text: "   " })).status, 400);
    assert.equal((await post("/api/notes", { id })).status, 400);
    assert.equal((await fetch(`${server.origin}/api/notes`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await post("/api/notes/remove", { note: note.id })).status, 200);
    assert.equal((await post("/api/notes/remove", { note: note.id })).status, 404);
    assert.equal((await get("/api/notes")).counts.notes, 1);

    log.close();
    await server.close();
    await project.close();
  });
});

describe("one visualizer per project", () => {
  test("a second process finds the first and forwards to it", async () => {
    const root = tempDir("project");
    cpSync(FIXTURE, root, { recursive: true });
    const dataDir = tempDir("data");
    const first = Project.open({ root, dataDir });
    await first.sync();
    const second = Project.open({ root, dataDir });

    assert.equal(await findRunningUi(dataDir), null);
    const owner = new UiBridge(first, { port: 0, assetsDir: null });
    const link = await owner.open();
    assert.equal(owner.serving, true);
    assert.equal(await owner.open(), link); // opening twice does not start a second server
    assert.ok(existsSync(join(dataDir, "ui.json")));

    const other = new UiBridge(second, { port: 0, assetsDir: null });
    assert.equal(await other.open(), link);
    assert.equal(other.serving, false);

    const origin = new URL(link).origin;
    const token = new URL(link).searchParams.get("t")!;
    const log = new EventLog(`${origin}/api/events?t=${token}`);
    await log.next("hello");
    other.trail("graph_impact", ["src/auth/tokens.ts#rotate"]);
    assert.equal(((await log.next("trail")) as { tool: string }).tool, "graph_impact");
    const focused = await other.open("src/index.ts#main");
    assert.match(focused, /#focus=src%2Findex\.ts%23main$/);
    assert.deepEqual(await log.next("focus"), { id: "src/index.ts#main" });
    log.close();

    // Without the built page the server says so instead of failing.
    assert.equal((await fetch(`${origin}/`)).status, 503);

    await owner.close();
    assert.equal(existsSync(join(dataDir, "ui.json")), false);
    assert.equal(await findRunningUi(dataDir), null);
    await other.close();
    await first.close();
    await second.close();
  });
});
