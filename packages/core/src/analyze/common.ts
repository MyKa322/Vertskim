import { NODE_COLUMNS } from "../store/store.js";
import type { EdgeKind, GraphNode } from "../types.js";

/** `n.id AS id, n.kind AS kind, ...` for queries that join nodes as `n`. */
export const N_COLUMNS = NODE_COLUMNS.split(", ")
  .map((c) => `n.${c} AS ${c}`)
  .join(", ");

/** Edges that mean "the source needs the target to keep working". */
export const DEPENDENCY_KINDS: EdgeKind[] = ["calls", "references", "extends", "implements", "imports"];

export const SYMBOL_KINDS = ["class", "interface", "function", "method", "variable", "type"] as const;

export function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** True when `inner` is `outer` itself or lives inside it. */
export function containsNode(outer: GraphNode, inner: GraphNode): boolean {
  return containsId(outer, inner.id, inner.kind);
}

/** Same as {@link containsNode} when only the inner node's id is known. */
export function containsId(outer: GraphNode, id: string, kind?: string): boolean {
  if (outer.id === id) return true;
  switch (outer.kind) {
    case "directory":
      if (outer.path === "") return kind !== "external" && !id.startsWith("ext:");
      return id.startsWith(outer.path);
    case "file":
      return id.startsWith(`${outer.id}#`);
    case "class":
    case "interface":
      return id.startsWith(`${outer.id}.`);
    default:
      return false;
  }
}
