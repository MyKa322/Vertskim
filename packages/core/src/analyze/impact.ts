import { memberCondition } from "../query/neighbors.js";
import { rowToNode, type GraphStore } from "../store/store.js";
import type { Confidence, EdgeKind, GraphNode } from "../types.js";
import { containsNode, DEPENDENCY_KINDS, marks, N_COLUMNS } from "./common.js";

export interface ImpactOptions {
  /** How many hops of dependents to follow, 1..5. */
  depth?: number;
  /** Include code in test files. */
  includeTests?: boolean;
}

export interface ImpactedNode {
  node: GraphNode;
  /** Hops from the nearest target. */
  distance: number;
  kind: EdgeKind;
  confidence: Confidence;
  /** The node it depends on: a target, a member of one, or a closer impacted node. */
  via: string;
  isTest: boolean;
}

export interface ImpactResult {
  targets: GraphNode[];
  impacted: ImpactedNode[];
  /** True when the search stopped at its size cap. */
  truncated: boolean;
  files: { path: string; nodes: number; distance: number; isTest: boolean }[];
  tests: { path: string; reason: string }[];
  docs: { node: GraphNode; kind: EdgeKind; target: string }[];
}

const MAX_IMPACTED = 800;
const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 0, resolved: 1, heuristic: 2 };

/**
 * Everything that depends on the targets, directly or through other
 * dependents: the blast radius of changing them.
 */
export function impact(store: GraphStore, targets: GraphNode[], options: ImpactOptions = {}): ImpactResult {
  const depth = Math.min(Math.max(options.depth ?? 3, 1), 5);
  const includeTests = options.includeTests ?? true;

  const testFiles = new Map<string, boolean>();
  const isTest = (path: string): boolean => {
    let known = testFiles.get(path);
    if (known === undefined) {
      known = store.getFile(path)?.subkind === "test";
      testFiles.set(path, known);
    }
    return known;
  };
  const insideTarget = (node: GraphNode) => targets.some((t) => containsNode(t, node));

  const visited = new Map<string, ImpactedNode>();
  let truncated = false;
  let frontier = targets;

  search: for (let distance = 1; distance <= depth && frontier.length > 0; distance++) {
    const next: GraphNode[] = [];
    for (const from of frontier) {
      // Targets and classes stand for their members: a caller of a method depends on the class.
      const rollup = distance === 1 || from.kind === "class" || from.kind === "interface";
      const cond = rollup ? memberCondition(from, "m") : { sql: "m.id = ?", params: [from.id] };
      const rows = store
        .stmt(
          `SELECT ${N_COLUMNS}, e.kind AS e_kind, e.confidence AS e_confidence, m.id AS m_id
           FROM edges e
           JOIN nodes m ON m.id = e.dst
           JOIN nodes n ON n.id = e.src
           WHERE ${cond.sql} AND e.kind IN (${marks(DEPENDENCY_KINDS.length)})
           ORDER BY e.weight DESC
           LIMIT 2000`,
        )
        .all(...cond.params, ...DEPENDENCY_KINDS);
      for (const row of rows) {
        const node = rowToNode(row);
        if (visited.has(node.id) || insideTarget(node)) continue;
        if (rollup && containsNode(from, node)) continue;
        const test = isTest(node.path);
        if (test && !includeTests) continue;
        const kind = row.e_kind as EdgeKind;
        visited.set(node.id, {
          node,
          distance,
          kind,
          confidence: row.e_confidence as Confidence,
          via: row.m_id as string,
          isTest: test,
        });
        // A file reached because its top-level code uses something is affected itself, but
        // that says nothing about the files importing it; only an import chain carries on.
        if (node.kind !== "file" || kind === "imports") next.push(node);
        if (visited.size >= MAX_IMPACTED) {
          truncated = true;
          break search;
        }
      }
    }
    frontier = next;
  }

  const impacted = [...visited.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      Number(a.isTest) - Number(b.isTest) ||
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      a.node.id.localeCompare(b.node.id),
  );

  const byFile = new Map<string, { path: string; nodes: number; distance: number; isTest: boolean }>();
  for (const item of impacted) {
    if (!item.node.path) continue;
    const entry = byFile.get(item.node.path);
    if (entry) {
      entry.nodes++;
      entry.distance = Math.min(entry.distance, item.distance);
    } else {
      byFile.set(item.node.path, { path: item.node.path, nodes: 1, distance: item.distance, isTest: item.isTest });
    }
  }
  const files = [...byFile.values()].sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));

  // Tests: files with impacted code first, then tests that import a target's file without touching it by name.
  const tests: { path: string; reason: string }[] = [];
  const listed = new Set<string>();
  if (includeTests) {
    for (const file of files) {
      if (!file.isTest) continue;
      listed.add(file.path);
      tests.push({
        path: file.path,
        reason: file.distance === 1 ? "uses it directly" : `reaches it in ${file.distance} hops`,
      });
    }
    const targetFiles = new Set<string>();
    for (const target of targets) {
      if (target.kind === "directory" || target.kind === "external" || !target.path) continue;
      targetFiles.add(target.path);
    }
    for (const path of targetFiles) {
      for (const edge of store.edgesTo(path, "tests")) {
        if (listed.has(edge.src)) continue;
        listed.add(edge.src);
        tests.push({ path: edge.src, reason: `imports ${path}` });
      }
    }
  }

  const docs: ImpactResult["docs"] = [];
  const seenDocs = new Set<string>();
  for (const target of targets) {
    const cond = memberCondition(target, "m");
    const rows = store
      .stmt(
        `SELECT ${N_COLUMNS}, e.kind AS e_kind, m.id AS m_id
         FROM edges e JOIN nodes m ON m.id = e.dst JOIN nodes n ON n.id = e.src
         WHERE ${cond.sql} AND e.kind IN ('mentions', 'links_to')
         LIMIT 200`,
      )
      .all(...cond.params);
    for (const row of rows) {
      const node = rowToNode(row);
      const key = `${node.id}\u0000${row.m_id as string}`;
      if (seenDocs.has(key) || insideTarget(node)) continue;
      seenDocs.add(key);
      docs.push({ node, kind: row.e_kind as EdgeKind, target: row.m_id as string });
    }
  }

  return { targets, impacted, truncated, files, tests, docs };
}
