import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import type { GraphNode } from "../types.js";
import { posixDirname } from "../util.js";

/** How many parameters and results a method has: enough to tell most look-alikes apart. */
interface Shape {
  params: number;
  results: number;
}

/** Method name -> its shape, or null when the signature could not be read. */
type MethodSet = Map<string, Shape | null>;

/**
 * An interface satisfied by more types than this says little about any of them
 * (`String() string`), so none of its implementations are drawn.
 */
const MAX_IMPLEMENTATIONS = 50;
/** How deep embedded types are followed for their methods. */
const MAX_EMBED_DEPTH = 3;

/** Items of a comma-separated list at the top level: `a, b int` -> 2, `` -> 0. */
function countItems(list: string): number {
  if (list.trim() === "") return 0;
  let depth = 0;
  let count = 1;
  for (const ch of list) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** `func (c *Cart) Add(item Item) error` or `Add(item Item) error` -> 1 parameter, 1 result. */
export function methodShape(signature: string | null | undefined, name: string): Shape | null {
  if (!signature) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = new RegExp(`(?:^|[\\s.)])${escaped}\\s*\\(`).exec(signature);
  if (!at) return null;
  const open = at.index + at[0].length - 1;
  const close = closing(signature, open);
  if (close < 0) return null;
  const rest = signature.slice(close + 1).trim();
  let results = rest ? 1 : 0;
  if (rest.startsWith("(")) {
    const end = closing(rest, 0);
    results = end < 0 ? 0 : countItems(rest.slice(1, end));
  }
  return { params: countItems(signature.slice(open + 1, close)), results };
}

function sameShape(a: Shape | null, b: Shape | null): boolean {
  return !a || !b || (a.params === b.params && a.results === b.results);
}

/**
 * Go types satisfy interfaces without saying so. Where a type's methods, its own and
 * those of the types it embeds, cover every method of an interface by name and by the
 * number of parameters and results, an `implements` edge is drawn, marked as a guess
 * since parameter types are not compared. Rebuilt whole whenever Go files are resolved:
 * an interface anywhere can gain or lose implementations. Returns the edges drawn.
 */
export function linkImplicitInterfaces(store: GraphStore): number {
  store
    .stmt(
      `DELETE FROM edges WHERE kind = 'implements' AND confidence = 'heuristic'
         AND origin_file IN (SELECT path FROM files WHERE language = 'go')`,
    )
    .run();
  const nodes = store
    .stmt(
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE language = 'go' AND kind IN ('class', 'type', 'interface', 'method')`,
    )
    .all()
    .map(rowToNode);

  const types = new Map<string, GraphNode>();
  const typesByKey = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.kind === "method") continue;
    types.set(node.id, node);
    if (node.kind !== "interface") typesByKey.set(`${posixDirname(node.path)}\u0000${node.name}`, node);
  }
  const own = new Map<string, MethodSet>();
  for (const method of nodes) {
    if (method.kind !== "method" || !method.parent) continue;
    let owner = types.get(method.parent) ?? null;
    if (!owner && method.parent === method.path) {
      // Written apart from its type, in another file of the package: `file.go#Cart.sum`.
      const qname = method.id.slice(method.id.indexOf("#") + 1);
      const typeName = qname.slice(0, qname.lastIndexOf("."));
      owner = typesByKey.get(`${posixDirname(method.path)}\u0000${typeName}`) ?? null;
    }
    if (!owner) continue;
    let set = own.get(owner.id);
    if (!set) {
      set = new Map();
      own.set(owner.id, set);
    }
    set.set(method.name, methodShape(method.signature, method.name));
  }

  // Methods of embedded types count as the type's own (promoted methods, embedded interfaces).
  const fullCache = new Map<string, MethodSet>();
  const full = (id: string, depth: number, seen: Set<string>): MethodSet => {
    const cached = fullCache.get(id);
    if (cached) return cached;
    const set: MethodSet = new Map(own.get(id) ?? []);
    if (depth < MAX_EMBED_DEPTH && !seen.has(id)) {
      seen.add(id);
      for (const edge of store.edgesFrom(id, "extends")) {
        if (!types.has(edge.dst)) continue;
        for (const [name, shape] of full(edge.dst, depth + 1, seen)) if (!set.has(name)) set.set(name, shape);
      }
    }
    if (depth === 0) fullCache.set(id, set);
    return set;
  };

  const byMethod = new Map<string, GraphNode[]>();
  for (const type of types.values()) {
    if (type.kind === "interface") continue;
    for (const name of full(type.id, 0, new Set()).keys()) {
      const list = byMethod.get(name);
      if (list) list.push(type);
      else byMethod.set(name, [type]);
    }
  }

  let drawn = 0;
  for (const iface of types.values()) {
    if (iface.kind !== "interface") continue;
    const wanted = full(iface.id, 0, new Set());
    if (wanted.size === 0) continue; // `interface{}` and constraints: anything satisfies them
    let rarest: GraphNode[] | null = null;
    for (const name of wanted.keys()) {
      const list = byMethod.get(name) ?? [];
      if (!rarest || list.length < rarest.length) rarest = list;
    }
    const found = (rarest ?? []).filter((type) => {
      const has = full(type.id, 0, new Set());
      for (const [name, shape] of wanted) if (!has.has(name) || !sameShape(shape, has.get(name)!)) return false;
      return true;
    });
    if (found.length > MAX_IMPLEMENTATIONS) continue;
    for (const type of found) {
      if (store.edgesFrom(type.id, "implements").some((e) => e.dst === iface.id)) continue;
      store.addEdge({
        src: type.id,
        dst: iface.id,
        kind: "implements",
        weight: 1,
        confidence: "heuristic",
        originFile: type.path,
        line: type.startLine ?? null,
      });
      drawn++;
    }
  }
  return drawn;
}
