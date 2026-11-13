import { memberCondition } from "../query/neighbors.js";
import type { GraphStore } from "../store/store.js";
import { EDGE_KINDS, type Confidence, type EdgeKind, type GraphNode } from "../types.js";
import { containsId, marks } from "./common.js";

export interface PathOptions {
  edgeKinds?: EdgeKind[];
  maxHops?: number;
}

export interface PathStep {
  /** Node the step arrives at. */
  node: GraphNode;
  kind: EdgeKind;
  /** `out`: the previous node points at this one. `in`: this one points at the previous node. */
  direction: "out" | "in";
  confidence: Confidence;
  line: number | null;
}

export interface PathResult {
  /**
   * - depends: `from` reaches `to` by following what each node uses
   * - reverse: no such chain, but `to` reaches `from`; the steps run from `to`
   * - related: connected only when direction is ignored and containment is allowed
   */
  mode: "depends" | "reverse" | "related";
  /** First node of the chain: the start node, or the member of it the chain leaves from. */
  start: GraphNode;
  steps: PathStep[];
}

interface Hop {
  other: string;
  kind: EdgeKind;
  direction: "out" | "in";
  confidence: Confidence;
  line: number | null;
}

const MAX_VISITED = 30_000;
const MAX_STARTS = 3000;

function startIds(store: GraphStore, node: GraphNode): string[] {
  const cond = memberCondition(node, "n");
  const rows = store.stmt(`SELECT n.id AS id FROM nodes n WHERE ${cond.sql} LIMIT ${MAX_STARTS}`).all(...cond.params);
  const ids = rows.map((r) => r.id as string);
  return ids.includes(node.id) ? ids : [node.id, ...ids];
}

/** Breadth-first search from any of `starts` to the first node inside `goal`. */
function shortest(
  _store: GraphStore,
  starts: string[],
  goal: GraphNode,
  expand: (id: string) => Hop[],
  maxHops: number,
): { start: string; hops: Hop[] } | null {
  const parent = new Map<string, { prev: string | null; hop: Hop | null }>();
  for (const id of starts) parent.set(id, { prev: null, hop: null });
  let frontier = starts;

  for (let depth = 1; depth <= maxHops && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const hop of expand(id)) {
        if (parent.has(hop.other)) continue;
        parent.set(hop.other, { prev: id, hop });
        if (containsId(goal, hop.other)) {
          const hops: Hop[] = [];
          let cursor: string | null = hop.other;
          while (cursor !== null) {
            const entry: { prev: string | null; hop: Hop | null } = parent.get(cursor)!;
            if (entry.hop === null) return { start: cursor, hops: hops.reverse() };
            hops.push(entry.hop);
            cursor = entry.prev;
          }
        }
        next.push(hop.other);
        if (parent.size >= MAX_VISITED) return null;
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The shortest chain of relationships between two nodes. Tries the direction
 * asked for, then the opposite one, then any connection at all.
 */
export function findPath(
  store: GraphStore,
  from: GraphNode,
  to: GraphNode,
  options: PathOptions = {},
): PathResult | null {
  const maxHops = Math.min(Math.max(options.maxHops ?? 6, 1), 12);
  const kinds = (options.edgeKinds?.length ? options.edgeKinds : EDGE_KINDS.filter((k) => k !== "contains")).filter(
    (k) => (EDGE_KINDS as readonly string[]).includes(k),
  );
  if (kinds.length === 0) return null;

  const outStmt = store.stmt(
    `SELECT dst AS other, kind, confidence, line FROM edges WHERE src = ? AND kind IN (${marks(kinds.length)})`,
  );
  const inStmt = store.stmt(
    `SELECT src AS other, kind, confidence, line FROM edges WHERE dst = ? AND kind IN (${marks(kinds.length)})`,
  );
  const containsOut = store.stmt(
    "SELECT dst AS other, kind, confidence, line FROM edges WHERE src = ? AND kind = 'contains'",
  );
  const containsIn = store.stmt(
    "SELECT src AS other, kind, confidence, line FROM edges WHERE dst = ? AND kind = 'contains'",
  );
  const toHops = (rows: Record<string, unknown>[], direction: "out" | "in"): Hop[] =>
    rows.map((r) => ({
      other: r.other as string,
      kind: r.kind as EdgeKind,
      direction,
      confidence: r.confidence as Confidence,
      line: (r.line as number | null) ?? null,
    }));

  const forward = (id: string) => toHops(outStmt.all(id, ...kinds), "out");
  const anyDirection = (id: string): Hop[] => {
    // Directories connect everything to everything; stepping through them says nothing.
    const structural = [...toHops(containsOut.all(id), "out"), ...toHops(containsIn.all(id), "in")].filter(
      (h) => !h.other.endsWith("/") && !id.endsWith("/"),
    );
    return [...toHops(outStmt.all(id, ...kinds), "out"), ...toHops(inStmt.all(id, ...kinds), "in"), ...structural];
  };

  const build = (mode: PathResult["mode"], found: { start: string; hops: Hop[] }): PathResult | null => {
    const start = store.getNode(found.start);
    if (!start) return null;
    const steps: PathStep[] = [];
    for (const hop of found.hops) {
      const node = store.getNode(hop.other);
      if (!node) return null;
      steps.push({ node, kind: hop.kind, direction: hop.direction, confidence: hop.confidence, line: hop.line });
    }
    return { mode, start, steps };
  };

  const depends = shortest(store, startIds(store, from), to, forward, maxHops);
  if (depends) return build("depends", depends);
  const reverse = shortest(store, startIds(store, to), from, forward, maxHops);
  if (reverse) return build("reverse", reverse);
  const related = shortest(store, startIds(store, from), to, anyDirection, maxHops);
  return related ? build("related", related) : null;
}
