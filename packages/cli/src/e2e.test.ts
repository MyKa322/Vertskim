import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/sample", import.meta.url));
const CLI = fileURLToPath(new URL("./index.js", import.meta.url));

describe("vertskim mcp over stdio", () => {
  let root: string;
  let dataDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text ?? "").join("\n"), isError: result.isError === true };
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "vertskim-e2e-project-"));
    dataDir = mkdtempSync(join(tmpdir(), "vertskim-e2e-data-"));
    cpSync(FIXTURE, root, { recursive: true });
    client = new Client({ name: "vertskim-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, "mcp", "--root", root, "--data-dir", dataDir],
        stderr: "ignore",
      }),
    );
  });

  after(async () => {
    await client.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    // The server may still hold the database for a moment after the pipe closes.
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("announces itself with usage instructions", () => {
    assert.equal(client.getServerVersion()?.name, "vertskim");
    assert.match(client.getInstructions() ?? "", /graph_search/);
  });

  test("lists its tools with schemas, read-only except the three that keep or start something", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "graph_annotate",
      "graph_context",
      "graph_impact",
      "graph_neighbors",
      "graph_node",
      "graph_open_ui",
      "graph_overview",
      "graph_path",
      "graph_search",
      "graph_sync",
    ]);
    for (const tool of tools) {
      const writes = ["graph_sync", "graph_open_ui", "graph_annotate"].includes(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, !writes);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.ok(tool.description && tool.description.length > 40);
      assert.equal(tool.inputSchema.type, "object");
      assert.match(client.getInstructions() ?? "", new RegExp(tool.name));
    }
    const search = tools.find((t) => t.name === "graph_search")!;
    assert.deepEqual(search.inputSchema.required, ["query"]);
  });

  test("graph_overview maps the project", async () => {
    const { text, isError } = await call("graph_overview", {});
    assert.equal(isError, false);
    assert.match(text, /18 files · 39 symbols · 2 test files/);
    assert.match(text, /src\/auth\/ {2}3 files/);
    assert.match(text, /entry points: .*src\/index\.ts/);
    const file = await call("graph_overview", { path: "src/index.ts" });
    assert.match(file.text, /not a directory\. Use graph_node/);
  });

  test("graph_impact lists dependents, tests and docs", async () => {
    const { text } = await call("graph_impact", { targets: ["src/auth/tokens.ts#rotate"] });
    assert.match(text, /direct \(1\)\n {2}src\/auth\/session\.ts#SessionStore\.refresh/);
    assert.match(text, /2 hops \(2\)/);
    assert.match(text, /tests to run \(1\): tests\/session\.test\.ts/);
    assert.match(text, /docs that refer to it \(2\)/);
    const none = await call("graph_impact", { targets: ["src/index.ts#main"], include_tests: false });
    assert.match(none.text, /direct \(1\)\n {2}src\/index\.ts {2}file/);
  });

  test("graph_path explains how one node reaches another", async () => {
    const forward = await call("graph_path", { from: "src/index.ts#main", to: "src/auth/tokens.ts#rotate" });
    assert.match(forward.text, /reaches src\/auth\/tokens\.ts#rotate in 4 hops/);
    assert.match(forward.text, /→ calls → src\/auth\/session\.ts#SessionStore\.refresh/);
    const backward = await call("graph_path", { from: "src/auth/tokens.ts#rotate", to: "src/index.ts#main" });
    assert.match(backward.text, /does not reach .* The other way round/);
    const part = await call("graph_path", { from: "src/auth/session.ts", to: "src/auth/session.ts#Session" });
    assert.match(part.text, /is part of src\/auth\/session\.ts/);
  });

  test("graph_context returns the core code within the budget", async () => {
    const source = await call("graph_context", { task: "session refresh", detail: "source", max_tokens: 1500 });
    assert.match(source.text, /## src\/auth\/session\.ts/);
    assert.match(source.text, /#SessionStore\.refresh {2}method · L23-35 {2}\[start\]/);
    assert.match(source.text, /32\| {5}const next: Session/);
    assert.doesNotMatch(source.text, /tools\//);
    assert.ok(source.text.length < 1500 * 3.6);

    const names = await call("graph_context", {
      seeds: ["src/db/redis.ts#RedisClient"],
      detail: "names",
      max_tokens: 300,
    });
    assert.match(names.text, /relevant: src\/db\/redis\.ts#RedisClient \(class\)/);
    assert.ok(names.text.length < 300 * 3.6);

    const neither = await call("graph_context", {});
    assert.equal(neither.isError, true);
  });

  test("sees a file written a moment before the query, and graph_sync reports changes", async () => {
    writeFileSync(join(root, "src/utils/clock.ts"), "export function now(): number {\n  return Date.now();\n}\n");
    const node = await call("graph_node", { ids: ["src/utils/clock.ts#now"] });
    assert.match(node.text, /src\/utils\/clock\.ts#now {2}function/);

    const upToDate = await call("graph_sync", {});
    assert.match(upToDate.text, /Already up to date|Updated:/);
    assert.match(upToDate.text, /index: fresh \(19 files/);

    rmSync(join(root, "src/utils/clock.ts"));
    const synced = await call("graph_sync", { paths: ["src/utils/clock.ts"] });
    assert.match(synced.text, /Already up to date|1 removed/);
    const gone = await call("graph_node", { ids: ["src/utils/clock.ts"] });
    assert.match(gone.text, /no such node/);
  });

  test("graph_open_ui starts the 3D view, which then shows what the assistant queries", async () => {
    const opened = await call("graph_open_ui", {});
    assert.equal(opened.isError, false);
    const link = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/.exec(opened.text)?.[0];
    assert.ok(link, opened.text);
    const { origin, searchParams } = new URL(link);
    const token = searchParams.get("t")!;

    // The page (built by `npm run build`) and the API behind it are up.
    assert.equal((await fetch(`${origin}/`)).status, 200);
    const status = await fetch(`${origin}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(((await status.json()) as { name: string }).name.startsWith("vertskim-e2e-project-"), true);
    assert.equal((await fetch(`${origin}/api/status`)).status, 401);

    // Listen as the page would, then make tool calls and watch them arrive.
    const controller = new AbortController();
    const stream = await fetch(`${origin}/api/events?t=${token}`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const until = async (pattern: RegExp) => {
      const deadline = Date.now() + 5000;
      while (!pattern.test(seen)) {
        if (Date.now() > deadline) throw new Error(`event stream never matched ${pattern}:\n${seen}`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
        ]);
        if (chunk && !chunk.done) seen += decoder.decode(chunk.value, { stream: true });
      }
    };
    await until(/event: hello/);
    await call("graph_neighbors", { id: "src/auth/tokens.ts#rotate" });
    await until(/event: trail\ndata: \{"tool":"graph_neighbors","ids":\["src\/auth\/tokens\.ts#rotate"/);

    const focused = await call("graph_open_ui", { focus: "src/index.ts#main" });
    assert.match(focused.text, /#focus=src%2Findex\.ts%23main/);
    assert.equal(/127\.0\.0\.1:(\d+)/.exec(focused.text)?.[1], new URL(link).port); // same server, not a second one
    await until(/event: focus\ndata: \{"id":"src\/index\.ts#main"\}/);
    controller.abort();

    const unknown = await call("graph_open_ui", { focus: "src/nope.ts" });
    assert.match(unknown.text, /no such node/);
  });

  test("graph_annotate keeps a note, and every later look at the node shows it", async () => {
    const id = "src/auth/tokens.ts#rotate";
    const saved = await call("graph_annotate", { id, note: "Keep rotation idempotent: retries call it twice." });
    assert.equal(saved.isError, false);
    assert.match(saved.text, /Saved as note #1 on src\/auth\/tokens\.ts#rotate/);

    // The note carries the name of the client that wrote it.
    const node = await call("graph_node", { ids: [id] });
    assert.match(
      node.text,
      /note #1 \(\d{4}-\d\d-\d\d · vertskim-test\): Keep rotation idempotent: retries call it twice\./,
    );
    const byName = await call("graph_search", { query: "rotate" });
    assert.match(byName.text, /#rotate {2}function[^\n]*\n[^\n]*\n[^\n]*\n {2}note #1/);
    const byWords = await call("graph_search", { query: "idempotent retries" });
    assert.match(byWords.text, /these notes mention it:\n {2}note #1 on src\/auth\/tokens\.ts#rotate/);
    const context = await call("graph_context", { seeds: [id] });
    assert.match(context.text, /notes on this code:\n {2}note #1 on src\/auth\/tokens\.ts#rotate/);
    const overview = await call("graph_overview", {});
    assert.match(overview.text, /notes left here \(1\)/);

    const inDirectory = await call("graph_annotate", { id: "src/auth" });
    assert.match(inDirectory.text, /1 note on src\/auth\/ and what it contains/);
    const elsewhere = await call("graph_annotate", { id: "src/db/" });
    assert.match(elsewhere.text, /No notes on src\/db\//);
    const all = await call("graph_annotate", {});
    assert.match(all.text, /1 note on 1 node, newest first:\nnote #1 on/);

    const unknown = await call("graph_annotate", { id: "src/nope.ts", note: "x" });
    assert.match(unknown.text, /no such node[\s\S]*Nothing was saved/);
    assert.equal((await call("graph_annotate", { note: "x" })).isError, true);

    const removed = await call("graph_annotate", { remove: 1 });
    assert.match(removed.text, /Removed note #1 from src\/auth\/tokens\.ts#rotate/);
    assert.match((await call("graph_annotate", { remove: 1 })).text, /There is no note #1/);
    assert.match((await call("graph_annotate", {})).text, /No notes yet/);
    assert.doesNotMatch((await call("graph_node", { ids: [id] })).text, /note #/);
  });

  test("graph_search finds a symbol", async () => {
    const { text, isError } = await call("graph_search", { query: "session refresh" });
    assert.equal(isError, false);
    assert.match(text, /src\/auth\/session\.ts#SessionStore\.refresh {2}method/);
    assert.match(text, /async refresh\(token: string\): Promise<Session>/);
    assert.match(text, /index: fresh \(18 files/);
  });

  test("graph_node returns an outline for a file and source for a symbol", async () => {
    const file = await call("graph_node", { ids: ["src/auth/session.ts"] });
    assert.match(file.text, /outline \(id = src\/auth\/session\.ts \+ suffix\)/);
    assert.match(file.text, /\.refresh {2}L23-35/);
    assert.doesNotMatch(file.text, /const session = await/);

    const symbol = await call("graph_node", { ids: ["src/auth/tokens.ts#rotate"], include: ["source"] });
    assert.match(symbol.text, /11\| export function rotate\(token: string\): string \{/);
    assert.doesNotMatch(symbol.text, /issueToken\(\): string/);
  });

  test("graph_neighbors lists callers and marks guesses", async () => {
    const typed = await call("graph_neighbors", {
      id: "src/auth/session.ts#SessionStore.refresh",
      direction: "in",
      edge_kinds: ["calls"],
    });
    assert.match(typed.text, /in calls \(2\)/);
    assert.match(typed.text, /\n {2}src\/api\/middleware\.ts#requireAuth/);
    const { text } = await call("graph_neighbors", {
      id: "tools/models.py#Record.label",
      direction: "in",
      edge_kinds: ["calls"],
    });
    assert.match(text, /~tools\/report\.py#build_report/);
    assert.match(text, /matched by name only/);
  });

  test("an unknown id gets suggestions, not an error", async () => {
    const { text, isError } = await call("graph_node", { ids: ["src/auth/sesion.ts#SessionStore"] });
    assert.equal(isError, false);
    assert.match(text, /no such node\. Did you mean: .*src\/auth\/session\.ts#SessionStore/);
  });

  test("max_tokens caps the reply", async () => {
    const small = await call("graph_node", { ids: ["src/auth/session.ts"], include: ["source"], max_tokens: 200 });
    assert.match(small.text, /more lines not shown/);
    assert.ok(small.text.length < 200 * 3.6 + 400);
  });

  test("invalid arguments are reported as an error", async () => {
    const { isError } = await call("graph_search", {}).catch(() => ({ isError: true }));
    assert.equal(isError, true);
  });
});
