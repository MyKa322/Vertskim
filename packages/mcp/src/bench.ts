import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AnswerQuality, EdgeAccuracy, GraphNode, Project } from "@vertskim/core";
import { estimateTokens } from "./format.js";
import { findTool } from "./registry.js";

/** One kind of question, measured over a sample of nodes. */
export interface BenchRow {
  question: string;
  /** What the assistant is assumed to do without the graph. */
  without: string;
  /** The tool call measured. */
  withGraph: string;
  samples: number;
  /** Estimated tokens over all samples. */
  totalWithout: number;
  totalWith: number;
  medianWithout: number;
  medianWith: number;
  /** Samples where the graph's answer was the longer one. */
  larger: number;
}

export interface BenchResult {
  project: string;
  files: number;
  symbols: number;
  /** Source text read for the baselines, in bytes. */
  bytesRead: number;
  /** True when the baselines were worked out from part of the project only. */
  capped: boolean;
  rows: BenchRow[];
}

export interface BenchOptions {
  /** How many symbols, and how many files, to sample. Default 40. */
  samples?: number;
}

/** Text files larger than this are left out of the baselines, as they are left out of the index. */
const MAX_FILE_BYTES = 1_500_000;
/** Stop reading the project for baselines after this much text. */
const MAX_TOTAL_BYTES = 96_000_000;
/** A search tool shows about this many matching lines before cutting off. */
const GREP_LINE_LIMIT = 250;
/** Lines shown around each match when the search is asked for context, as with `grep -C`. */
const CONTEXT_LINES = 10;
/** The same kind of cut-off for a search with context. */
const CONTEXT_LINE_LIMIT = 600;
/** A directory listing an assistant would plausibly ask for. */
const LISTING_LIMIT = 400;

const TEXT_SUBKINDS = new Set(["source", "test", "doc", "config"]);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** `count` items spread evenly over a list, so the sample is the same on every run. */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.floor((i * items.length) / count)]!);
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compare what the graph's tools return with what an assistant would read
 * without them, for the questions the tools exist to answer. Everything is
 * measured on the project as it is on disk; nothing is written.
 *
 * The comparison is of size only. It says nothing about which answer is more
 * complete: a text search finds uses the graph cannot see (reflection, strings),
 * and the graph finds relationships a text search cannot tell apart.
 */
export async function runBenchmark(project: Project, options: BenchOptions = {}): Promise<BenchResult> {
  const samples = Math.max(options.samples ?? 40, 1);
  const store = project.store;
  const run = async (tool: string, args: Record<string, unknown>): Promise<number> =>
    estimateTokens(await findTool(tool)!.run(project, args));

  // ---- the project's text, read once
  const texts = new Map<string, string>();
  let bytesRead = 0;
  let capped = false;
  for (const file of store.allFiles().values()) {
    if (!TEXT_SUBKINDS.has(file.subkind) || file.size > MAX_FILE_BYTES) continue;
    if (bytesRead + file.size > MAX_TOTAL_BYTES) {
      capped = true;
      continue;
    }
    try {
      const text = readFileSync(join(project.root, file.path), "utf8");
      if (text.includes("\u0000")) continue;
      texts.set(file.path, text);
      bytesRead += file.size;
    } catch {
      // gone since it was indexed
    }
  }
  const fileTokens = (path: string): number => estimateTokens(texts.get(path) ?? "");

  /**
   * What a whole-word search for `name` would print: the matching lines alone
   * (`grep -rnw`), and the same with lines of context around each match
   * (`grep -rnw -C 10`), there leaving out the file `skip`.
   */
  const grep = (name: string, skip: string): { matches: number; withContext: number } => {
    const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
    const plain: string[] = [];
    const context: string[] = [];
    for (const [path, text] of texts) {
      if (!text.includes(name)) continue;
      const fileLines = text.split("\n");
      let shownUpTo = -1;
      for (let i = 0; i < fileLines.length; i++) {
        if (!pattern.test(fileLines[i]!)) continue;
        if (plain.length < GREP_LINE_LIMIT) plain.push(`${path}:${i + 1}:${fileLines[i]!.trimEnd()}`);
        if (path === skip) continue;
        const from = Math.max(i - CONTEXT_LINES, shownUpTo + 1);
        const to = Math.min(i + CONTEXT_LINES, fileLines.length - 1);
        for (let j = from; j <= to && context.length < CONTEXT_LINE_LIMIT; j++) {
          context.push(`${path}-${j + 1}-${fileLines[j]!.trimEnd()}`);
        }
        shownUpTo = Math.max(shownUpTo, to);
      }
    }
    return { matches: estimateTokens(plain.join("\n")), withContext: estimateTokens(context.join("\n")) };
  };

  // ---- samples: symbols something depends on, and files with something in them
  const symbolRows = store.db
    .prepare(
      `SELECT n.id FROM nodes n
       WHERE n.kind IN ('function', 'method', 'class', 'interface')
         AND length(n.name) >= 4
         AND EXISTS (SELECT 1 FROM edges e WHERE e.dst = n.id AND e.kind IN ('calls', 'references', 'extends', 'implements'))
       ORDER BY n.id`,
    )
    .all();
  const symbols = spread(symbolRows, samples)
    .map((row) => store.getNode(row.id as string))
    .filter((n): n is GraphNode => n !== null && texts.has(n.path));
  const fileRows = store.db
    .prepare(
      `SELECT f.path FROM files f
       WHERE f.subkind IN ('source', 'test')
         AND (SELECT COUNT(*) FROM nodes n WHERE n.path = f.path AND n.kind NOT IN ('file', 'directory')) >= 3
       ORDER BY f.path`,
    )
    .all();
  const files = spread(fileRows, samples)
    .map((row) => row.path as string)
    .filter((path) => texts.has(path));

  const rows: BenchRow[] = [];
  const row = (question: string, without: string, withGraph: string, pairs: [number, number][]) => {
    rows.push({
      question,
      without,
      withGraph,
      samples: pairs.length,
      totalWithout: pairs.reduce((sum, [a]) => sum + a, 0),
      totalWith: pairs.reduce((sum, [, b]) => sum + b, 0),
      medianWithout: median(pairs.map(([a]) => a)),
      medianWith: median(pairs.map(([, b]) => b)),
      larger: pairs.filter(([a, b]) => b > a).length,
    });
  };

  // 1. Getting oriented
  const listing = [...store.allFiles().keys()].sort().slice(0, LISTING_LIMIT).join("\n");
  const readme = [...texts.keys()].find((p) => /^readme(\.\w+)?$/i.test(p));
  row("Get oriented in the project", `list the files (first ${LISTING_LIMIT}) and read the README`, "graph_overview", [
    [estimateTokens(listing) + (readme ? fileTokens(readme) : 0), await run("graph_overview", {})],
  ]);

  // 2. What is in a file
  const outlines: [number, number][] = [];
  for (const path of files) outlines.push([fileTokens(path), await run("graph_node", { ids: [path] })]);
  row("See what a file contains", "read the file", "graph_node (outline)", outlines);

  // 3. Read one symbol
  const reads: [number, number][] = [];
  for (const node of symbols) {
    reads.push([fileTokens(node.path), await run("graph_node", { ids: [node.id], include: ["source"] })]);
  }
  row("Read one function or class", "read the file it is in", "graph_node (source)", reads);

  // 4-6 share one text search per symbol
  const users: [number, number][] = [];
  const contexts: [number, number][] = [];
  const impacts: [number, number][] = [];
  for (const node of symbols) {
    const everywhere = grep(node.name, "");
    const elsewhere = grep(node.name, node.path);
    users.push([everywhere.matches, await run("graph_neighbors", { id: node.id, direction: "in" })]);
    contexts.push([
      fileTokens(node.path) + elsewhere.withContext,
      await run("graph_context", { seeds: [node.id], detail: "source" }),
    ]);
    impacts.push([everywhere.withContext, await run("graph_impact", { targets: [node.id] })]);
  }
  row(
    "Find who uses a symbol",
    `search the project for its name (matching lines only, first ${GREP_LINE_LIMIT})`,
    "graph_neighbors (in)",
    users,
  );
  row(
    "Gather the code around a symbol",
    `read the file it is in, and search for its name elsewhere with ${CONTEXT_LINES} lines around each match`,
    "graph_context (source)",
    contexts,
  );
  row(
    "Check what a change would affect",
    `search for its name with ${CONTEXT_LINES} lines around each match, to see what the uses are`,
    "graph_impact",
    impacts,
  );

  const counts = store.db
    .prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind NOT IN ('file', 'directory', 'external', 'section')")
    .get();
  return {
    project: basename(project.root),
    files: project.status().files,
    symbols: Number(counts?.c ?? 0),
    bytesRead,
    capped,
    rows,
  };
}

const number = (value: number) => value.toLocaleString("en-US");

function saving(without: number, withGraph: number): string {
  if (without === 0) return "n/a";
  const ratio = 1 - withGraph / without;
  return ratio >= 0 ? `${Math.round(ratio * 100)}% less` : `${Math.round(-ratio * 100)}% more`;
}

/** The measurements as a table followed by what each line assumes. */
export function formatBenchmark(result: BenchResult): string {
  const lines: string[] = [];
  lines.push(
    `Token use on ${result.project}: ${number(result.files)} files, ${number(result.symbols)} symbols`,
    "Estimated at 3.6 characters per token, the same way for both columns. Medians per question.",
    "",
  );
  const header = ["question", "samples", "without graph", "with graph", "difference", "overall"];
  const table = result.rows.map((row) => [
    row.question,
    String(row.samples),
    number(row.medianWithout),
    number(row.medianWith),
    saving(row.medianWithout, row.medianWith),
    saving(row.totalWithout, row.totalWith),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i]!.length)));
  const render = (cells: string[]) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join("  ");
  lines.push(render(header), widths.map((w) => "-".repeat(w)).join("  "));
  for (const cells of table) lines.push(render(cells));

  lines.push("", "What each line compares:");
  for (const row of result.rows) {
    const worse = row.larger > 0 ? ` The graph's answer was the longer one in ${row.larger} of ${row.samples}.` : "";
    lines.push(`- ${row.question}: ${row.without}, against ${row.withGraph}.${worse}`);
  }
  lines.push(
    "",
    '"difference" compares the medians; "overall" compares the totals over all samples, which large files dominate.',
    "This measures size only. A text search also finds uses the graph cannot see (strings, reflection),",
    "and the graph tells apart relationships a text search cannot; neither column is a complete answer.",
  );
  if (result.capped) {
    lines.push(
      "The project is larger than the benchmark reads; the baselines cover part of it and are underestimates.",
    );
  }
  if (result.rows.some((row) => row.samples === 0)) {
    lines.push("Some questions had nothing to sample: the project has too few symbols that anything depends on.");
  }
  return lines.join("\n");
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`;
}

/** The comparison with a compiler index, as text. */
export function formatEdgeAccuracy(report: EdgeAccuracy): string {
  const { guesses, linked, compilerCalls } = report;
  const lines = [
    `Compared with ${report.index}${report.tool ? ` (${report.tool})` : ""}, over the ${report.files} files it describes:`,
    "",
    `Calls linked by name alone (~):  ${guesses.total}`,
    `  confirmed by the compiler       ${guesses.confirmed}  (${percent(guesses.confirmed, guesses.total)})`,
    `  contradicted                    ${guesses.contradicted}  (${percent(guesses.contradicted, guesses.total)})`,
    `  the compiler has no view        ${guesses.unknown}`,
    `Calls linked through imports or types:  ${linked.total}, ${percent(linked.confirmed, linked.total)} confirmed`,
    `Calls the compiler knows of:  ${compilerCalls.total}, ${compilerCalls.found} found from syntax (${percent(compilerCalls.found, compilerCalls.total)})`,
  ];
  const missed = Object.entries(report.missedBy).sort((a, b) => b[1] - a[1]);
  if (missed.length > 0) {
    lines.push("  missed, by how the call is written:");
    for (const [shape, count] of missed) lines.push(`    ${shape.padEnd(22)} ${count}`);
  }
  if (report.examples.contradicted.length > 0) {
    lines.push("", "Guesses the compiler contradicts, for example:");
    for (const example of report.examples.contradicted) lines.push(`  ${example}`);
  }
  if (report.examples.unconfirmed.length > 0) {
    lines.push("", "Calls linked through imports or types that the compiler does not have, for example:");
    for (const example of report.examples.unconfirmed) lines.push(`  ${example}`);
  }
  if (report.examples.missed.length > 0) {
    lines.push("", "Calls syntax missed, for example:");
    for (const example of report.examples.missed) lines.push(`  ${example}`);
  }
  return lines.join("\n");
}

/** How a question set fared, as text. */
export function formatAnswerQuality(quality: AnswerQuality): string {
  const total = quality.questions.length;
  const rank = (r: number | null) => (r === null ? "-" : String(r));
  const lines = [
    `${total} questions, search by meaning ${quality.meaning ? "on" : "off"}`,
    `graph_search:  right answer in the first five for ${quality.searchTop5} (${percent(quality.searchTop5, total)}), mean reciprocal rank ${quality.searchMrr.toFixed(2)}`,
    `graph_context: right answer among the starting points for ${quality.contextSeeds}, in the first ten for ${quality.contextTop10}`,
    "",
    "search  context  question",
  ];
  for (const q of quality.questions) {
    const context = q.contextSeed ? "start" : rank(q.contextRank);
    lines.push(`${rank(q.searchRank).padStart(6)}  ${context.padStart(7)}  ${q.ask}`);
  }
  if (quality.unknownIds.length > 0) {
    lines.push(
      "",
      `Expected ids that are not in the graph (update the question set): ${quality.unknownIds.join(", ")}`,
    );
  }
  return lines.join("\n");
}
