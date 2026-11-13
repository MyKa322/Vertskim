import { basename } from "node:path";
import {
  EDGE_KINDS,
  MAX_REACH,
  type ContextItem,
  type DirSummary,
  type GraphNode,
  type ImpactedNode,
  type Project,
} from "@vertskim/core";
import { z } from "zod";
import { defineTool, maxTokens, notFound, type ToolSpec } from "./define.js";
import {
  briefFacts,
  Budget,
  estimateTokens,
  kindLabel,
  lineRange,
  mark,
  noteLine,
  numberLines,
  statusLine,
  syntaxErrorLine,
} from "./format.js";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Resolve ids, writing a "did you mean" line for each one that does not exist. */
function resolveAll(project: Project, ids: string[], budget: Budget): GraphNode[] {
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const node = project.node(id);
    if (!node) budget.push(notFound(project, id));
    else if (!seen.has(node.id)) {
      seen.add(node.id);
      nodes.push(node);
    }
  }
  return nodes;
}

function inside(outer: GraphNode, inner: GraphNode): boolean {
  if (outer.id === inner.id) return true;
  if (outer.kind === "directory")
    return outer.path === "" ? inner.kind !== "external" : inner.id.startsWith(outer.path);
  if (outer.kind === "file") return inner.path === outer.id;
  if (outer.kind === "class" || outer.kind === "interface") return inner.id.startsWith(`${outer.id}.`);
  return false;
}

// ---------------------------------------------------------------- overview

const graphOverview = defineTool({
  name: "graph_overview",
  title: "Map the project",
  description:
    "Map of the project or one directory: size, languages, directory layout, entry points, the most depended-on " +
    "files and symbols, and external dependencies. Call first in an unfamiliar project or directory instead of " +
    "listing folders or reading the README.",
  shape: {
    path: z.string().optional().describe("Directory to map, e.g. `src/auth`. Default: the whole project."),
    depth: z.number().int().min(1).max(3).default(2).describe("Levels of subdirectories to show. Default 2."),
    max_tokens: maxTokens(1500),
  },
  run(project, args, context) {
    const budget = new Budget(args.max_tokens);
    const scope = project.node(args.path ?? "./");
    if (!scope) {
      budget.push(args.path ? notFound(project, args.path) : "Nothing is indexed yet.");
      budget.push(statusLine(project));
      return budget.toString();
    }
    if (scope.kind !== "directory") {
      budget.push(`${scope.id} is a ${kindLabel(scope)}, not a directory. Use graph_node to see its outline.`);
      budget.push(statusLine(project));
      return budget.toString();
    }

    const map = project.overview(scope, args.depth);
    context.trace?.([scope.id]);
    const title = scope.id === "./" ? `${basename(project.root)} (project root, id ./)` : scope.id;
    const tests = map.testFiles > 0 ? ` · ${plural(map.testFiles, "test file")}` : "";
    budget.push(`${title}  ${plural(map.files, "file")} · ${plural(map.symbols, "symbol")}${tests}`);
    if (map.languages.length > 0) {
      budget.push(`languages: ${map.languages.map((l) => `${l.language} ${l.files}`).join(", ")}`);
    }

    if (map.tree.length > 0 || map.looseFiles.length > 0) {
      budget.push("layout:");
      const walk = (dirs: DirSummary[], indent: string): boolean => {
        for (const dir of dirs) {
          const symbols = dir.symbols > 0 ? ` · ${plural(dir.symbols, "symbol")}` : "";
          if (!budget.add(`${indent}${dir.id}  ${plural(dir.files, "file")}${symbols}`)) return false;
          if (!walk(dir.children, `${indent}  `)) return false;
        }
        return true;
      };
      if (!walk(map.tree, "  ")) budget.push("  … more directories not shown (raise max_tokens or pass a path)");
      if (map.looseFiles.length > 0) {
        const shown = map.looseFiles.slice(0, 8);
        const more = map.looseFiles.length > shown.length ? `, … +${map.looseFiles.length - shown.length}` : "";
        budget.add(`  files here: ${shown.join(", ")}${more}`);
      }
    }

    if (map.entryPoints.length > 0) {
      budget.add(
        `entry points: ${map.entryPoints
          .slice(0, 6)
          .map((e) => `${e.node.id} (imports ${e.imports})`)
          .join(", ")}`,
      );
    }
    // Something used once is not a hub; list those only when nothing is used more.
    const hubFiles = map.hubFiles.filter((h, i) => h.importers > 1 || i < 3);
    if (hubFiles.length > 0) {
      budget.add("most imported files:");
      for (const hub of hubFiles) {
        if (!budget.add(`  ${hub.node.id}  imported by ${hub.importers}`)) break;
      }
    }
    const hubSymbols = map.hubSymbols.filter((h, i) => h.reach > 1 || i < 3);
    if (hubSymbols.length > 0) {
      budget.add("most relied on (directly or through other code):");
      for (const hub of hubSymbols) {
        const reach = hub.reach >= MAX_REACH ? `${MAX_REACH}+` : String(hub.reach);
        const uses =
          hub.reach > hub.dependents ? `used by ${hub.dependents}, ${reach} in all` : `used by ${hub.dependents}`;
        if (!budget.add(`  ${hub.node.id}  ${kindLabel(hub.node)} · ${uses}`)) break;
      }
    }
    if (map.externals.length > 0) {
      budget.add(`depends on: ${map.externals.map((e) => `${e.node.id} (${plural(e.importers, "file")})`).join(", ")}`);
    }
    if (map.docs.length > 0) {
      budget.add(`docs: ${map.docs.map((d) => (d.doc ? `${d.id} (${d.doc})` : d.id)).join(", ")}`);
    }
    const notes = project
      .listNotes()
      .filter(
        (n) => !n.orphaned && (scope.path === "" ? !n.nodeId.startsWith("ext:") : n.nodeId.startsWith(scope.path)),
      );
    if (notes.length > 0) {
      budget.add(`notes left here (${notes.length}), newest first; graph_annotate lists them all:`);
      for (const note of notes.slice(0, 4)) {
        if (!budget.add(`  ${noteLine(note, true)}`)) break;
      }
    }
    budget.push(statusLine(project));
    return budget.toString();
  },
});

// ------------------------------------------------------------------ impact

function impactLine(targets: GraphNode[], item: ImpactedNode): string {
  let via = "";
  if (item.distance > 1) {
    via = ` ${item.via}`;
  } else {
    const owner = targets.find((t) => item.via.startsWith(t.id) && item.via !== t.id);
    if (owner) via = ` ${item.via.slice(owner.id.length)}`;
    else if (targets.length > 1) via = ` ${item.via}`;
  }
  const test = item.isTest ? " · test" : "";
  return `  ${mark(item.confidence)}${item.node.id}  ${briefFacts(item.node)}${test}  ${item.kind}${via}`;
}

const graphImpact = defineTool({
  name: "graph_impact",
  title: "Blast radius of a change",
  description:
    "Blast radius of changing the given files or symbols: everything that depends on them directly or through " +
    "other code, nearest first, plus the tests that cover them and the docs that mention them. Call before " +
    "modifying, renaming, or deleting code, and afterwards to choose which tests to run.",
  shape: {
    targets: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe('Ids of the files or symbols being changed, e.g. ["src/auth/tokens.ts#rotate"].'),
    depth: z.number().int().min(1).max(5).default(3).describe("Hops of dependents to follow. Default 3."),
    include_tests: z.boolean().default(true).describe("Include test code and list tests to run. Default true."),
    max_tokens: maxTokens(2000),
  },
  ids: (args) => args.targets,
  run(project, args, context) {
    const budget = new Budget(args.max_tokens);
    const targets = resolveAll(project, args.targets, budget);
    if (targets.length === 0) {
      budget.push(statusLine(project));
      return budget.toString();
    }
    const result = project.impact(targets, { depth: args.depth, includeTests: args.include_tests });
    context.trace?.([...targets.map((t) => t.id), ...result.impacted.slice(0, 10).map((i) => i.node.id)]);
    budget.push(`impact of changing ${targets.map((t) => `${t.id} (${kindLabel(t)})`).join(", ")}`);

    if (result.impacted.length === 0) {
      budget.push(
        "No dependents found. Uses that go through values of unknown type, reflection or string lookups are not in the graph.",
      );
    } else {
      const more = result.truncated ? " (search stopped at its size limit)" : "";
      budget.push(
        `${plural(result.impacted.length, "dependent")} in ${plural(result.files.length, "file")}, up to ${plural(args.depth, "hop")} away${more}`,
      );
      const sizes = new Map<number, number>();
      for (const item of result.impacted) sizes.set(item.distance, (sizes.get(item.distance) ?? 0) + 1);
      let shown = 0;
      let lastDistance = 0;
      let sawHeuristic = false;
      for (const item of result.impacted) {
        let block = impactLine(targets, item);
        if (item.distance !== lastDistance) {
          const label = item.distance === 1 ? "direct" : `${item.distance} hops`;
          block = `${label} (${sizes.get(item.distance)})\n${block}`;
        }
        if (!budget.add(block)) break;
        lastDistance = item.distance;
        shown++;
        if (item.confidence === "heuristic") sawHeuristic = true;
      }
      if (shown < result.impacted.length) {
        budget.push(`… ${result.impacted.length - shown} more not shown (raise max_tokens or lower depth)`);
        const fileList = result.files.map((f) => `${f.path} (${f.nodes})`);
        budget.add(`files affected: ${fileList.slice(0, 20).join(", ")}${fileList.length > 20 ? ", …" : ""}`);
      }
      if (sawHeuristic) budget.push("~ = matched by name only; confirm in source");
    }

    if (args.include_tests) {
      budget.add(
        result.tests.length > 0
          ? `tests to run (${result.tests.length}): ${result.tests
              .slice(0, 15)
              .map((t) => `${t.path} (${t.reason})`)
              .join(", ")}${result.tests.length > 15 ? ", …" : ""}`
          : "tests to run: none found that reach it",
      );
    }
    if (result.docs.length > 0) {
      const names = [...new Set(result.docs.map((d) => d.node.id))];
      budget.add(
        `docs that refer to it (${names.length}): ${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}`,
      );
    }
    budget.push(statusLine(project));
    return budget.toString();
  },
});

// -------------------------------------------------------------------- path

const graphPath = defineTool({
  name: "graph_path",
  title: "Connect two nodes",
  description:
    'Shortest chain of relationships between two nodes. Answers "how does A reach B" and "why does A depend on ' +
    'B". If A does not reach B, reports whether B reaches A, or how the two are otherwise connected.',
  shape: {
    from: z.string().min(1).describe("Id of the node the chain starts at."),
    to: z.string().min(1).describe("Id of the node the chain should arrive at."),
    edge_kinds: z
      .array(z.enum(EDGE_KINDS))
      .optional()
      .describe('Only follow these relationships. Default: all except "contains".'),
    max_hops: z.number().int().min(1).max(12).default(6).describe("Longest chain to look for. Default 6."),
  },
  ids: (args) => [args.from, args.to],
  run(project, args, context) {
    const budget = new Budget(1500);
    const from = project.node(args.from);
    const to = project.node(args.to);
    if (!from) budget.push(notFound(project, args.from));
    if (!to) budget.push(notFound(project, args.to));
    if (!from || !to) {
      budget.push(statusLine(project));
      return budget.toString();
    }
    if (inside(from, to) || inside(to, from)) {
      budget.push(
        from.id === to.id
          ? `${from.id}: both ids name the same node.`
          : inside(from, to)
            ? `${to.id} is part of ${from.id}.`
            : `${from.id} is part of ${to.id}.`,
      );
      budget.push(statusLine(project));
      return budget.toString();
    }

    const result = project.path(from, to, { edgeKinds: args.edge_kinds, maxHops: args.max_hops });
    if (!result) {
      budget.push(`No connection found between ${from.id} and ${to.id} within ${plural(args.max_hops, "hop")}.`);
      budget.push(statusLine(project));
      return budget.toString();
    }
    context.trace?.([result.start.id, ...result.steps.map((s) => s.node.id)]);
    const hops = plural(result.steps.length, "hop");
    if (result.mode === "depends") budget.push(`${from.id} reaches ${to.id} in ${hops}:`);
    else if (result.mode === "reverse") {
      budget.push(`${from.id} does not reach ${to.id}. The other way round, ${to.id} reaches ${from.id} in ${hops}:`);
    } else {
      budget.push(`Neither depends on the other. They are connected in ${hops}, ignoring direction:`);
    }
    budget.push(`${result.start.id}  ${briefFacts(result.start)}`);
    let sawHeuristic = false;
    for (const step of result.steps) {
      const arrow = step.direction === "out" ? `→ ${step.kind} →` : `← ${step.kind} ←`;
      budget.push(`  ${arrow} ${mark(step.confidence)}${step.node.id}  ${briefFacts(step.node)}`);
      if (step.confidence === "heuristic") sawHeuristic = true;
    }
    if (result.steps.some((s) => s.direction === "in")) {
      budget.push("→ kind → means the line above uses this one; ← kind ← means this one uses the line above");
    }
    if (sawHeuristic) budget.push("~ = matched by name only; confirm in source");
    budget.push(statusLine(project));
    return budget.toString();
  },
});

// ----------------------------------------------------------------- context

const LEAF_KINDS = new Set(["function", "method", "variable", "type", "interface", "section"]);
const SMALL_CLASS_LINES = 40;
/** Source is shown for starting points and for nodes scoring at least this share of the best. */
const CORE_SHARE = 0.3;

interface Plan {
  item: ContextItem;
  tier: "source" | "signature" | "name";
  block: string;
}

function span(node: GraphNode): number {
  return node.startLine && node.endLine ? node.endLine - node.startLine + 1 : 0;
}

/** Id of a node relative to its file, as shown under a file heading. */
function suffixInFile(node: GraphNode): string {
  if (node.kind === "file") return "(file)";
  return node.path && node.id.startsWith(node.path) ? node.id.slice(node.path.length) : node.id;
}

function signatureLine(node: GraphNode, seed: boolean): string {
  const what =
    node.kind === "file" ? `${node.endLine ?? 0} lines` : (node.signature ?? `${kindLabel(node)} ${node.name}`);
  const doc = node.doc ? ` — ${node.doc}` : "";
  const range = node.kind === "file" ? "" : `  ${lineRange(node)}`;
  return `${suffixInFile(node)}${range}  ${what}${doc}${seed ? "  [start]" : ""}`;
}

const graphContext = defineTool({
  name: "graph_context",
  title: "Gather context for a task",
  description:
    "Assemble the most relevant code for a task within a token budget. Finds starting points from the task text " +
    "and/or seed ids, spreads out along calls, references and inheritance, and returns the closest symbols in most " +
    "detail. Use at the start of a coding or debugging task instead of opening files one by one. " +
    'detail "source" includes the code of the core symbols.',
  shape: {
    task: z
      .string()
      .min(1)
      .optional()
      .describe("What you are trying to do, in plain words. Name symbols or files if you know them."),
    seeds: z.array(z.string().min(1)).max(20).optional().describe("Node ids to start from, if already known."),
    detail: z
      .enum(["names", "signatures", "source"])
      .default("signatures")
      .describe(
        '"names": ids only. "signatures" (default): signature and doc line. "source": code for the core symbols, signatures for the rest.',
      ),
    max_tokens: maxTokens(4000),
  },
  ids: (args) => args.seeds ?? [],
  async run(project, args, context) {
    if (!args.task && !args.seeds?.length) throw new Error("invalid arguments (give `task`, `seeds`, or both)");
    const budget = new Budget(args.max_tokens);
    const result = await project.contextWithMeaning({ task: args.task, seeds: args.seeds });
    for (const id of result.missingSeeds) budget.push(notFound(project, id));
    if (result.items.length === 0) {
      budget.push("No starting points found. Name a symbol or file in `seeds`, or look one up with graph_search.");
      budget.push(statusLine(project));
      return budget.toString();
    }
    budget.push(
      `starting points: ${result.seeds
        .slice(0, 8)
        .map((n) => n.id)
        .join(", ")}`,
    );
    if (result.weakStart) {
      budget.push(
        "These match only a few words of the task, so what follows is a broad guess. Name a symbol or file, " +
          "pass seeds, or look one up with graph_search first.",
      );
    }
    context.trace?.(result.items.slice(0, 12).map((item) => item.node.id));

    // What earlier sessions wrote about this code comes first: it is short and it is why notes exist.
    const noteIds = new Set<string>();
    for (const item of result.items.slice(0, 40)) {
      noteIds.add(item.node.id);
      if (item.node.path) noteIds.add(item.node.path);
    }
    const noteRoom = args.max_tokens * 0.25;
    let noteSpent = 0;
    let noteHeader = false;
    for (const list of project.notesFor([...noteIds]).values()) {
      for (const note of list) {
        const line = `  ${noteLine(note, true)}`;
        noteSpent += estimateTokens(line) + 1;
        if (noteSpent > noteRoom) break;
        if (!noteHeader) budget.push("notes on this code:");
        noteHeader = true;
        budget.push(line);
      }
    }

    // Decide how much detail each node gets, best first, before laying anything out.
    const total = args.max_tokens;
    const detailLimit = total * 0.9;
    const sourceLimit = total * 0.65;
    let spent = total - budget.remaining;
    let sourceSpent = 0;
    const shownRanges = new Map<string, [number, number][]>();
    const overlaps = (node: GraphNode, mode: "within" | "contains"): boolean => {
      if (!node.startLine || !node.endLine) return false;
      return (shownRanges.get(node.path) ?? []).some(([start, end]) =>
        mode === "within"
          ? node.startLine! >= start && node.endLine! <= end
          : start >= node.startLine! && end <= node.endLine!,
      );
    };
    const fileCache = new Map<string, string[] | null>();
    const plans: Plan[] = [];

    const topScore = result.items[0]?.score ?? 0;
    for (const item of result.items) {
      const node = item.node;
      // A file is listed through its symbols; on its own it is only worth a line when it was asked for.
      if (node.kind === "file" && !item.seed) continue;
      if (overlaps(node, "within")) continue; // already visible inside a larger block
      const plan: Plan = { item, tier: "name", block: "" };
      const leaf = LEAF_KINDS.has(node.kind) || (node.kind === "class" && span(node) <= SMALL_CLASS_LINES);
      const core = item.seed || item.score >= topScore * CORE_SHARE;
      if (args.detail === "source" && leaf && core && !overlaps(node, "contains")) {
        const slice = project.readSource(node, fileCache);
        if (slice) {
          const header = `${suffixInFile(node)}  ${briefFacts(node)}${item.seed ? "  [start]" : ""}`;
          const block = `${header}\n${numberLines(slice.text, slice.startLine)}`;
          const cost = estimateTokens(block) + 1;
          if (sourceSpent + cost <= sourceLimit && spent + cost <= detailLimit) {
            plan.tier = "source";
            plan.block = block;
            sourceSpent += cost;
            spent += cost;
            const ranges = shownRanges.get(node.path) ?? [];
            ranges.push([slice.startLine, slice.endLine]);
            shownRanges.set(node.path, ranges);
          }
        }
      }
      if (plan.tier === "name" && args.detail !== "names") {
        const block = signatureLine(node, item.seed);
        const cost = estimateTokens(block) + 1;
        if (spent + cost <= detailLimit) {
          plan.tier = "signature";
          plan.block = block;
          spent += cost;
        }
      }
      plans.push(plan);
    }

    // Lay out by file, best file first, each file in source order.
    const byFile = new Map<string, Plan[]>();
    for (const plan of plans) {
      if (plan.tier === "name") continue;
      const list = byFile.get(plan.item.node.path);
      if (list) list.push(plan);
      else byFile.set(plan.item.node.path, [plan]);
    }
    for (const [path, list] of byFile) {
      budget.push(`## ${path}`);
      list.sort((a, b) => (a.item.node.startLine ?? 0) - (b.item.node.startLine ?? 0));
      for (const plan of list) {
        budget.push(plan.block);
        if (plan.tier !== "source") continue;
        const groups = project.details(plan.item.node).edges;
        const list2 = (direction: "in" | "out") =>
          groups
            .filter((g) => g.direction === direction && g.kind === "calls")
            .flatMap((g) => g.top.slice(0, 4).map((t) => `${mark(t.confidence)}${t.node.id}`));
        const calls = list2("out");
        const calledBy = list2("in");
        const parts = [
          calls.length > 0 ? `calls ${calls.join(", ")}` : "",
          calledBy.length > 0 ? `called by ${calledBy.join(", ")}` : "",
        ].filter(Boolean);
        if (parts.length > 0) budget.add(`  ${parts.join("; ")}`);
      }
    }

    const names = plans.filter((p) => p.tier === "name").map((p) => `${p.item.node.id} (${kindLabel(p.item.node)})`);
    if (names.length > 0) {
      const shown: string[] = [];
      let room = budget.remaining - 40;
      for (const name of names) {
        const cost = estimateTokens(name) + 1;
        if (cost > room) break;
        room -= cost;
        shown.push(name);
      }
      if (shown.length > 0) {
        const more = names.length > shown.length ? `, … +${names.length - shown.length}` : "";
        budget.push(`${byFile.size > 0 ? "also relevant" : "relevant"}: ${shown.join(", ")}${more}`);
      }
    }
    if (args.detail !== "source" && byFile.size > 0) {
      budget.add('Ids are the file path plus the shown suffix. Use graph_node with include ["source"] to read one.');
    }
    budget.push(statusLine(project));
    return budget.toString();
  },
});

// -------------------------------------------------------------------- sync

const graphSync = defineTool({
  name: "graph_sync",
  title: "Re-check the project for changes",
  description:
    "Check the project for changes the graph has missed and report what was updated. Rarely needed: the graph " +
    "follows file changes on its own. Use after bulk changes (branch switch, code generation) if results look " +
    "out of date. Does not modify project files.",
  shape: {
    paths: z
      .array(z.string().min(1))
      .max(200)
      .optional()
      .describe("Only check these files or directories. Default: the whole project."),
    rebuild: z.boolean().default(false).describe("Discard the index and build it again from scratch. Default false."),
  },
  readOnly: false,
  async run(project, args) {
    const result = args.rebuild
      ? await project.rebuild()
      : await project.sync(args.paths?.length ? { paths: args.paths } : { full: true });
    const changed = result.added + result.changed + result.removed;
    const lines = [
      changed === 0
        ? "Already up to date: no file differs from what is indexed."
        : `Updated: ${result.added} added, ${result.changed} changed, ${result.removed} removed; ` +
          `${plural(result.resolvedFiles, "file")} re-linked in ${Math.round(result.durationMs)} ms.`,
      project.status().watching
        ? "File changes are picked up automatically as they happen."
        : "No file watcher is available here, so the project is re-scanned before each query.",
    ];
    const broken = project.status().syntaxErrors;
    if (broken.length > 0) {
      lines.push(`Files with syntax errors (${broken.length}):`);
      for (const error of broken.slice(0, 20)) lines.push(`  ${error.path}: ${syntaxErrorLine(error)}`);
      if (broken.length > 20) lines.push(`  … ${broken.length - 20} more`);
    }
    const indexes = project.compilerIndexes();
    const verified = indexes.reduce((sum, index) => sum + index.filesInUse, 0);
    if (verified > 0) lines.push(`Relationships in ${plural(verified, "file")} come from a compiler index.`);
    for (const index of indexes.filter((i) => !i.inUse)) {
      lines.push(
        `A compiler index was found at ${index.path} but is not used until the user runs \`vertskim scip ${index.path}\`.`,
      );
    }
    const meaning = project.embeddingStatus();
    if (meaning.enabled) {
      lines.push(
        `Search by meaning: ${meaning.embedded} of ${meaning.total} nodes embedded` +
          (meaning.error ? `; the model is not answering (${meaning.error})` : "") +
          ".",
      );
    }
    lines.push(statusLine(project));
    return lines.join("\n");
  },
});

// ----------------------------------------------------------------- open ui

const graphOpenUi = defineTool({
  name: "graph_open_ui",
  title: "Open the 3D graph",
  description:
    "Get the link to the interactive 3D view of the graph, optionally flying to one node. Use when the user " +
    "wants to see or explore the project visually. The page is served from this computer only, updates as files " +
    "change, and highlights the nodes you query. Give the link to the user; it does not open by itself.",
  shape: {
    focus: z.string().min(1).optional().describe("Id of a node to select and fly to."),
  },
  readOnly: false,
  async run(project, args, context) {
    if (!context.openUi) {
      return "The 3D view is not available from this server. Run `vertskim ui` in the project to open it.";
    }
    let focus: string | undefined;
    if (args.focus) {
      const node = project.node(args.focus);
      if (!node) return notFound(project, args.focus);
      focus = node.id;
    }
    const link = await context.openUi(focus);
    if (focus) context.trace?.([focus]);
    return [
      `3D graph: ${link}`,
      focus
        ? `It opens on ${focus}. If the page is already open, it flies there now.`
        : "It opens on an overview; groups open as you fly into them.",
      "The link works on this computer only and stays valid until the server stops.",
    ].join("\n");
  },
});

/** Tools that analyse the graph, maintain it, or show it. */
export const ANALYSIS_TOOLS: ToolSpec[] = [graphOverview, graphContext, graphImpact, graphPath, graphSync, graphOpenUi];
