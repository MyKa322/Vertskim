import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import { EDGE_KINDS, type Confidence, type EdgeKind, type GraphNode } from "../types.js";

export interface NeighborOptions {
  id: string;
  /** `in` = nodes that depend on this one; `out` = nodes this one depends on. */
  direction?: "in" | "out" | "both";
  edgeKinds?: EdgeKind[];
  /** 1..3 hops. */
  depth?: number;
  limit?: number;
}

export interface Neighbor {
  node: GraphNode;
  kind: EdgeKind;
  direction: "in" | "out";
  depth: number;
  confidence: Confidence;
  weight: number;
  /**
   * The node on the near side of the edge. At depth 1 this is the queried node
   * or, for a file/class/directory, the member the edge actually touches.
   */
  via: string;
  line: number | null;
}

export interface NeighborResult {
  root: GraphNode;
  neighbors: Neighbor[];
  /** Number of neighbours found before `limit` was applied. */
  total: number;
}

const N_COLUMNS = NODE_COLUMNS.split(", ")
  .map((c) => `n.${c} AS ${c}`)
  .join(", ");

const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 0, resolved: 1, heuristic: 2 };
const MAX_VISITED = 600;
const ROW_CAP = 4000;

/** The string that sorts immediately after every string with the given prefix. */
export function prefixEnd(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/**
 * SQL condition selecting a node together with everything inside it, so that
 * asking about a file, class or directory also sees edges of its members.
 */
export function memberCondition(root: GraphNode, alias: string): { sql: string; params: string[] } {
  if (root.kind === "directory") {
    if (root.path === "") return { sql: `${alias}.kind != 'external'`, params: [] };
    return { sql: `(${alias}.path >= ? AND ${alias}.path < ?)`, params: [root.path, prefixEnd(root.path)] };
  }
  if (root.kind === "file") return { sql: `${alias}.path = ?`, params: [root.id] };
  if (root.kind === "class" || root.kind === "interface") {
    const prefix = `${root.id}.`;
    return { sql: `(${alias}.id = ? OR (${alias}.id >= ? AND ${alias}.id < ?))`, params: [root.id, prefix, prefixEnd(prefix)] };
  }
  return { sql: `${alias}.id = ?`, params: [root.id] };
}

/**
 * Walk relationships outward from a node. The first hop rolls members up into
 * their container; later hops follow the same direction from each neighbour.
 */
export function neighbors(store: GraphStore, root: GraphNode, options: NeighborOptions): NeighborResult {
  const direction = options.direction ?? "both";
  const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const kinds = (options.edgeKinds?.length ? options.edgeKinds : EDGE_KINDS.filter((k) => k !== "contains")).filter(
    (k) => (EDGE_KINDS as readonly string[]).includes(k),
  );
  if (kinds.length === 0) return { root, neighbors: [], total: 0 };
  const kindMarks = kinds.map(() => "?").join(", ");

  const found = new Map<string, Neighbor>();
  const record = (row: Record<string, unknown>, dir: "in" | "out", hop: number, via: string) => {
    const node = rowToNode(row);
    const kind = row.e_kind as EdgeKind;
    const key = `${dir}\u0000${kind}\u0000${node.id}`;
    const confidence = row.e_confidence as Confidence;
    const weight = row.e_weight as number;
    const existing = found.get(key);
    if (existing) {
      if (existing.depth === hop) {
        existing.weight += weight;
        if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[existing.confidence]) existing.confidence = confidence;
      }
      return;
    }
    found.set(key, { node, kind, direction: dir, depth: hop, confidence, weight, via, line: (row.e_line as number | null) ?? null });
  };

  // ---- hop 1, with roll-up
  const wantsContains = kinds.includes("contains");
  const rollup = memberCondition(root, "m");
  const outside = memberCondition(root, "n");
  for (const dir of ["out", "in"] as const) {
    if (direction !== "both" && direction !== dir) continue;
    const near = dir === "out" ? "src" : "dst";
    const far = dir === "out" ? "dst" : "src";
    const rows = store.db
      .prepare(
        `SELECT ${N_COLUMNS}, e.kind AS e_kind, e.confidence AS e_confidence, e.weight AS e_weight,
                e.line AS e_line, m.id AS m_id
         FROM edges e
         JOIN nodes m ON m.id = e.${near}
         JOIN nodes n ON n.id = e.${far}
         WHERE ${rollup.sql} AND e.kind IN (${kindMarks}) AND e.kind != 'contains' AND NOT ${outside.sql}
         ORDER BY e.weight DESC
         LIMIT ${ROW_CAP}`,
      )
      .all(...rollup.params, ...kinds, ...outside.params);
    for (const row of rows) record(row, dir, 1, row.m_id as string);

    if (wantsContains) {
      const containRows = store.db
        .prepare(
          `SELECT ${N_COLUMNS}, e.kind AS e_kind, e.confidence AS e_confidence, e.weight AS e_weight, e.line AS e_line
           FROM edges e JOIN nodes n ON n.id = e.${far}
           WHERE e.${near} = ? AND e.kind = 'contains'`,
        )
        .all(root.id);
      for (const row of containRows) record(row, dir, 1, root.id);
    }
  }

  // ---- further hops: follow each branch in the direction it started
  const visited = new Set<string>([root.id]);
  let frontier = [...found.values()];
  for (const n of frontier) visited.add(n.node.id);
  for (let hop = 2; hop <= depth && frontier.length > 0 && visited.size < MAX_VISITED; hop++) {
    const next: Neighbor[] = [];
    for (const from of frontier) {
      if (visited.size >= MAX_VISITED) break;
      const near = from.direction === "out" ? "src" : "dst";
      const far = from.direction === "out" ? "dst" : "src";
      const rows = store.db
        .prepare(
          `SELECT ${N_COLUMNS}, e.kind AS e_kind, e.confidence AS e_confidence, e.weight AS e_weight, e.line AS e_line
           FROM edges e JOIN nodes n ON n.id = e.${far}
           WHERE e.${near} = ? AND e.kind IN (${kindMarks})
           ORDER BY e.weight DESC LIMIT 200`,
        )
        .all(from.node.id, ...kinds);
      for (const row of rows) {
        const id = row.id as string;
        if (visited.has(id)) continue;
        visited.add(id);
        record(row, from.direction, hop, from.node.id);
        const added = found.get(`${from.direction}\u0000${row.e_kind as string}\u0000${id}`);
        if (added && added.depth === hop) next.push(added);
      }
    }
    frontier = next;
  }

  const all = [...found.values()].sort(
    (a, b) =>
      a.depth - b.depth ||
      (a.direction === b.direction ? 0 : a.direction === "in" ? -1 : 1) ||
      EDGE_KINDS.indexOf(a.kind) - EDGE_KINDS.indexOf(b.kind) ||
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      b.weight - a.weight ||
      a.node.id.localeCompare(b.node.id),
  );
  return { root, neighbors: all.slice(0, limit), total: all.length };
}
