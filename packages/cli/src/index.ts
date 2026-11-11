#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ollamaEmbeddingModels, Project, type ScipSourceStatus } from "@vertskim/core";
import { findTool, formatBenchmark, runBenchmark, serveStdio, VERSION } from "@vertskim/mcp";
import { findRunningUi, openInBrowser, UiBridge } from "@vertskim/server";

const HELP = `vertskim ${VERSION} - a local knowledge graph of your project for AI assistants

Usage:
  vertskim mcp                       Serve the graph over MCP on stdio (what an MCP client runs)
  vertskim index                     Index the project and print a summary
  vertskim watch                     Index, then keep the graph current and report each update
  vertskim ui [id]                   Open the 3D view in your browser, optionally on one node
  vertskim status                    Show where the index lives and how big it is

  vertskim overview [dir]            Map the project or one directory
  vertskim search <query>            Find files, symbols and doc sections
  vertskim node <id>...              Show details for nodes
  vertskim neighbors <id>            Show what a node uses and what uses it
  vertskim impact <id>...            Show everything that depends on the given nodes
  vertskim path <from> <to>          Show how one node reaches another
  vertskim context <task>            Gather the code most relevant to a task

  vertskim note <id> <text>          Leave a note on a node (kept outside the project)
  vertskim notes [id]                List notes: on one node and what it contains, or all of them
  vertskim bench                     Measure how many tokens the graph saves on this project

  vertskim scip [file]               Use a SCIP index for compiler-accurate relationships; no file: list those in use
  vertskim embed                     Switch on search by meaning with a local embedding model, and make the vectors

Options:
  --root <dir>        Project to index (default: $VERTSKIM_ROOT, then the current directory)
  --data-dir <dir>    Where to keep the database (default: per-project folder in your user data directory)
  --kind <kind>       search: node kind filter; neighbors, path: edge kind filter (repeatable)
  --path <glob>       search: only under this directory, file or glob
  --limit <n>         search, neighbors: maximum results
  --source            node: include source lines
  --in, --out         neighbors: one direction only
  --depth <n>         neighbors, impact: hops to follow; overview: directory levels
  --no-tests          impact: leave test code out
  --hops <n>          path: longest chain to look for
  --seed <id>         context: node to start from (repeatable)
  --detail <level>    context: names, signatures (default) or source
  --rebuild           index: discard the existing index first
  --remove <n>        note: delete note number n
  --samples <n>       bench: how many symbols and files to sample (default 40)
  --json              bench: print the measurements as JSON
  --forget            scip: stop using the given index file
  --provider <name>   embed: ollama (default), openai (any server speaking that dialect) or transformers
  --model <name>      embed: the embedding model, as the provider names it
  --url <url>         embed: where the model server listens (default: Ollama or LM Studio on this machine)
  --allow-remote      embed: permit a model server on another machine; source text is sent to it
  --key-env <name>    embed: environment variable holding the server's key, if it wants one
  --off               embed: switch search by meaning off and delete the vectors
  --port <n>          ui: port to serve on (default 4517, or any free port if that is taken)
  --no-open           ui: print the link without opening a browser
  --max-tokens <n>    Size limit for the output
  -h, --help          Show this help
  -v, --version       Show the version

The project directory is only ever read. Nothing is written inside it.`;

function describeIndex(index: ScipSourceStatus): string {
  if (!index.present) return `${index.path}: missing`;
  if (index.documents === 0) return `${index.path}: could not be read as a SCIP index`;
  const skipped = index.outOfStep > 0 ? `, ${index.outOfStep} changed since it was built` : "";
  return (
    `${index.path}${index.tool ? ` (${index.tool})` : ""}: ` +
    `${index.filesInUse} of ${index.documents} files in use, ${index.facts} relationship${index.facts === 1 ? "" : "s"}${skipped}`
  );
}

function fail(message: string): never {
  process.stderr.write(`vertskim: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        root: { type: "string" },
        "data-dir": { type: "string" },
        kind: { type: "string", multiple: true },
        path: { type: "string" },
        limit: { type: "string" },
        source: { type: "boolean" },
        in: { type: "boolean" },
        out: { type: "boolean" },
        depth: { type: "string" },
        "no-tests": { type: "boolean" },
        hops: { type: "string" },
        seed: { type: "string", multiple: true },
        detail: { type: "string" },
        rebuild: { type: "boolean" },
        remove: { type: "string" },
        samples: { type: "string" },
        json: { type: "boolean" },
        forget: { type: "boolean" },
        provider: { type: "string" },
        model: { type: "string" },
        url: { type: "string" },
        "allow-remote": { type: "boolean" },
        "key-env": { type: "string" },
        off: { type: "boolean" },
        port: { type: "string" },
        "no-open": { type: "boolean" },
        "max-tokens": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    fail(`${(err as Error).message}\nRun \`vertskim --help\` for usage.`);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help || !command) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const root = resolve(values.root ?? process.env.VERTSKIM_ROOT ?? process.cwd());
  const dataDir = values["data-dir"];
  const number = (text: string | undefined, name: string): number | undefined => {
    if (text === undefined) return undefined;
    const n = Number(text);
    if (!Number.isInteger(n)) fail(`--${name} expects a whole number, got "${text}"`);
    return n;
  };

  if (command === "mcp") {
    await serveStdio({
      root,
      dataDir,
      // The 3D view is started on demand by graph_open_ui; until then nothing listens.
      attach: (project, log) => {
        const bridge = new UiBridge(project, { log });
        return {
          hooks: {
            onTrace: (tool, ids) => bridge.trail(tool, ids),
            openUi: (focus) => bridge.open(focus),
          },
          close: () => bridge.close(),
        };
      },
    });
    return;
  }

  const queries: Record<string, () => { tool: string; args: Record<string, unknown> }> = {
    overview: () => {
      if (rest.length > 1) fail("overview takes at most one directory, e.g. `vertskim overview src`");
      return { tool: "graph_overview", args: { path: rest[0], depth: number(values.depth, "depth") } };
    },
    search: () => {
      if (rest.length === 0) fail("search needs a query, e.g. `vertskim search SessionStore`");
      return {
        tool: "graph_search",
        args: { query: rest.join(" "), kinds: values.kind, path: values.path, limit: number(values.limit, "limit") },
      };
    },
    node: () => {
      if (rest.length === 0) fail("node needs at least one id, e.g. `vertskim node src/index.ts`");
      return {
        tool: "graph_node",
        args: { ids: rest, include: values.source ? ["outline", "neighbors", "source"] : undefined },
      };
    },
    neighbors: () => {
      if (rest.length !== 1) fail("neighbors needs exactly one id, e.g. `vertskim neighbors src/index.ts`");
      return {
        tool: "graph_neighbors",
        args: {
          id: rest[0],
          direction: values.in && !values.out ? "in" : values.out && !values.in ? "out" : undefined,
          edge_kinds: values.kind,
          depth: number(values.depth, "depth"),
          limit: number(values.limit, "limit"),
        },
      };
    },
    impact: () => {
      if (rest.length === 0) fail("impact needs at least one id, e.g. `vertskim impact src/auth/tokens.ts`");
      return {
        tool: "graph_impact",
        args: {
          targets: rest,
          depth: number(values.depth, "depth"),
          include_tests: values["no-tests"] ? false : undefined,
        },
      };
    },
    path: () => {
      if (rest.length !== 2) fail("path needs two ids, e.g. `vertskim path src/index.ts src/auth/tokens.ts`");
      return {
        tool: "graph_path",
        args: { from: rest[0], to: rest[1], edge_kinds: values.kind, max_hops: number(values.hops, "hops") },
      };
    },
    context: () => {
      if (rest.length === 0 && !values.seed?.length) {
        fail("context needs a task or a --seed, e.g. `vertskim context \"rotate refresh tokens\"`");
      }
      return {
        tool: "graph_context",
        args: { task: rest.length > 0 ? rest.join(" ") : undefined, seeds: values.seed, detail: values.detail },
      };
    },
    note: () => {
      const remove = number(values.remove, "remove");
      if (remove !== undefined && rest.length === 0) return { tool: "graph_annotate", args: { remove } };
      if (rest.length < 2) {
        fail("note needs an id and the text, e.g. `vertskim note src/index.ts \"entry point; keep it small\"`");
      }
      return { tool: "graph_annotate", args: { id: rest[0], note: rest.slice(1).join(" "), remove } };
    },
    notes: () => {
      if (rest.length > 1) fail("notes takes at most one id, e.g. `vertskim notes src/auth/`");
      return { tool: "graph_annotate", args: { id: rest[0] } };
    },
  };

  const builtin = ["index", "status", "watch", "ui", "bench", "scip", "embed"];
  if (!builtin.includes(command) && !queries[command]) {
    fail(`unknown command "${command}"\nRun \`vertskim --help\` for usage.`);
  }

  const log = (message: string) => process.stderr.write(`[vertskim] ${message}\n`);
  const project = Project.open({
    root,
    dataDir,
    log: command === "watch" ? () => {} : log,
    onSync:
      command === "watch"
        ? (result) => {
            const time = new Date().toLocaleTimeString();
            process.stdout.write(
              `${time}  +${result.added} ~${result.changed} -${result.removed}  ` +
                `${result.resolvedFiles} files re-linked in ${Math.round(result.durationMs)} ms\n`,
            );
          }
        : undefined,
  });

  if (command === "ui") {
    if (rest.length > 1) fail("ui takes at most one node id to open on, e.g. `vertskim ui src/index.ts`");
    const show = (link: string) => {
      process.stdout.write(`3D graph of ${project.root}\n  ${link}\n`);
      if (!values["no-open"]) openInBrowser(link);
    };
    // One view per project: if another process is already serving it, point there.
    const running = await findRunningUi(project.dataDir);
    if (running) {
      if (rest[0]) await running.focus(rest[0]).catch(() => undefined);
      show(running.link(rest[0]));
      await project.close();
      return;
    }
    const bridge = new UiBridge(project, { port: number(values.port, "port"), log });
    await project.watch();
    let link: string;
    try {
      link = await bridge.open(rest[0]);
    } catch (err) {
      await project.close();
      fail(`could not start the server: ${(err as Error).message}`);
    }
    show(link);
    process.stdout.write("Press Ctrl+C to stop.\n");
    project.sync({ full: true }).catch(() => undefined);
    const stop = () => {
      bridge
        .close()
        .catch(() => undefined)
        .then(() => project.close())
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return; // the server keeps the process alive
  }

  if (command === "watch") {
    const watching = await project.watch();
    if (!watching) {
      await project.close();
      fail("file watching is not available on this system");
    }
    process.stdout.write(`Watching ${project.root}. Press Ctrl+C to stop.\n`);
    await project.sync({ full: true });
    const status = project.status();
    process.stdout.write(`Indexed: ${status.files} files, ${status.nodes} nodes, ${status.edges} edges\n`);
    const stop = () => {
      project
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return; // the watcher keeps the process alive
  }

  try {
    if (command === "status") {
      const status = project.status();
      process.stdout.write(
        `project:  ${project.root}\ndata:     ${project.dataDir}\n` +
          `indexed:  ${status.files} files, ${status.nodes} nodes, ${status.edges} edges\n`,
      );
      for (const index of project.compilerIndexes()) process.stdout.write(`compiler: ${describeIndex(index)}\n`);
      const meaning = project.embeddingStatus();
      if (meaning.enabled) {
        process.stdout.write(
          `meaning:  ${meaning.provider} ${meaning.model}, ${meaning.embedded} of ${meaning.total} nodes embedded\n`,
        );
      }
      return;
    }
    if (command === "scip") {
      if (rest.length > 1) fail("scip takes at most one index file, e.g. `vertskim scip build/index.scip`");
      if (values.forget) {
        if (!rest[0]) fail("--forget needs the index file to stop using, e.g. `vertskim scip --forget build/index.scip`");
        const known = await project.forgetCompilerIndex(resolve(rest[0]));
        process.stdout.write(
          known
            ? `No longer using ${resolve(rest[0])}.\n`
            : `${resolve(rest[0])} was not in use. An index.scip at the project root is used for as long as it is there.\n`,
        );
        return;
      }
      if (rest[0]) {
        const added = await project.addCompilerIndex(resolve(rest[0]));
        process.stdout.write(`${added ? describeIndex(added) : "The file could not be read as a SCIP index."}\n`);
        return;
      }
      await project.sync();
      const indexes = project.compilerIndexes();
      if (indexes.length === 0) {
        process.stdout.write(
          "No compiler index in use; relationships come from syntax alone.\n" +
            "Run a SCIP indexer for your language (scip-typescript, scip-python, scip-java, rust-analyzer scip, ...)\n" +
            "and point at its output: vertskim scip <file>. An index.scip at the project root is found by itself.\n",
        );
      }
      for (const index of indexes) process.stdout.write(`${describeIndex(index)}\n`);
      return;
    }
    if (command === "embed") {
      if (values.off) {
        await project.disableEmbeddings();
        process.stdout.write("Search by meaning is off and its vectors are deleted.\n");
        return;
      }
      const before = project.embeddingStatus();
      const chosen = values.provider ?? values.model ?? values.url ?? values["key-env"] ?? values["allow-remote"];
      if (chosen !== undefined) {
        const provider = values.provider ?? before.provider ?? "ollama";
        const model = values.model ?? (provider === before.provider ? before.model : null);
        if (!model) fail("embed needs --model, e.g. `vertskim embed --model nomic-embed-text`");
        const url = values.url ?? (provider === before.provider ? (before.url ?? undefined) : undefined);
        try {
          await project.enableEmbeddings({
            provider,
            model,
            url,
            allowRemote: values["allow-remote"],
            apiKeyEnv: values["key-env"],
          });
        } catch (err) {
          const message = (err as Error).message;
          // Ollama names the model it lacks but not the way to get it.
          const hint = provider === "ollama" && /not found/.test(message) ? `\nGet it with \`ollama pull ${model}\`.` : "";
          fail(message + hint);
        }
      } else if (!before.enabled) {
        const models = await ollamaEmbeddingModels();
        if (!models || models.length === 0) {
          fail(
            (models
              ? "Ollama is running on this machine but has no embedding model. Get one with `ollama pull nomic-embed-text`, then run this again."
              : "No embedding model is set up, and no Ollama server answers on this machine.") +
              "\nSearch by meaning needs a local embedding model. Either:\n" +
              "  vertskim embed --model <name>                                  a model served by Ollama\n" +
              "  vertskim embed --provider openai --url <url> --model <name>    LM Studio, llama.cpp and the like\n" +
              "  vertskim embed --provider transformers --model <name>          in-process; needs @huggingface/transformers",
          );
        }
        await project.enableEmbeddings({ provider: "ollama", model: models[0] });
        process.stdout.write(`Using ${models[0]} from the Ollama server on this machine.\n`);
      }
      let last = -1;
      const made = await project.embed(({ done, total }) => {
        const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
        if (percent === last || (percent % 10 !== 0 && !process.stderr.isTTY)) return;
        last = percent;
        process.stderr.write(process.stderr.isTTY ? `\rembedding ${done} of ${total}` : `embedding ${done} of ${total}\n`);
      });
      if (process.stderr.isTTY && last >= 0) process.stderr.write("\n");
      const after = project.embeddingStatus();
      process.stdout.write(
        `Search by meaning is on: ${after.provider} ${after.model}\n` +
          `  ${made.embedded} vectors made, ${made.removed} dropped, ${made.total} in all` +
          (after.capped ? " (the project has more nodes than are embedded at most)" : "") +
          "\n",
      );
      return;
    }
    const result = values.rebuild && command === "index" ? await project.rebuild() : await project.sync();
    if (command === "index") {
      const status = project.status();
      process.stdout.write(
        `Indexed ${project.root}\n` +
          `  ${status.files} files, ${status.nodes} nodes, ${status.edges} edges\n` +
          `  ${result.added} added, ${result.changed} changed, ${result.removed} removed ` +
          `in ${Math.round(result.durationMs)} ms\n` +
          `  data: ${project.dataDir}\n`,
      );
      return;
    }
    if (command === "bench") {
      const measured = await runBenchmark(project, { samples: number(values.samples, "samples") });
      process.stdout.write(`${values.json ? JSON.stringify(measured, null, 2) : formatBenchmark(measured)}\n`);
      return;
    }
    const { tool, args } = queries[command]!();
    const maxTokens = number(values["max-tokens"], "max-tokens");
    if (maxTokens !== undefined && tool !== "graph_path") args.max_tokens = maxTokens;
    for (const key of Object.keys(args)) if (args[key] === undefined) delete args[key];
    process.stdout.write(`${await findTool(tool)!.run(project, args, { author: () => "command line" })}\n`);
  } finally {
    await project.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
