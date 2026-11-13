import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
    for (const dir of [root, elsewhere, dataDir])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("scip: a compiler index replaces a guess with a fact until it is forgotten", async () => {
    const callers = ["neighbors", "tools/models.py#Record.label", "--in", "--kind", "calls"];
    assert.match(await vertskim(["scip"]), /No compiler index in use/);
    assert.match(await vertskim(callers), /~tools\/report\.py#build_report/);

    const { FakeIndexBuilder } = await coreHelper<ScipHelpers>("scip");
    const label = "scip-python python sample 1.0 `tools.models`/Record#label().";
    const index = new FakeIndexBuilder(root);
    index
      .doc("tools/models.py")
      .def("class Record:", "Record", "scip-python python sample 1.0 `tools.models`/Record#")
      .def("def label(self)", "label", label);
    index
      .doc("tools/report.py")
      .def("def build_report(", "build_report", "scip-python python sample 1.0 `tools.report`/build_report().")
      .ref("record.label()", "label", label);
    const file = index.write(1, join(elsewhere, "sample.scip"));

    assert.match(
      await vertskim(["scip", file]),
      /sample\.scip \(scip-typescript 0\.4\.0\): 2 of 2 files in use, 1 relationship\n/,
    );
    const verified = await vertskim(callers);
    assert.match(verified, /\n\s+tools\/report\.py#build_report/);
    assert.doesNotMatch(verified, /~tools\/report\.py#build_report/);
    assert.match(
      await vertskim(["status"]),
      /compiler: .*sample\.scip \(scip-typescript 0\.4\.0\): 2 of 2 files in use/,
    );
    assert.match(await vertskim(["scip"]), /sample\.scip/);

    assert.match(await vertskim(["scip", "--forget", file]), /No longer using/);
    assert.match(await vertskim(callers), /~tools\/report\.py#build_report/);
    assert.match(await vertskim(["scip", "--forget", file]), /was not in use/);
    assert.match(await fails(["scip", join(elsewhere, "missing.scip")]), /ENOENT|no such file/);
  });

  test("common mistakes get a plain message, before anything is indexed", async () => {
    const plain = (args: string[]) =>
      run(process.execPath, [CLI, ...args]).then(
        () => "",
        (err: { stderr: string }) => err.stderr,
      );
    assert.match(
      await plain(["--root", join(root, "no-such-folder"), "status"]),
      /--root .*no-such-folder does not exist/,
    );
    assert.match(
      await plain(["--root", join(root, "README.md"), "status"]),
      /--root .*README\.md is a file; give a folder/,
    );
    assert.match(
      await plain(["--root", root, "--data-dir", join(root, "README.md"), "status"]),
      /--data-dir .*README\.md is a file/,
    );
    assert.match(
      await plain(["--root", root, "--data-dir", dataDir, "ui", "--port", "99999", "--no-open"]),
      /--port expects a number from 0 to 65535/,
    );
    assert.match(
      await plain(["--root", root, "--data-dir", dataDir, "scip", join(root, "missing.scip")]),
      /missing\.scip: no such file/,
    );
    // Checked before indexing: a fresh data folder stays empty.
    const fresh = mkdtempSync(join(tmpdir(), "vertskim-extras-fresh-"));
    try {
      assert.match(await plain(["--root", root, "--data-dir", fresh, "search"]), /search needs a query/);
      assert.match(
        await plain(["--root", root, "--data-dir", fresh, "--depth", "abc", "overview"]),
        /--depth expects a whole number/,
      );
      assert.deepEqual(readdirSync(fresh), []);
    } finally {
      rmSync(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("embed: explains what is needed when no local model answers", async () => {
    const message = await fails(["embed"], { OLLAMA_HOST: "127.0.0.1:9" });
    assert.match(message, /no Ollama server answers on this machine/);
    assert.match(message, /vertskim embed --model <name>/);
    assert.match(
      await fails(["embed", "--provider", "openai", "--url", "https://api.example.com/v1", "--model", "x"]),
      /not on this machine/,
    );
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
    assert.match(
      await vertskim(["embed", "--model", "all-minilm"]),
      /Search by meaning is on: ollama all-minilm\n\s+5\d vectors made/,
    );

    assert.match(await vertskim(["embed", "--off"]), /Search by meaning is off/);
    assert.match(await vertskim(question), /No matches/);
    assert.doesNotMatch(await vertskim(["status"]), /meaning:/);
  });
});
