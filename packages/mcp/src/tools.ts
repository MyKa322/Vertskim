import { EDGE_KINDS, NODE_KINDS, type GraphNode, type Neighbor, type OutlineEntry } from "@vertskim/core";
import { z } from "zod";
import { defineTool, maxTokens, notFound, type ToolSpec } from "./define.js";
import {
  Budget,
  facts,
  kindLabel,
  lineRange,
  mark,
  noteLine,
  sourceBlock,
  statusLine,
  syntaxErrorLine,
} from "./format.js";

// ------------------------------------------------------------------ search

const graphSearch = defineTool({
  name: "graph_search",
  title: "Search the project graph",
  description:
    "Find files, symbols, or doc sections by name, keyword, or description. Use instead of grep/glob to locate " +
    "where something is defined or discussed. Returns ranked matches with id, kind, signature, and location, " +
    "not file contents. A match marked ≈ was found by what the code does rather than by its name.",
  shape: {
    query: z
      .string()
      .min(1)
      .describe(
        "Name, partial name, keywords, or a path fragment. Example: `SessionStore`, `rotate token`, `auth/session`.",
      ),
    kinds: z
      .array(z.enum(NODE_KINDS))
      .optional()
      .describe('Only return these node kinds, e.g. ["function", "method"].'),
    path: z
      .string()
      .optional()
      .describe("Only search under this directory, file, or glob. Example: `src/auth`, `*.test.ts`."),
    limit: z.number().int().min(1).max(50).default(10).describe("Maximum matches. Default 10."),
    max_tokens: maxTokens(1000),
  },
  async run(project, args, context) {
    const { hits, partial } = await project.searchWithMeaning({
      query: args.query,
      kinds: args.kinds,
      path: args.path,
      limit: args.limit,
    });
    const byMeaning = hits.filter((hit) => hit.byMeaning).length;
    context.trace?.(hits.slice(0, 8).map((hit) => hit.node.id));
    const budget = new Budget(args.max_tokens);
    const notes = project.notesFor(hits.map((hit) => hit.node.id));
    // Notes are searched too: what was written about a node can name it better than its code does.
    const hitIds = new Set(hits.map((hit) => hit.node.id));
    const noted = project.searchNotes(args.query, 5).filter((n) => !n.orphaned && !hitIds.has(n.nodeId));
    if (hits.length === 0 && noted.length > 0) {
      budget.push(`No node matches "${args.query}" by name; these notes mention it:`);
    } else if (hits.length === 0) {
      const filtered = args.kinds?.length || args.path;
      budget.push(
        `No matches for "${args.query}". Try fewer or different words${filtered ? ", or drop the kinds/path filter" : ""}.`,
      );
    } else {
      const count = `${hits.length} ${hits.length === 1 ? "match" : "matches"}`;
      budget.push(
        partial
          ? `Nothing matches every word of "${args.query}"; ${count} for some of the words:`
          : byMeaning === hits.length
            ? `Nothing is named like "${args.query}"; ${count} by meaning (≈):`
            : `${count} for "${args.query}"${byMeaning > 0 ? " (≈ = found by meaning, not by name)" : ""}`,
      );
      let shown = 0;
      for (const hit of hits) {
        const lines = [
          `${hit.byMeaning ? "≈ " : ""}${hit.node.id}  ${facts(hit.node, hit.fanIn > 0 ? [`used by ${hit.fanIn}`] : [])}`,
        ];
        if (hit.node.signature && hit.node.kind !== "section") lines.push(`  ${hit.node.signature}`);
        if (hit.node.doc) lines.push(`  ${hit.node.doc}`);
        for (const note of notes.get(hit.node.id) ?? []) lines.push(`  ${noteLine(note)}`);
        if (!budget.add(lines.join("\n"))) break;
        shown++;
      }
      if (shown < hits.length) {
        budget.push(`… ${hits.length - shown} more not shown (raise max_tokens or narrow the query)`);
      }
      if (noted.length > 0) budget.add("notes that mention it:");
    }
    for (const note of noted) budget.add(`  ${noteLine(note, true)}`);
    budget.push(statusLine(project));
    return budget.toString();
  },
});

// -------------------------------------------------------------------- node

/** Id of an outline entry relative to its parent (`.method`) or its file (`#Symbol`); whole when written elsewhere. */
function idSuffix(node: GraphNode, parent: GraphNode): string {
  if (node.id.startsWith(parent.id)) return node.id.slice(parent.id.length);
  if (node.path !== parent.path) return node.id; // a Go or Rust method written in another file than its type
  if (node.path && node.id.startsWith(node.path)) return node.id.slice(node.path.length);
  return node.id;
}

function renderOutline(root: GraphNode, entries: OutlineEntry[], budget: Budget): void {
  if (entries.length === 0) return;
  let total = 0;
  const count = (list: OutlineEntry[]) => {
    for (const entry of list) {
      total++;
      count(entry.children);
    }
  };
  count(entries);
  let shown = 0;
  let full = false;

  if (root.kind === "directory") {
    budget.push("  contains:");
    for (const entry of entries) {
      const doc = entry.node.doc ? `  ${entry.node.doc}` : "";
      if (!budget.add(`    ${entry.node.id}  ${facts(entry.node)}${doc}`)) {
        full = true;
        break;
      }
      shown++;
    }
  } else {
    budget.push(`  outline (id = ${root.id} + suffix):`);
    const walk = (list: OutlineEntry[], parent: GraphNode, indent: string) => {
      for (const entry of list) {
        if (full) return;
        const what = entry.node.signature ?? `${kindLabel(entry.node)} ${entry.node.name}`;
        if (!budget.add(`${indent}${idSuffix(entry.node, parent)}  ${lineRange(entry.node)}  ${what}`)) {
          full = true;
          return;
        }
        shown++;
        walk(entry.children, entry.node, `${indent}  `);
      }
    };
    walk(entries, root, "    ");
  }
  if (full) budget.push(`    … ${total - shown} more entries (raise max_tokens)`);
}

const graphNode = defineTool({
  name: "graph_node",
  title: "Inspect graph nodes",
  description:
    "Details for specific nodes: signature, docstring, location, and direct relationships. For a file, class or " +
    'directory it returns an outline (members with signatures) rather than the contents. Add "source" to ' +
    "`include` to get only that symbol's lines; use this instead of reading the whole file.",
  shape: {
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe(
        "Node ids: a file `src/a.ts`, a directory `src/`, a symbol `src/a.ts#Class.method`, or a doc section `README.md#usage`.",
      ),
    include: z
      .array(z.enum(["outline", "neighbors", "source"]))
      .default(["outline", "neighbors"])
      .describe('What to return besides the header. Default ["outline", "neighbors"].'),
    max_tokens: maxTokens(2000),
  },
  ids: (args) => args.ids,
  run(project, args, context) {
    const include = new Set(args.include);
    const budget = new Budget(args.max_tokens);
    for (const input of args.ids) {
      const node = project.node(input);
      if (!node) {
        budget.push(notFound(project, input));
        continue;
      }
      const info = project.details(node);
      context.trace?.([node.id]);
      budget.push(`${node.id}  ${facts(node)}`);
      if (node.signature && node.kind !== "section") budget.push(`  ${node.signature}`);
      if (node.doc) budget.push(`  ${node.doc}`);
      const broken = node.kind !== "directory" && node.kind !== "external" ? project.syntaxError(node.path) : null;
      if (broken) budget.push(`  ${syntaxErrorLine(broken)}`);
      for (const note of project.notesFor([node.id]).get(node.id) ?? []) budget.push(`  ${noteLine(note)}`);

      if (include.has("outline")) renderOutline(node, info.outline, budget);
      if (include.has("neighbors")) {
        for (const group of info.edges) {
          const names = group.top.map((t) => `${mark(t.confidence)}${t.node.id}`);
          const more = group.count > group.top.length ? `, … +${group.count - group.top.length}` : "";
          budget.add(`  ${group.direction.padEnd(3)} ${group.kind} (${group.count}): ${names.join(", ")}${more}`);
        }
      }
      if (include.has("source")) {
        const slice = project.readSource(node);
        if (slice) {
          budget.push(`  source ${slice.path} L${slice.startLine}-${slice.endLine}:`);
          sourceBlock(slice.text, slice.startLine, budget, slice.path);
        } else {
          budget.push("  source: not available for this node");
        }
      }
    }
    budget.push(statusLine(project));
    return budget.toString();
  },
});

// --------------------------------------------------------------- neighbors

function neighborLine(root: GraphNode, n: Neighbor): string {
  const parts = [kindLabel(n.node)];
  const range = lineRange(n.node);
  if (range && n.node.kind !== "file") parts.push(range);
  let via = "";
  if (n.depth > 1) via = `  via ${n.via}`;
  else if (n.via !== root.id) via = `  via ${n.via.startsWith(root.id) ? n.via.slice(root.id.length) : n.via}`;
  const weight = n.weight > 1 ? `  x${n.weight}` : "";
  return `  ${mark(n.confidence)}${n.node.id}  ${parts.join(" · ")}${via}${weight}`;
}

const graphNeighbors = defineTool({
  name: "graph_neighbors",
  title: "Walk relationships from a node",
  description:
    "Walk relationships from a node: callers, callees, importers, subclasses, tests, docs that mention it. Use " +
    'for "who uses X" or "what does X depend on". direction "in" = things that depend on this node. For a ' +
    "file, class or directory, relationships of its members are included.",
  shape: {
    id: z.string().min(1).describe("Node id, as returned by graph_search or graph_node."),
    direction: z
      .enum(["in", "out", "both"])
      .default("both")
      .describe('"in": dependents (callers, importers). "out": dependencies. Default "both".'),
    edge_kinds: z
      .array(z.enum(EDGE_KINDS))
      .optional()
      .describe('Only follow these relationships. Default: all except "contains".'),
    depth: z.number().int().min(1).max(3).default(1).describe("Hops to follow. Default 1."),
    limit: z.number().int().min(1).max(200).default(30).describe("Maximum neighbours. Default 30."),
    max_tokens: maxTokens(1500),
  },
  ids: (args) => [args.id],
  run(project, args, context) {
    const node = project.node(args.id);
    const budget = new Budget(args.max_tokens);
    if (!node) {
      budget.push(notFound(project, args.id));
      budget.push(statusLine(project));
      return budget.toString();
    }
    const result = project.neighbors(node, {
      direction: args.direction,
      edgeKinds: args.edge_kinds,
      depth: args.depth,
      limit: args.limit,
    });
    context.trace?.([node.id, ...result.neighbors.slice(0, 8).map((n) => n.node.id)]);
    budget.push(`${node.id}  ${facts(node)}`);
    if (result.neighbors.length === 0) {
      const scope = [args.direction === "both" ? null : `direction ${args.direction}`, args.edge_kinds?.join("/")]
        .filter(Boolean)
        .join(", ");
      budget.push(`  no relationships found${scope ? ` (${scope})` : ""}`);
    }

    // Group size is counted over everything returned, so headers stay truthful when lines are cut.
    const groupKey = (n: Neighbor) => `${n.depth}:${n.direction}:${n.kind}`;
    const sizes = new Map<string, number>();
    for (const n of result.neighbors) sizes.set(groupKey(n), (sizes.get(groupKey(n)) ?? 0) + 1);

    let shown = 0;
    let lastGroup = "";
    let sawHeuristic = false;
    for (const n of result.neighbors) {
      const key = groupKey(n);
      let block = neighborLine(node, n);
      if (key !== lastGroup) {
        const depth = n.depth > 1 ? `depth ${n.depth} · ` : "";
        block = `${depth}${n.direction} ${n.kind} (${sizes.get(key)})\n${block}`;
      }
      if (!budget.add(block)) break;
      lastGroup = key;
      shown++;
      if (n.confidence === "heuristic") sawHeuristic = true;
    }
    if (shown < result.total) {
      budget.push(`… ${result.total - shown} more not shown (raise limit or max_tokens, or filter edge_kinds)`);
    }
    if (sawHeuristic) budget.push("~ = matched by name only; confirm in source");
    budget.push(statusLine(project));
    return budget.toString();
  },
});

/** Tools that look things up: search, inspect, walk. */
export const QUERY_TOOLS: ToolSpec[] = [graphSearch, graphNode, graphNeighbors];
