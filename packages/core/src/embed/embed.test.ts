import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Project } from "../project.js";
import { startFakeModelServer, type FakeModelServer } from "../testing/embedding-server.js";
import { copyFixture, removeTempDirs, snapshot, tempDir, write } from "../testing/helpers.js";
import { DatabaseSync } from "node:sqlite";
import { checkConfig, createEmbedder, isLoopback, ollamaEmbeddingModels, prefixesFor } from "./provider.js";
import { TEXT_VERSION } from "./text.js";

let server: FakeModelServer;
before(async () => {
  server = await startFakeModelServer();
});
after(async () => {
  await server.close();
  removeTempDirs();
});

const REFRESH = "src/auth/session.ts#SessionStore.refresh";
const ROTATE = "src/auth/tokens.ts#rotate";
/** Says what the session code does without using any of its names. */
const QUESTION = "renew expired credentials";

async function wait(until: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!until()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("embedding providers", () => {
  test("only a model server on this machine is accepted unless a remote one is allowed", () => {
    for (const url of [
      "http://localhost:11434",
      "http://127.0.0.1:1234/v1",
      "http://[::1]:8080",
      "http://lm.localhost:1234",
    ]) {
      assert.equal(isLoopback(url), true, url);
    }
    for (const url of [
      "http://192.168.1.20:11434",
      "https://api.example.com/v1",
      "http://127.0.0.1.example.com",
      "nonsense",
    ]) {
      assert.equal(isLoopback(url), false, url);
    }
    assert.throws(
      () => checkConfig({ provider: "openai", model: "m", url: "https://api.example.com/v1" }),
      /not on this machine/,
    );
    const remote = checkConfig({
      provider: "openai",
      model: "m",
      url: "https://api.example.com/v1/",
      allowRemote: true,
    });
    assert.equal(remote.url, "https://api.example.com/v1");
    assert.equal(checkConfig({ provider: "ollama", model: " nomic-embed-text " }).url, "http://127.0.0.1:11434");
    assert.equal(checkConfig({ provider: "ollama", model: "nomic-embed-text" }).model, "nomic-embed-text");
    assert.equal(
      checkConfig({ provider: "transformers", model: "Xenova/all-MiniLM-L6-v2", url: "http://x" }).url,
      undefined,
    );
    assert.throws(() => checkConfig({ provider: "cloud", model: "m" }), /unknown embedding provider/);
    assert.throws(() => checkConfig({ provider: "ollama" }), /model has to be named/);
    assert.throws(() => checkConfig({ provider: "ollama", model: "m", url: "ftp://127.0.0.1" }), /not an http/);
  });

  test("knows the instructions common models expect", () => {
    const prefixes = (model: string) => prefixesFor({ provider: "ollama", model });
    assert.deepEqual(prefixes("nomic-embed-text:latest"), { query: "search_query: ", document: "search_document: " });
    assert.deepEqual(prefixes("intfloat/multilingual-e5-small"), { query: "query: ", document: "passage: " });
    assert.match(prefixes("bge-small-en-v1.5").query, /^Represent this sentence/);
    assert.deepEqual(prefixes("all-minilm"), { query: "", document: "" });
    assert.deepEqual(
      prefixesFor({ provider: "ollama", model: "nomic-embed-text", queryPrefix: "q: ", documentPrefix: "" }),
      {
        query: "q: ",
        document: "",
      },
    );
  });

  test("speaks to an Ollama server", async () => {
    const embedder = createEmbedder(checkConfig({ provider: "ollama", model: "nomic-embed-text", url: server.url }));
    assert.equal(embedder.id, "ollama:nomic-embed-text");
    const seen = server.texts.length;
    const [a, b] = await embedder.embed(["renew a session", "format a report"], "document");
    assert.deepEqual(server.texts.slice(seen), [
      "search_document: renew a session",
      "search_document: format a report",
    ]);
    assert.equal(a!.length, 32);
    // Whatever length the server's vectors have, stored ones are unit length.
    for (const v of [a!, b!]) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-5);
    await embedder.embed(["anything"], "query");
    assert.equal(server.texts.at(-1), "search_query: anything");
    // Ollama is asked to keep the model loaded between searches.
    assert.equal(server.lastBody?.keep_alive, "30m");
    assert.deepEqual(await embedder.embed([], "query"), []);

    const missing = createEmbedder(checkConfig({ provider: "ollama", model: "no-such-model", url: server.url }));
    await assert.rejects(missing.embed(["x"], "query"), /answered 404: model "no-such-model" not found/);
  });

  test("speaks to an OpenAI-compatible server", async () => {
    process.env.VERTSKIM_TEST_KEY = "secret-for-the-test";
    try {
      const config = checkConfig({
        provider: "openai",
        model: "all-minilm",
        url: server.openaiUrl,
        apiKeyEnv: "VERTSKIM_TEST_KEY",
      });
      const embedder = createEmbedder(config);
      const [auth, report] = await embedder.embed(["login credentials", "report summary"], "document");
      assert.equal(server.lastAuthorization, "Bearer secret-for-the-test");
      assert.equal(auth!.length, 24);
      // The reply lists vectors out of order; each has to end up with its own text.
      assert.ok(auth![0]! > 0.9, "the first text is about signing in");
      assert.ok(report![3]! > 0.9, "the second is about reports");
      assert.equal(JSON.stringify(config).includes("secret-for-the-test"), false, "the key itself is never kept");
    } finally {
      delete process.env.VERTSKIM_TEST_KEY;
    }
  });

  test("reports a server that is not there, and finds the embedding models of one that is", async () => {
    const dead = createEmbedder(
      checkConfig({ provider: "ollama", model: "nomic-embed-text", url: "http://127.0.0.1:9" }),
    );
    await assert.rejects(dead.embed(["x"], "query", { timeoutMs: 3000 }), /could not reach|did not answer/);
    assert.equal(await ollamaEmbeddingModels("http://127.0.0.1:9", 500), null);
    assert.deepEqual(await ollamaEmbeddingModels(server.url), ["nomic-embed-text:latest", "all-minilm:latest"]);
  });
});

describe("search by meaning", () => {
  let root: string;
  let dataDir: string;
  let project: Project;
  let untouched: string[];
  const messages: string[] = [];
  const ollama = () => ({ provider: "ollama", model: "nomic-embed-text", url: server.url });

  before(async () => {
    root = copyFixture();
    untouched = snapshot(root);
    dataDir = tempDir("data");
    project = Project.open({ root, dataDir, log: (m) => messages.push(m) });
    await project.sync();
  });
  after(() => project.close());

  test("is off until a model is chosen, and then nothing is stored or sent", async () => {
    const requests = server.requests;
    assert.equal(project.embeddingStatus().enabled, false);
    assert.deepEqual(await project.embed(), { embedded: 0, removed: 0, total: 0 });
    const byName = project.search({ query: QUESTION });
    assert.deepEqual(await project.searchWithMeaning({ query: QUESTION }), byName);
    assert.equal(byName.hits.length, 0, "no name in the project matches the question");
    assert.equal(existsSync(join(dataDir, "vectors.db")), false);
    assert.equal(server.requests, requests);
  });

  test("refuses a model that does not answer, before anything is switched on", async () => {
    await assert.rejects(project.enableEmbeddings({ ...ollama(), model: "no-such-model" }), /not found/);
    await assert.rejects(
      project.enableEmbeddings({ provider: "openai", model: "m", url: "https://api.example.com/v1" }),
      /not on this machine/,
    );
    assert.equal(project.embeddingStatus().enabled, false);
    assert.equal(existsSync(join(dataDir, "embeddings.json")), false);
  });

  test("gives every function, type, section and file a vector, once", async () => {
    const config = await project.enableEmbeddings(ollama());
    assert.deepEqual(config, { provider: "ollama", model: "nomic-embed-text", url: server.url });
    const seen = server.texts.length;
    const made = await project.embed();
    const status = project.embeddingStatus();
    assert.ok(made.embedded > 40, `${made.embedded} vectors`);
    assert.equal(made.total, made.embedded);
    assert.equal(status.embedded, status.total);
    assert.equal(status.enabled, true);
    assert.equal(status.error, null);

    const sent = server.texts.slice(seen);
    assert.equal(sent.length, made.embedded);
    assert.ok(sent.every((text) => text.startsWith("search_document: ")));
    const refresh = sent.find((text) => text.includes("method SessionStore.refresh"))!;
    assert.match(refresh, /\(session store refresh\)/);
    assert.match(refresh, /in src\/auth\/session\.ts/);
    assert.match(refresh, /Rotates the refresh token and extends the session TTL\./);
    assert.match(refresh, /await this\.loadSession\(token\)/);
    assert.ok(
      sent.some((text) => text.includes("file src/auth/session.ts") && text.includes("contains: Session, BaseStore")),
    );
    assert.ok(sent.some((text) => text.includes("section of docs/architecture.md")));
    // Not worth a vector: a file with nothing parsed in it, and plain variables.
    assert.equal(
      sent.some((text) => text.includes("file assets/logo.svg")),
      false,
    );
    assert.equal(
      sent.some((text) => text.includes("variable TOKEN_TTL_SECONDS")),
      false,
    );

    // A second pass has nothing to do.
    const requests = server.requests;
    assert.deepEqual(await project.embed(), { embedded: 0, removed: 0, total: made.total });
    assert.equal(server.requests, requests);

    // Everything lives in the data folder; the project is as it was.
    assert.equal(existsSync(join(dataDir, "vectors.db")), true);
    assert.deepEqual(snapshot(root), untouched);
  });

  test("finds code from a description that shares no word with it", async () => {
    assert.equal(project.search({ query: QUESTION }).hits.length, 0);
    const result = await project.searchWithMeaning({ query: QUESTION, limit: 5 });
    const ids = result.hits.map((hit) => hit.node.id);
    assert.ok(ids.includes(REFRESH), ids.join(", "));
    assert.ok(ids.includes(ROTATE), ids.join(", "));
    assert.ok(result.hits.every((hit) => hit.byMeaning === true));
    assert.equal(result.partial, false);
    assert.equal(server.texts.at(-1), `search_query: ${QUESTION}`);

    // Filters apply to what the model finds as well.
    const functions = await project.searchWithMeaning({ query: QUESTION, kinds: ["function"], limit: 5 });
    assert.ok(functions.hits.length > 0);
    assert.ok(functions.hits.every((hit) => hit.node.kind === "function"));
    const elsewhere = await project.searchWithMeaning({ query: QUESTION, path: "tools", limit: 5 });
    assert.ok(elsewhere.hits.every((hit) => hit.node.path.startsWith("tools/")));
  });

  test("leaves a plain name to the name search, and puts agreement first", async () => {
    const requests = server.requests;
    const named = await project.searchWithMeaning({ query: "SessionStore" });
    assert.deepEqual(named, project.search({ query: "SessionStore" }));
    assert.equal(server.requests, requests, "one word is a name: the model is not asked");

    const both = await project.searchWithMeaning({ query: "rotate token", limit: 6 });
    assert.equal(both.hits[0]?.node.id, ROTATE);
    assert.equal(both.hits[0]?.byMeaning, undefined);
    // The same question again costs no second request.
    const again = server.requests;
    await project.searchWithMeaning({ query: "rotate token", limit: 6 });
    assert.equal(server.requests, again);
  });

  test("starts a task from what it means when no name in it is known", async () => {
    assert.equal(project.context({ task: QUESTION }).items.length, 0);
    const result = await project.contextWithMeaning({ task: QUESTION });
    const seeds = result.seeds.map((node) => node.id);
    assert.ok(seeds.includes(REFRESH), seeds.join(", "));
    assert.ok(result.items.some((item) => item.node.id === "src/auth/session.ts#BaseStore.loadSession"));
    // Explicit seeds still count for more than anything inferred.
    const seeded = await project.contextWithMeaning({ task: QUESTION, seeds: ["tools/report.py"] });
    assert.equal(seeded.seeds[0]?.id, "tools/report.py");
  });

  test("re-embeds only what changed, and forgets what is gone", async () => {
    const before_ = project.embeddingStatus().embedded;
    const path = "src/auth/tokens.ts";
    const source = readFileSync(join(root, path), "utf8");
    write(root, path, source.replace("Issue a fresh opaque token.", "Mint a brand new bearer credential."), 1);
    let seen = server.texts.length;
    let made = await project.embed();
    assert.equal(made.embedded, 1);
    assert.match(server.texts.at(-1)!, /Mint a brand new bearer credential\.[\s\S]*function issueToken/);
    assert.equal(server.texts.length, seen + 1);

    rmSync(join(root, "tools/formatting.py"));
    seen = server.texts.length;
    made = await project.embed();
    assert.ok(made.removed >= 2, `${made.removed} dropped`);
    assert.equal(project.embeddingStatus().embedded, before_ - made.removed + made.embedded);
    const found = await project.searchWithMeaning({ query: "format a report summary", limit: 10 });
    assert.equal(
      found.hits.some((hit) => hit.node.path === "tools/formatting.py"),
      false,
    );
  });

  test("works every text out again when the recipe for it changes, and re-embeds only those that differ", async () => {
    // Vectors made by an older version of Vertskim, whose texts were put together differently.
    const db = new DatabaseSync(join(dataDir, "vectors.db"));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('text_version', '1')").run();
    db.close();
    const requests = server.requests;
    const made = await project.embed();
    assert.equal(made.embedded, 0, "the texts came out the same, so nothing needed a new vector");
    assert.equal(server.requests, requests);
    const check = new DatabaseSync(join(dataDir, "vectors.db"));
    assert.equal(check.prepare("SELECT value FROM meta WHERE key = 'text_version'").get()?.value, String(TEXT_VERSION));
    check.close();
  });

  test("a one-off search brings the vectors of changed code up to date first", async () => {
    const path = "src/auth/tokens.ts";
    const source = readFileSync(join(root, path), "utf8");
    write(root, path, source.replace("Replace a token with a new one", "Swap a token for a fresh one"), 5);
    await project.sync();
    const seen = server.texts.length;
    await project.searchWithMeaning({ query: "swap a token for a fresh one" });
    assert.ok(server.texts.slice(seen).some((text) => text.includes("Swap a token for a fresh one")));
  });

  test("keeps its vectors when the graph is rebuilt", async () => {
    const requests = server.requests;
    await project.rebuild();
    const made = await project.embed();
    assert.equal(made.embedded, 0);
    assert.equal(made.removed, 0);
    assert.equal(server.requests, requests);
  });

  test("falls back to names while the model is not answering", async () => {
    const before = server.texts.length;
    const pending = await project.embed();
    assert.equal(pending.embedded, 0, `pending: ${JSON.stringify(server.texts.slice(before))}`);
    server.failWith = 503;
    messages.length = 0;
    try {
      const started = Date.now();
      const result = await project.searchWithMeaning({ query: "expired credentials renewal" });
      assert.deepEqual(result, project.search({ query: "expired credentials renewal" }));
      assert.ok(messages.some((m) => m.includes("search by meaning is unavailable")));
      assert.match(project.embeddingStatus().error ?? "", /503/);
      // It is then left alone for a while instead of being asked on every search.
      const requests = server.requests;
      const sent = server.texts.length;
      await project.searchWithMeaning({ query: "another question about credentials" });
      assert.equal(
        server.requests,
        requests,
        `sent: ${JSON.stringify(server.texts.slice(sent))} last: ${JSON.stringify(server.lastBody)}`,
      );
      assert.ok(Date.now() - started < 3000);
    } finally {
      server.failWith = 0;
    }
  });

  test("starts over when the model changes, and cleans up when switched off", async () => {
    await project.enableEmbeddings({ ...ollama(), model: "all-minilm" });
    const total = project.embeddingStatus().total;
    assert.equal(project.embeddingStatus().embedded, 0, "the old model's vectors do not count for the new one");
    assert.deepEqual(await project.searchWithMeaning({ query: QUESTION }), project.search({ query: QUESTION }));
    const made = await project.embed();
    assert.equal(made.embedded, total);
    assert.equal(made.total, total);
    assert.ok((await project.searchWithMeaning({ query: QUESTION })).hits.some((hit) => hit.node.id === REFRESH));

    await project.disableEmbeddings();
    assert.equal(project.embeddingStatus().enabled, false);
    assert.equal(existsSync(join(dataDir, "embeddings.json")), false);
    assert.deepEqual(await project.searchWithMeaning({ query: QUESTION }), project.search({ query: QUESTION }));
    assert.deepEqual(await project.embed(), { embedded: 0, removed: 0, total: 0 });
  });
});

describe("embedding in the background", () => {
  test("a watched project keeps its vectors current by itself", async () => {
    const root = copyFixture();
    const project = Project.open({ root, dataDir: tempDir("data") });
    try {
      await project.sync();
      await project.enableEmbeddings({ provider: "ollama", model: "nomic-embed-text", url: server.url });
      assert.equal(project.embeddingStatus().embedded, 0, "choosing a model does not by itself make vectors");
      await project.watch();
      await project.sync({ full: true });
      await wait(() => {
        const status = project.embeddingStatus();
        return status.embedded > 0 && status.embedded === status.total && !status.running;
      });

      const before_ = project.embeddingStatus().embedded;
      write(root, "src/extra.ts", "/** Renew every expired login. */\nexport function sweep(): void {}\n", 1);
      await project.sync({ paths: ["src/extra.ts"] });
      await wait(() => project.embeddingStatus().embedded === before_ + 2 && !project.embeddingStatus().running);
      assert.ok(
        server.texts.some((text) => text.includes("function sweep") && text.includes("Renew every expired login.")),
      );
    } finally {
      await project.close();
    }
  });

  test("closing a project stops a pass in flight without losing what was stored", async () => {
    const root = copyFixture();
    const dataDir = tempDir("data");
    const project = Project.open({ root, dataDir });
    await project.sync();
    await project.enableEmbeddings({ provider: "ollama", model: "nomic-embed-text", url: server.url });
    const pass = project.embed();
    await project.close();
    await pass.catch(() => undefined);

    const reopened = Project.open({ root, dataDir });
    try {
      const made = await reopened.embed();
      const status = reopened.embeddingStatus();
      assert.equal(status.embedded, status.total);
      assert.equal(made.total, status.total);
    } finally {
      await reopened.close();
    }
  });
});
