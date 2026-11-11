import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import { EDGE_KINDS, type Confidence, type EdgeKind, type FileRecord, type GraphNode } from "../types.js";

export interface OutlineEntry {
  node: GraphNode;
  children: OutlineEntry[];
}

export interface EdgeGroup {
  direction: "in" | "out";
  kind: EdgeKind;
  count: number;
  /** Heaviest edges first; at most a handful. */
  top: { node: GraphNode; confidence: Confidence; weight: number }[];
}

export interface NodeDetails {
  node: GraphNode;
  /** Present for file nodes. */
  file: FileRecord | null;
  outline: OutlineEntry[];
  edges: EdgeGroup[];
}

const N_COLUMNS = NODE_COLUMNS.split(", ")
  .map((c) => `n.${c} AS ${c}`)
  .join(", ");
const TOP_PER_GROUP = 6;

function outlineOf(store: GraphStore, id: string, depth: number): OutlineEntry[] {
  return store.children(id).map((node) => ({
    node,
    children: depth > 1 && node.kind !== "directory" && node.kind !== "file" ? outlineOf(store, node.id, depth - 1) : [],
  }));
}

/** Everything `graph_node` shows about one node, apart from its source text. */
export function details(store: GraphStore, node: GraphNode): NodeDetails {
  const groups = new Map<string, EdgeGroup>();
  for (const direction of ["in", "out"] as const) {
    const near = direction === "out" ? "src" : "dst";
    const far = direction === "out" ? "dst" : "src";
    const rows = store.db
      .prepare(
        `SELECT ${N_COLUMNS}, e.kind AS e_kind, e.confidence AS e_confidence, e.weight AS e_weight
         FROM edges e JOIN nodes n ON n.id = e.${far}
         WHERE e.${near} = ? AND e.kind != 'contains'
         ORDER BY e.weight DESC, n.id`,
      )
      .all(node.id);
    for (const row of rows) {
      const kind = row.e_kind as EdgeKind;
      const key = `${direction}:${kind}`;
      let group = groups.get(key);
      if (!group) {
        group = { direction, kind, count: 0, top: [] };
        groups.set(key, group);
      }
      group.count++;
      if (group.top.length < TOP_PER_GROUP) {
        group.top.push({
          node: rowToNode(row),
          confidence: row.e_confidence as Confidence,
          weight: row.e_weight as number,
        });
      }
    }
  }
  const edges = [...groups.values()].sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === "in" ? -1 : 1) ||
      EDGE_KINDS.indexOf(a.kind) - EDGE_KINDS.indexOf(b.kind),
  );
  return {
    node,
    file: node.kind === "file" ? store.getFile(node.id) : null,
    outline: outlineOf(store, node.id, node.kind === "directory" ? 1 : 2),
    edges,
  };
}
