import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/sample", import.meta.url));
const CLI = fileURLToPath(new URL("./index.js", import.meta.url));
const run = promisify(execFile);

/**
 * Test helpers of the core package. They are not part of what it publishes, so
 * they are loaded from its build output rather than through the package.
 */
function coreHelper<T>(name: string): Promise<T> {
  return import(new URL(`../../core/dist/testing/${name}.js`, import.meta.url).href) as Promise<T>;
}

interface DocBuilder {
  def(snippet: string, word: string, symbol: string): DocBuilder;
  ref(snippet: string, word: string, symbol: string): DocBuilder;
}
interface ScipHelpers {
  FakeIndexBuilder: new (root: string) => { doc(path: string): DocBuilder; write(tick: number, to?: string): string };
}
interface ModelServer {
  url: string;
  close(): Promise<void>;
}
interface ServerHelpers {
  startFakeModelServer(): Promise<ModelServer>;
}

describe("optional extras from the command line", () => {
  let root: string;
  let dataDir: string;
  let elsewhere: string;
  let server: ModelServer;

  const vertskim = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
    const { stdout } = await run(process.execPath, [CLI, "--root", root, "--data-dir", dataDir, ...args], {
      env: { ...process.env, ...env },
    });
    return stdout;
  };
  const fails = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
    try {
      await vertskim(args, env);
    } catch (err) {
      return (err as { stderr: string }).stderr;
    }
    throw new Error(`vertskim ${args.join(" ")} was expected to fail`);
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "vertskim-extras-project-"));
    dataDir = mkdtempSync(join(tmpdir(), "vertskim-extras-data-"));
    elsewhere = mkdtempSync(join(tmpdir(), "vertskim-extras-scip-"));
    cpSync(FIXTURE, root, { recursive: true });
    server = await (await coreHelper<ServerHelpers>("embedding-server")).startFakeModelServer();
  });
  after(async () => {
    await server.close();
    for (const dir of [root, elsewhere, dataDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("scip: a compiler index replaces a guess with a fact until it is forgotten", async () => {
    const callers = ["neighbors", "src/auth/session.ts#SessionStore.refresh", "--in", "--kind", "calls"];
    assert.match(await vertskim(["scip"]), /No compiler index in use/);
    assert.match(await vertskim(callers), /~src\/api\/middleware\.ts#requireAuth/);

    const { FakeIndexBuilder } = await coreHelper<ScipHelpers>("scip");
    const pkg = "scip-typescript npm sample 1.0.0 src/";
    const index = new FakeIndexBuilder(root);
    index
      .doc("src/auth/session.ts")
      .def("export class SessionStore extends BaseStore {", "SessionStore", `${pkg}auth/\`session.ts\`/SessionStore#`)
      .def("async refresh(token: string)", "refresh", `${pkg}auth/\`session.ts\`/SessionStore#refresh().`);
    index
      .doc("src/api/middleware.ts")
      .def("export function requireAuth(", "requireAuth", `${pkg}api/\`middleware.ts\`/requireAuth().`)
      .ref("await store.refresh(token)", "refresh", `${pkg}auth/\`session.ts\`/SessionStore#refresh().`);
    const file = index.write(1, join(elsewhere, "sample.scip"));

    assert.match(await vertskim(["scip", file]), /sample\.scip \(scip-typescript 0\.4\.0\): 2 of 2 files in use, 1 relationship\n/);
    const verified = await vertskim(callers);
    assert.match(verified, /\n\s+src\/api\/middleware\.ts#requireAuth/);
    assert.doesNotMatch(verified, /~src\/api\/middleware\.ts#requireAuth/);
    assert.match(await vertskim(["status"]), /compiler: .*sample\.scip \(scip-typescript 0\.4\.0\): 2 of 2 files in use/);
    assert.match(await vertskim(["scip"]), /sample\.scip/);

    assert.match(await vertskim(["scip", "--forget", file]), /No longer using/);
    assert.match(await vertskim(callers), /~src\/api\/middleware\.ts#requireAuth/);
    assert.match(await vertskim(["scip", "--forget", file]), /was not in use/);
    assert.match(await fails(["scip", join(elsewhere, "missing.scip")]), /ENOENT|no such file/);
  });

  test("embed: explains what is needed when no local model answers", async () => {
    const message = await fails(["embed"], { OLLAMA_HOST: "127.0.0.1:9" });
    assert.match(message, /no Ollama server answers on this machine/);
    assert.match(message, /vertskim embed --model <name>/);
    assert.match(await fails(["embed", "--provider", "openai", "--url", "https://api.example.com/v1", "--model", "x"]), /not on this machine/);
    assert.match(await fails(["embed", "--provider", "ollama"]), /embed needs --model/);
    assert.doesNotMatch(await vertskim(["status"]), /meaning:/);
  });

  test("embed: finds a local model, after which a description finds code by what it does", async () => {
    const question = ["search", "renew", "expired", "credentials"];
    assert.match(await vertskim(question), /No matches/);

    const host = { OLLAMA_HOST: server.url.replace("http://", "") };
    const made = await vertskim(["embed"], host);
    assert.match(made, /Using nomic-embed-text:latest from the Ollama server on this machine\./);
    assert.match(made, /Search by meaning is on: ollama nomic-embed-text:latest/);
    assert.match(made, /5\d vectors made, 0 dropped, 5\d in all/);

    // From here on the address is remembered; nothing needs to be in the environment.
    const found = await vertskim(question);
    assert.match(found, /Nothing is named like "renew expired credentials"; \d+ matches by meaning \(≈\):/);
    assert.match(found, /≈ src\/auth\/tokens\.ts#rotate {2}function/);
    assert.match(found, /≈ src\/auth\/session\.ts#SessionStore\.refresh {2}method/);
    assert.match(await vertskim(["context", "renew expired credentials"]), /starting points: .*SessionStore\.refresh/);
    assert.match(await vertskim(["status"]), /meaning: {2}ollama nomic-embed-text:latest, (\d+) of \1 nodes embedded/);
    assert.match(await vertskim(["embed"]), /0 vectors made, 0 dropped/);

    // Another model on the same server: provider and address carry over.
    assert.match(await vertskim(["embed", "--model", "all-minilm"]), /Search by meaning is on: ollama all-minilm\n\s+5\d vectors made/);

    assert.match(await vertskim(["embed", "--off"]), /Search by meaning is off/);
    assert.match(await vertskim(question), /No matches/);
    assert.doesNotMatch(await vertskim(["status"]), /meaning:/);
  });
});
