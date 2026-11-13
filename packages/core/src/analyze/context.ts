import { search, sentenceWords } from "../query/search.js";
import { NODE_COLUMNS, rowToNode, type GraphStore } from "../store/store.js";
import type { Confidence, EdgeKind, GraphNode } from "../types.js";
import { SYMBOL_KINDS } from "./common.js";

export interface ContextOptions {
  /** What the caller is trying to do, in plain words. */
  task?: string;
  /** Node ids to start from. */
  seeds?: string[];
  /** Further starting points found some other way (by meaning), each with how much to trust it, 0 to 1. */
  extraSeeds?: { id: string; weight: number }[];
  maxItems?: number;
}

export interface ContextItem {
  node: GraphNode;
  /** Relevance, highest first. Seeds score around 1. */
  score: number;
  seed: boolean;
}

export interface ContextResult {
  seeds: GraphNode[];
  /** Seed ids that matched no node. */
  missingSeeds: string[];
  items: ContextItem[];
  /** True when the starting points match only some words of the task: the result is a broad guess. */
  weakStart: boolean;
}

/** How much relevance survives one hop, by relationship and direction. */
const DECAY: Record<EdgeKind, { out: number; in: number }> = {
  calls: { out: 0.55, in: 0.4 },
  references: { out: 0.3, in: 0.15 },
  extends: { out: 0.5, in: 0.4 },
  implements: { out: 0.5, in: 0.4 },
  contains: { out: 0.35, in: 0.3 },
  imports: { out: 0.15, in: 0.1 },
  tests: { out: 0.4, in: 0.3 },
  mentions: { out: 0.5, in: 0.25 },
  links_to: { out: 0.3, in: 0.15 },
};
const HEURISTIC_FACTOR = 0.6;
/** A node needs at least this much relevance to pass any on. */
const SPREAD_THRESHOLD = 0.12;
const ROUNDS = 2;
const EDGES_PER_NODE = 40;
/** Above this many dependents a node is shared infrastructure, and says little about any one caller. */
const HUB_FAN_IN = 8;
/** A node reached from several directions counts its strongest link in full and the rest at this rate. */
const EXTRA_LINK_FACTOR = 0.3;
/** Nodes scoring below this share of the best score are left out, however much room there is. */
const RELEVANCE_FLOOR = 0.12;
const MAX_TEXT_SEEDS = 6;

const STOPWORDS = new Set(
  (
    "a an the and or but if then else when where while how what why which who this that these those it its is are " +
    "was were be been being do does did done has have had can could should would will may might must not no yes " +
    "of in on at to for from by with without into onto over under about as so than too very just also only " +
    "i we you they he she me my our your their us them fix fixing bug issue error problem add adding implement " +
    "make making change changing need needs want wants please get gets use uses using work works working"
  ).split(" "),
);

function looksLikeIdentifier(token: string): boolean {
  return /[a-z0-9][A-Z]/.test(token) || token.includes("_") || /\w[.#/]\w/.test(token);
}

/** Split a task description into things that look like names and ordinary words. */
function parseTask(task: string): { identifiers: string[]; words: string[] } {
  const identifiers = new Set<string>();
  const words = new Set<string>();
  for (const match of task.matchAll(/`([^`\n]+)`/g)) identifiers.add(match[1]!.trim().replace(/\(.*\)$/, ""));
  for (const raw of task.replace(/`/g, " ").match(/[\p{L}\p{N}_$.#/\\-]+/gu) ?? []) {
    const token = raw.replace(/^[.#/\\-]+|[.#/\\-]+$/g, "");
    if (token === "") continue;
    if (looksLikeIdentifier(token)) identifiers.add(token);
    for (const part of token.split(/[^\p{L}\p{N}]+/u)) {
      const word = part.toLowerCase();
      if (word.length >= 3 && !STOPWORDS.has(word)) words.add(word);
    }
  }
  return { identifiers: [...identifiers], words: [...words] };
}

/**
 * Pick the nodes most relevant to a task: find starting points, then let
 * relevance spread along relationships, losing strength with each hop.
 */
export function buildContext(
  store: GraphStore,
  lookup: (id: string) => GraphNode | null,
  options: ContextOptions,
): ContextResult {
  const maxItems = Math.min(Math.max(options.maxItems ?? 60, 1), 200);
  const seedWeights = new Map<string, { node: GraphNode; weight: number }>();
  const addSeed = (node: GraphNode, weight: number) => {
    if (node.kind === "directory" || node.kind === "external") return;
    const existing = seedWeights.get(node.id);
    if (!existing || existing.weight < weight) seedWeights.set(node.id, { node, weight });
  };

  const missingSeeds: string[] = [];
  /** Whether any starting point is better than a partial match on words. */
  let strong = false;
  let strongText = false;
  for (const id of options.seeds ?? []) {
    const node = lookup(id);
    if (node) {
      addSeed(node, 1);
      strong = true;
    } else missingSeeds.push(id);
  }

  if (options.task) {
    const { identifiers, words } = parseTask(options.task);
    for (const identifier of identifiers) {
      const exact = lookup(identifier);
      if (exact) {
        addSeed(exact, 1);
        strong = true;
        continue;
      }
      const segments = identifier.split(/[.#:]+/).filter(Boolean);
      const name = segments[segments.length - 1];
      if (!name) continue;
      let named = store.nodesNamed(name).filter((n) => (SYMBOL_KINDS as readonly string[]).includes(n.kind));
      if (segments.length > 1) {
        const qualified = `${segments[segments.length - 2]}.${name}`;
        const narrowed = named.filter((n) => n.id.endsWith(`#${qualified}`) || n.id.endsWith(`.${qualified}`));
        if (narrowed.length > 0) named = narrowed;
      }
      if (named.length <= 4) {
        for (const node of named) addSeed(node, 0.9);
        if (named.length > 0) strong = true;
      }
    }
    if (words.length > 0) {
      const query = words.join(" ");
      const { hits } = search(store, { query, limit: MAX_TEXT_SEEDS });
      const meaningful = sentenceWords(query);
      const top = hits[0]?.score ?? 0;
      for (const hit of hits) {
        if (top <= 0) break;
        // Squared, so a hit half as good as the best starts with much less than half its weight.
        const relative = Math.max(hit.score / top, 0);
        // And scaled by how much of the task it matches: one word of eight is little to go on.
        const coverage = meaningful && hit.matched !== undefined ? hit.matched / meaningful.length : 1;
        addSeed(hit.node, (0.25 + 0.6 * relative * relative) * (0.5 + 0.5 * coverage));
        if (coverage >= 0.5) strongText = true;
      }
    }
  }

  for (const extra of options.extraSeeds ?? []) {
    const node = lookup(extra.id);
    if (node) addSeed(node, Math.min(Math.max(extra.weight, 0), 1));
    if (node && extra.weight >= 0.5) strong = true;
  }

  const seeds = [...seedWeights.values()].sort((a, b) => b.weight - a.weight).slice(0, 10);
  const scores = new Map<string, { node: GraphNode; score: number }>();
  for (const seed of seeds) scores.set(seed.node.id, { node: seed.node, score: seed.weight });

  const nColumns = NODE_COLUMNS.split(", ")
    .map((c) => `n.${c} AS ${c}`)
    .join(", ");
  const outStmt = store.stmt(
    `SELECT ${nColumns}, e.kind AS e_kind, e.confidence AS e_confidence
     FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? ORDER BY e.weight DESC LIMIT ${EDGES_PER_NODE}`,
  );
  const inStmt = store.stmt(
    `SELECT ${nColumns}, e.kind AS e_kind, e.confidence AS e_confidence
     FROM edges e JOIN nodes n ON n.id = e.src WHERE e.dst = ? ORDER BY e.weight DESC LIMIT ${EDGES_PER_NODE}`,
  );
  const fanInStmt = store.stmt("SELECT COUNT(*) AS c FROM edges WHERE dst = ? AND kind != 'contains'");
  const fanIns = new Map<string, number>();
  const fanIn = (id: string): number => {
    let value = fanIns.get(id);
    if (value === undefined) {
      value = Number(fanInStmt.get(id)?.c ?? 0);
      fanIns.set(id, value);
    }
    return value;
  };

  const seedIds = new Set(seeds.map((s) => s.node.id));
  let active = new Map<string, number>(seeds.map((s) => [s.node.id, s.weight]));
  for (let round = 0; round < ROUNDS && active.size > 0; round++) {
    const gained = new Map<string, number>();
    const strongest = new Map<string, number>();
    for (const [id, strength] of active) {
      if (strength < SPREAD_THRESHOLD) continue;
      const source = scores.get(id)!.node;
      for (const direction of ["out", "in"] as const) {
        const rows = (direction === "out" ? outStmt : inStmt).all(id);
        for (const row of rows) {
          const kind = row.e_kind as EdgeKind;
          const other = rowToNode(row);
          if (other.kind === "directory" || other.kind === "external") continue;
          let factor = DECAY[kind][direction];
          if (kind === "contains") {
            if (direction === "out") {
              // Members of a class or section are relevant; the contents of a file only if it was asked for.
              const expands =
                source.kind === "class" || source.kind === "interface" || source.kind === "section" || seedIds.has(id);
              if (!expands) continue;
            } else if (other.kind === "file") {
              factor = 0.15;
            }
          } else if (direction === "out") {
            const dependents = fanIn(other.id);
            if (dependents > HUB_FAN_IN) factor *= Math.sqrt(HUB_FAN_IN / dependents);
          }
          if ((row.e_confidence as Confidence) === "heuristic") factor *= HEURISTIC_FACTOR;
          const amount = strength * factor;
          if (amount < 0.02) continue;
          gained.set(other.id, (gained.get(other.id) ?? 0) + amount);
          strongest.set(other.id, Math.max(strongest.get(other.id) ?? 0, amount));
          if (!scores.has(other.id)) scores.set(other.id, { node: other, score: 0 });
        }
      }
    }
    for (const [id, sum] of gained) {
      const best = strongest.get(id)!;
      const amount = best + EXTRA_LINK_FACTOR * (sum - best);
      gained.set(id, amount);
      scores.get(id)!.score += amount;
    }
    active = gained;
  }

  const ranked = [...scores.values()]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const floor = (ranked[0]?.score ?? 0) * RELEVANCE_FLOOR;
  const items = ranked
    .filter((entry) => entry.score >= floor || seedIds.has(entry.node.id))
    .slice(0, maxItems)
    .map((entry) => ({ node: entry.node, score: entry.score, seed: seedIds.has(entry.node.id) }));
  return {
    seeds: seeds.map((s) => s.node),
    missingSeeds,
    items,
    weakStart: seeds.length > 0 && !strong && !strongText,
  };
}
