import { specFor } from "../extract/index.js";
import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import { EDGE_KINDS, type Confidence, type EdgeKind, type FileRecord, type GraphNode } from "../types.js";
import { posixDirname } from "../util.js";

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

const TYPE_KINDS = new Set(["class", "interface", "type"]);

/** `a/b.go#Cart.Add` -> `Cart.Add`. */
function qnameOf(node: GraphNode): string {
  const hash = node.id.indexOf("#");
  return hash < 0 ? node.name : node.id.slice(hash + 1);
}

/**
 * Methods of a Go, Rust or C++ type written in another file: in Go, any file of the package
 * (its directory); in Rust, any module of the crate (the folder holding `Cargo.toml`); in
 * C++, any file (`void Cart::add() {...}` in a source file, apart from the header).
 * They hang off their own file, so the type's children do not include them. A method in
 * another directory belongs to this type only when no other type has its name, the rule
 * the resolver follows.
 */
function methodsWrittenApart(store: GraphStore, type: GraphNode): GraphNode[] {
  const family = specFor(type.language)?.family;
  if (!TYPE_KINDS.has(type.kind) || (family !== "go" && family !== "rust" && family !== "c")) return [];
  const dir = posixDirname(type.path);
  // C and C++ define methods anywhere, often in a source folder apart from the headers.
  let scope = family === "c" ? "" : dir;
  if (family === "rust") {
    for (let d = dir; ; d = posixDirname(d)) {
      if (store.hasNode(d ? `${d}/Cargo.toml` : "Cargo.toml")) {
        scope = d;
        break;
      }
      if (!d) break;
    }
  }
  // Ids under `scope/`: in code point order they all sort between `scope/` and `scope0`.
  const rows = scope
    ? store
        .stmt(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id > ? AND id < ? AND kind = 'method' AND parent = path`)
        .all(`${scope}/`, `${scope}0`)
    : store.stmt(`SELECT ${NODE_COLUMNS} FROM nodes WHERE kind = 'method' AND parent = path`).all();
  const qname = qnameOf(type);
  let unique: boolean | null = null;
  const out: GraphNode[] = [];
  for (const node of rows.map(rowToNode)) {
    if (node.path === type.path || qnameOf(node) !== `${qname}.${node.name}`) continue;
    if (specFor(node.language)?.family !== family) continue;
    if (posixDirname(node.path) !== dir) {
      if (family === "go") continue;
      unique ??=
        store
          .nodesNamed(type.name)
          .filter((n) => TYPE_KINDS.has(n.kind) && qnameOf(n) === qname && specFor(n.language)?.family === family)
          .length === 1;
      if (!unique) continue;
    }
    out.push(node);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || (a.startLine ?? 0) - (b.startLine ?? 0));
}

function outlineOf(store: GraphStore, parent: GraphNode, depth: number): OutlineEntry[] {
  const children = store.children(parent.id);
  children.push(...methodsWrittenApart(store, parent));
  return children.map((node) => ({
    node,
    children: depth > 1 && node.kind !== "directory" && node.kind !== "file" ? outlineOf(store, node, depth - 1) : [],
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
    outline: outlineOf(store, node, node.kind === "directory" ? 1 : 2),
    edges,
  };
}
