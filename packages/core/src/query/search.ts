import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import type { GraphNode, NodeKind } from "../types.js";
import { splitIdentifier, toPosix } from "../util.js";

export interface SearchOptions {
  query: string;
  kinds?: NodeKind[];
  /** Directory prefix or glob (`src/auth`, `src/**`, `*.test.ts`). */
  path?: string;
  limit?: number;
  /**
   * `all` (default): every word must match, loosening to any word only when
   * nothing does. `any`: rank by how many words match; for free-form text.
   */
  match?: "all" | "any";
}

export interface SearchHit {
  node: GraphNode;
  /** Relevance, highest first. Comparable only within one result. */
  score: number;
  /** Number of non-structural edges pointing at the node. */
  fanIn: number;
  /** True when the node was found by what its text means, and matches none of the query's words by name. */
  byMeaning?: boolean;
}

/** A node the embedding model considers close to the query. */
export interface MeaningCandidate {
  id: string;
  /** How far above the typical node its similarity is, in standard deviations. */
  lift: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when nothing matched every word and the hits match only some of them. */
  partial: boolean;
}

const N_COLUMNS = NODE_COLUMNS.split(", ")
  .map((c) => `n.${c} AS ${c}`)
  .join(", ");

const KIND_BONUS: Record<string, number> = {
  class: 2,
  interface: 2,
  function: 2,
  method: 2,
  type: 2,
  file: 1,
  variable: 0.5,
  section: 0.5,
  directory: 0,
  external: -1,
};

/** Turn a user-supplied path filter into a SQLite GLOB pattern. */
export function pathGlob(input: string): string {
  let pattern = toPosix(input.trim()).replace(/^\.\//, "");
  if (!/[*?]/.test(pattern)) {
    // A plain path means "this file or anything under this directory".
    return `${pattern.replace(/[[\]]/g, "[$&]").replace(/\/$/, "")}*`;
  }
  pattern = pattern.replace(/\*\*\/?/g, "*");
  // A pattern with no directory part matches at any depth.
  return pattern.includes("/") ? pattern : `*${pattern}`;
}

function ftsTerm(word: string): string {
  const lower = word.toLowerCase();
  const parts = splitIdentifier(word);
  if (parts.length > 1) return `("${lower}"* OR (${parts.map((p) => `"${p}"*`).join(" AND ")}))`;
  return `"${lower}"*`;
}

function isTestNode(node: GraphNode): boolean {
  return node.subkind === "test" || /(^|\/)(tests?|__tests__)\//.test(node.path) || /\.(test|spec)\./.test(node.path);
}

function filtersFor(options: SearchOptions): { sql: string; params: string[] } {
  const filters: string[] = [];
  const params: string[] = [];
  if (options.kinds && options.kinds.length > 0) {
    filters.push(`n.kind IN (${options.kinds.map(() => "?").join(", ")})`);
    params.push(...options.kinds);
  }
  if (options.path) {
    filters.push("n.path GLOB ?");
    params.push(pathGlob(options.path));
  }
  return { sql: filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "", params };
}

/** A candidate has to stand at least this far above the typical node to count as related at all. */
const MIN_LIFT = 1.5;
/** ...and come within this share of the best candidate's lead. */
const LIFT_SHARE = 0.6;
/** Rank fusion constant: small, because the lists are short and their first places matter most. */
const FUSION_K = 10;

/** The candidates worth showing: clearly above the crowd, and not far behind the best of them. */
export function closeInMeaning<T extends MeaningCandidate>(candidates: T[]): T[] {
  const top = candidates[0]?.lift ?? 0;
  const floor = Math.max(MIN_LIFT, top * LIFT_SHARE);
  return candidates.filter((c) => c.lift >= floor);
}

/**
 * Combine matches by name with matches by meaning. A node both lists agree on
 * rises; one that only the model found is kept, marked as such, so a question
 * asked in different words than the code uses still lands.
 */
export function mergeByMeaning(
  store: GraphStore,
  options: SearchOptions,
  byName: SearchResult,
  candidates: MeaningCandidate[],
): SearchResult {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const close = closeInMeaning(candidates).slice(0, limit * 2);
  if (close.length === 0) return { hits: byName.hits.slice(0, limit), partial: byName.partial };

  const { sql, params } = filtersFor(options);
  const nodes = new Map<string, GraphNode>();
  for (let i = 0; i < close.length; i += 200) {
    const chunk = close.slice(i, i + 200);
    const rows = store.db
      .prepare(`SELECT ${N_COLUMNS} FROM nodes n WHERE n.id IN (${chunk.map(() => "?").join(", ")})${sql}`)
      .all(...chunk.map((c) => c.id), ...params);
    for (const row of rows) {
      const node = rowToNode(row);
      nodes.set(node.id, node);
    }
  }

  // A match on only some of the words is weaker evidence than a match by meaning.
  const nameWeight = byName.partial ? 0.6 : 1;
  const fused = new Map<string, { hit: SearchHit; score: number }>();
  byName.hits.forEach((hit, rank) => {
    fused.set(hit.node.id, { hit, score: nameWeight / (FUSION_K + rank + 1) });
  });
  const fanInStmt = store.stmt("SELECT COUNT(*) AS c FROM edges WHERE dst = ? AND kind != 'contains'");
  let rank = 0;
  for (const candidate of close) {
    const node = nodes.get(candidate.id);
    if (!node) continue; // filtered out, or gone since it was embedded
    const amount = (isTestNode(node) ? 0.7 : 0.9) / (FUSION_K + ++rank);
    const existing = fused.get(node.id);
    if (existing) existing.score += amount;
    else {
      const fanIn = Number(fanInStmt.get(node.id)?.c ?? 0);
      fused.set(node.id, { hit: { node, score: 0, fanIn, byMeaning: true }, score: amount });
    }
  }
  const hits = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.hit.node.id.localeCompare(b.hit.node.id))
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score }));
  // With something found by meaning, "only some words matched" is no longer the whole story.
  return { hits, partial: byName.partial && !hits.some((hit) => hit.byMeaning) };
}

/**
 * Find nodes by name, keyword or description. Full-text search over names,
 * split identifier words, paths, signatures and doc text, then re-ranked so
 * exact names, exported symbols and heavily used nodes come first.
 */
export function search(store: GraphStore, options: SearchOptions): SearchResult {
  const query = options.query.trim();
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  if (query === "") return { hits: [], partial: false };
  let partial = false;

  const { sql: filterSql, params: filterParams } = filtersFor(options);

  const found = new Map<string, { node: GraphNode; base: number }>();
  const add = (row: Record<string, unknown>, base: number) => {
    const node = rowToNode(row);
    const existing = found.get(node.id);
    if (!existing || existing.base < base) found.set(node.id, { node, base });
  };

  // Id or path fragments: `src/auth/session.ts`, `session.ts#refresh`.
  const idQuery = toPosix(query).replace(/^\.\//, "");
  if (/[/#.]/.test(idQuery)) {
    const like = `%${idQuery.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = store.db
      .prepare(`SELECT ${N_COLUMNS} FROM nodes n WHERE n.id LIKE ? ESCAPE '\\'${filterSql} LIMIT 40`)
      .all(like, ...filterParams);
    for (const row of rows) {
      const id = row.id as string;
      // A path fragment most likely names the file or directory it ends with, not a symbol inside it.
      const tail = id === idQuery || id.endsWith(`/${idQuery}`) || id.endsWith(`/${idQuery}/`);
      add(row, id === idQuery ? 40 : tail ? 25 : 6);
    }
  }

  const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (words.length > 0) {
    const runFts = (expr: string) => {
      const rows = store.db
        .prepare(
          `SELECT ${N_COLUMNS}, bm25(nodes_fts, 10.0, 6.0, 4.0, 2.0, 1.0, 1.5) AS rank
           FROM nodes_fts JOIN nodes n ON n.nid = nodes_fts.rowid
           WHERE nodes_fts MATCH ?${filterSql}
           ORDER BY rank LIMIT 80`,
        )
        .all(expr, ...filterParams);
      for (const row of rows) add(row, -(row.rank as number));
    };
    const terms = words.map(ftsTerm);
    if (options.match === "any") {
      runFts(terms.join(" OR "));
    } else {
      runFts(terms.join(" AND "));
      // Only loosen to "any word" when "all words" found nothing at all.
      if (found.size === 0 && terms.length > 1) {
        runFts(terms.join(" OR "));
        partial = found.size > 0;
      }
    }
  }

  const lowered = query.toLowerCase();
  const fanInStmt = store.stmt("SELECT COUNT(*) AS c FROM edges WHERE dst = ? AND kind != 'contains'");
  const hits: SearchHit[] = [];
  for (const { node, base } of found.values()) {
    const fanIn = Number(fanInStmt.get(node.id)?.c ?? 0);
    const name = node.name.toLowerCase();
    const hash = node.id.indexOf("#");
    const qname = hash < 0 ? name : node.id.slice(hash + 1).toLowerCase();
    let score = base + (KIND_BONUS[node.kind] ?? 0) + Math.log2(1 + fanIn) * 0.8;
    if (name === lowered) score += 12;
    else if (name.startsWith(lowered)) score += 4;
    if (qname === lowered && qname !== name) score += 14;
    if (node.exported > 0) score += 1.5;
    if (isTestNode(node)) score -= 1.5;
    hits.push({ node, score, fanIn });
  }
  hits.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return { hits: hits.slice(0, limit), partial };
}
