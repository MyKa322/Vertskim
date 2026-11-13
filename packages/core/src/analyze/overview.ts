import { prefixEnd } from "../query/neighbors.js";
import { rowToNode, type GraphStore } from "../store/store.js";
import type { GraphNode } from "../types.js";
import { marks, N_COLUMNS, SYMBOL_KINDS } from "./common.js";
import { loadUseGraph, reachOf, USE_KINDS, useScore } from "./rank.js";

/** Indirect users are counted up to this many. */
export const MAX_REACH = 1000;

export interface DirSummary {
  /** Directory node id, e.g. `src/auth/`. */
  id: string;
  /** Files anywhere beneath it. */
  files: number;
  symbols: number;
  children: DirSummary[];
}

export interface Overview {
  scope: GraphNode;
  files: number;
  symbols: number;
  testFiles: number;
  languages: { language: string; files: number }[];
  tree: DirSummary[];
  /** Files sitting directly in the scope directory. */
  looseFiles: string[];
  entryPoints: { node: GraphNode; imports: number }[];
  hubFiles: { node: GraphNode; importers: number }[];
  /**
   * The symbols the rest of the code leans on most, directly or through other code.
   * `dependents` use one directly; `reach` counts everything that uses it in some way,
   * up to {@link MAX_REACH}.
   */
  hubSymbols: { node: GraphNode; dependents: number; reach: number }[];
  externals: { node: GraphNode; importers: number }[];
  docs: GraphNode[];
}

interface Counter {
  files: number;
  symbols: number;
  children: Map<string, Counter>;
}

function toSummaries(prefix: string, counter: Counter): DirSummary[] {
  return [...counter.children.entries()]
    .map(([name, child]) => ({
      id: `${prefix}${name}/`,
      files: child.files,
      symbols: child.symbols,
      children: toSummaries(`${prefix}${name}/`, child),
    }))
    .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id));
}

/**
 * A map of a directory (by default the whole project): size, languages,
 * layout, where execution starts, and what the rest of the code leans on.
 */
export function overview(store: GraphStore, scope: GraphNode, depth = 2): Overview {
  const levels = Math.min(Math.max(depth, 1), 3);
  const prefix = scope.path; // "" for the root, otherwise "dir/"
  const scoped = prefix !== "";
  const range = scoped ? [prefix, prefixEnd(prefix)] : [];
  const where = (column: string) => (scoped ? ` AND ${column} >= ? AND ${column} < ?` : "");

  const symbolCounts = new Map<string, number>();
  for (const row of store
    .stmt(
      `SELECT path, COUNT(*) AS c FROM nodes
       WHERE kind IN (${marks(SYMBOL_KINDS.length)})${where("path")} GROUP BY path`,
    )
    .all(...SYMBOL_KINDS, ...range)) {
    symbolCounts.set(row.path as string, row.c as number);
  }

  const root: Counter = { files: 0, symbols: 0, children: new Map() };
  const languages = new Map<string, number>();
  const looseFiles: string[] = [];
  let testFiles = 0;
  for (const row of store
    .stmt(`SELECT path, language, subkind FROM files WHERE 1 = 1${where("path")} ORDER BY path`)
    .all(...range)) {
    const path = row.path as string;
    const symbols = symbolCounts.get(path) ?? 0;
    const language = (row.language as string | null) ?? "other";
    languages.set(language, (languages.get(language) ?? 0) + 1);
    if (row.subkind === "test") testFiles++;
    root.files++;
    root.symbols += symbols;

    const segments = path.slice(prefix.length).split("/");
    if (segments.length === 1) looseFiles.push(path);
    let cursor = root;
    for (let i = 0; i < segments.length - 1 && i < levels; i++) {
      let child = cursor.children.get(segments[i]!);
      if (!child) {
        child = { files: 0, symbols: 0, children: new Map() };
        cursor.children.set(segments[i]!, child);
      }
      child.files++;
      child.symbols += symbols;
      cursor = child;
    }
  }

  const hubFiles = store
    .stmt(
      `SELECT ${N_COLUMNS}, COUNT(*) AS c FROM edges e JOIN nodes n ON n.id = e.dst
       WHERE e.kind = 'imports' AND n.kind = 'file'${where("n.path")}
       GROUP BY e.dst ORDER BY c DESC, n.id LIMIT 8`,
    )
    .all(...range)
    .map((row) => ({ node: rowToNode(row), importers: row.c as number }));

  // Ranked by direct users, each weighted by how much it is used in turn (see useScore).
  const used = store
    .stmt(
      `SELECT e.dst AS id, COUNT(DISTINCT e.src) AS c FROM edges e JOIN nodes n ON n.id = e.dst
       WHERE e.kind IN (${marks(USE_KINDS.length)}) AND e.src != e.dst
         AND n.kind IN (${marks(SYMBOL_KINDS.length)})${where("n.path")}
       GROUP BY e.dst`,
    )
    .all(...USE_KINDS, ...SYMBOL_KINDS, ...range)
    .map((row) => ({ id: row.id as string, dependents: row.c as number }));
  const graph = loadUseGraph(store);
  const rank = useScore(graph);
  const rankOf = (id: string) => rank[graph.index.get(id) ?? -1] ?? 0;
  const hubSymbols = used
    .sort((a, b) => rankOf(b.id) - rankOf(a.id) || b.dependents - a.dependents || a.id.localeCompare(b.id))
    .slice(0, 10)
    .flatMap(({ id, dependents }) => {
      const node = store.getNode(id);
      return node ? [{ node, dependents, reach: reachOf(graph, id, MAX_REACH) }] : [];
    });

  const externals = store
    .stmt(
      `SELECT ${N_COLUMNS}, COUNT(*) AS c FROM edges e JOIN nodes n ON n.id = e.dst
       WHERE e.kind = 'imports' AND n.kind = 'external'${where("e.origin_file")}
       GROUP BY e.dst ORDER BY c DESC, n.id LIMIT 10`,
    )
    .all(...range)
    .map((row) => ({ node: rowToNode(row), importers: row.c as number }));

  // Source files that import project code but that no non-test file imports.
  const entryPoints = store
    .stmt(
      `SELECT ${N_COLUMNS},
              (SELECT COUNT(*) FROM edges o WHERE o.src = n.id AND o.kind = 'imports') AS outs
       FROM nodes n
       WHERE n.kind = 'file' AND n.subkind = 'source'${where("n.path")}
         AND NOT EXISTS (
           SELECT 1 FROM edges i JOIN nodes s ON s.id = i.src
           WHERE i.dst = n.id AND i.kind = 'imports' AND s.subkind != 'test')
         AND EXISTS (
           SELECT 1 FROM edges o JOIN nodes t ON t.id = o.dst
           WHERE o.src = n.id AND o.kind = 'imports' AND t.kind = 'file')
       ORDER BY outs DESC, n.id LIMIT 8`,
    )
    .all(...range)
    .map((row) => ({ node: rowToNode(row), imports: row.outs as number }));

  const docs = store
    .stmt(
      `SELECT ${N_COLUMNS} FROM nodes n
       WHERE n.kind = 'file' AND n.subkind = 'doc'${where("n.path")}
       ORDER BY (n.name LIKE 'README%') DESC, LENGTH(n.path), n.path LIMIT 8`,
    )
    .all(...range)
    .map(rowToNode);

  return {
    scope,
    files: root.files,
    symbols: root.symbols,
    testFiles,
    languages: [...languages.entries()]
      .map(([language, files]) => ({ language, files }))
      .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
    tree: toSummaries(prefix, root),
    looseFiles,
    entryPoints,
    hubFiles,
    hubSymbols,
    externals,
    docs,
  };
}
