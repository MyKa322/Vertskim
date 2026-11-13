import type { GraphStore } from "../store/store.js";

/** Edges along which one piece of code relies on another. */
export const USE_KINDS = ["calls", "references", "extends", "implements"] as const;

/** Every use edge loaded once, with each user counted once per node it uses. */
export interface UseGraph {
  ids: string[];
  index: Map<string, number>;
  /** Users of node i: `users.subarray(start[i], start[i + 1])`. */
  start: Int32Array;
  users: Int32Array;
}

export function loadUseGraph(store: GraphStore): UseGraph {
  const index = new Map<string, number>();
  const ids: string[] = [];
  const idOf = (id: string) => {
    let i = index.get(id);
    if (i === undefined) {
      i = ids.length;
      index.set(id, i);
      ids.push(id);
    }
    return i;
  };
  const rows = store
    .stmt(`SELECT DISTINCT src, dst FROM edges WHERE kind IN (${USE_KINDS.map(() => "?").join(", ")}) AND src != dst`)
    .all(...USE_KINDS);
  const src = new Int32Array(rows.length);
  const dst = new Int32Array(rows.length);
  rows.forEach((row, e) => {
    src[e] = idOf(row.src as string);
    dst[e] = idOf(row.dst as string);
  });
  const n = ids.length;
  const start = new Int32Array(n + 1);
  for (let e = 0; e < rows.length; e++) start[dst[e]! + 1]!++;
  for (let i = 0; i < n; i++) start[i + 1]! += start[i]!;
  const fill = start.slice(0, n);
  const users = new Int32Array(rows.length);
  for (let e = 0; e < rows.length; e++) users[fill[dst[e]!]!++] = src[e]!;
  return { ids, index, start, users };
}

/**
 * How much the code leans on each node: every direct user counts once, plus the log of
 * how many use it in turn. A helper of heavily used code ranks above one used as often
 * by code nothing calls, while long chains of single uses (a type alias of a type alias)
 * do not pile up the way they would under PageRank.
 */
export function useScore(graph: UseGraph): Float64Array {
  const { start, users } = graph;
  const score = new Float64Array(graph.ids.length);
  for (let i = 0; i < score.length; i++) {
    let sum = 0;
    for (let k = start[i]!; k < start[i + 1]!; k++) {
      const user = users[k]!;
      sum += 1 + Math.log1p(start[user + 1]! - start[user]!);
    }
    score[i] = sum;
  }
  return score;
}

/** How many nodes use `id`, directly or through other code, counting up to `limit`. */
export function reachOf(graph: UseGraph, id: string, limit: number): number {
  const first = graph.index.get(id);
  if (first === undefined) return 0;
  const seen = new Uint8Array(graph.ids.length);
  seen[first] = 1;
  const queue = [first];
  let count = 0;
  for (let head = 0; head < queue.length && count < limit; head++) {
    const node = queue[head]!;
    for (let k = graph.start[node]!; k < graph.start[node + 1]!; k++) {
      const user = graph.users[k]!;
      if (seen[user]) continue;
      seen[user] = 1;
      queue.push(user);
      count++;
    }
  }
  return Math.min(count, limit);
}
