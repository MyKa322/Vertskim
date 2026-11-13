import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project } from "../project.js";
import type { EdgeKind } from "../types.js";

/** How the graph built from syntax alone compares with what a compiler index says. */
export interface EdgeAccuracy {
  index: string;
  tool: string;
  /** Files the index describes that are unchanged since it was built: the ones compared. */
  files: number;
  /** Calls linked by name alone (`~`), and what the compiler made of them. */
  guesses: { total: number; confirmed: number; contradicted: number; unknown: number };
  /** Calls linked through imports, types or scope: how many the compiler also has. */
  linked: { total: number; confirmed: number };
  /** Calls the compiler knows of, and how many syntax alone found, by any means. */
  compilerCalls: { total: number; found: number };
  /** Calls syntax alone missed, by how they are written. */
  missedBy: Record<string, number>;
  /** A few examples of each problem, for a person to look at. */
  examples: { contradicted: string[]; missed: string[]; unconfirmed: string[] };
}

export interface Question {
  /** What a person would ask, in their own words. */
  ask: string;
  /** Node ids that answer it; any one of them counts. */
  expect: string[];
}

export interface QuestionResult extends Question {
  /** 1-based rank of the first expected node in `graph_search`'s answer, or null when it is not there. */
  searchRank: number | null;
  /** True when one of `graph_context`'s starting points is an expected node. */
  contextSeed: boolean;
  /** 1-based rank among everything `graph_context` returned, or null. */
  contextRank: number | null;
}

export interface AnswerQuality {
  questions: QuestionResult[];
  /** Questions answered in the first five search results. */
  searchTop5: number;
  /** Mean of 1/rank over all questions, 0 for a miss. */
  searchMrr: number;
  contextSeeds: number;
  contextTop10: number;
  /** Whether search by meaning took part. */
  meaning: boolean;
  /** Expected ids that are not nodes of the graph at all: the question set needs updating. */
  unknownIds: string[];
}

const CALL_KINDS: EdgeKind[] = ["calls"];
const EXAMPLES = 8;

/** Sort a missed call into the way it is written in the source. */
function shapeOf(line: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = line.search(new RegExp(`\\b${escaped}\\s*(<[^>]*>)?\\s*\\(`));
  if (at < 0) return "other";
  const before = line.slice(0, at);
  if (/new\s+$/.test(before)) return "new X()";
  if (/(this|self)\.[\w$]+\??\.\s*$/.test(before)) return "this.field.method()";
  if (/(this|self)\.\s*$/.test(before)) return "this.method()";
  if (/[)\]]\??\.\s*$/.test(before)) return "f().method()";
  if (/[\w$]+\??\.\s*$/.test(before)) return "x.method()";
  return "f()";
}

function memberName(id: string): string {
  const hash = id.lastIndexOf("#");
  const qname = hash < 0 ? id : id.slice(hash + 1);
  return qname.split(".").pop()!.replace(/~\d+$/, "");
}

/**
 * Index a project twice over, once from syntax alone and once with a compiler
 * (SCIP) index, and report where the two disagree. Works in a temporary data
 * folder, so the project's own index and settings are left alone.
 */
export async function measureEdgeAccuracy(root: string, indexPath: string): Promise<EdgeAccuracy> {
  const dataDir = mkdtempSync(join(tmpdir(), "vertskim-accuracy-"));
  const project = Project.open({ root, dataDir });
  try {
    await project.sync();
    const key = (src: string, dst: string) => `${src}\u0000${dst}`;
    const before = new Map<string, { kind: EdgeKind; confidence: string; origin: string }>();
    for (const row of project.store.db
      .prepare("SELECT src, kind, dst, confidence, origin_file FROM edges WHERE kind = 'calls'")
      .all()) {
      before.set(key(row.src as string, row.dst as string), {
        kind: row.kind as EdgeKind,
        confidence: row.confidence as string,
        origin: row.origin_file as string,
      });
    }

    const status = await project.addCompilerIndex(indexPath);
    if (!status || status.documents === 0) throw new Error(`${indexPath} could not be read as a SCIP index`);
    const covered = new Set(
      project.store
        .scipFilesOf(status.path)
        .filter((path) => project.store.scipHashOf(path) === project.store.getFile(path)?.hash),
    );
    const after = new Map<string, string>();
    for (const row of project.store.db.prepare("SELECT src, dst, confidence FROM edges WHERE kind = 'calls'").all()) {
      after.set(key(row.src as string, row.dst as string), row.confidence as string);
    }

    const report: EdgeAccuracy = {
      index: status.path,
      tool: status.tool,
      files: covered.size,
      guesses: { total: 0, confirmed: 0, contradicted: 0, unknown: 0 },
      linked: { total: 0, confirmed: 0 },
      compilerCalls: { total: 0, found: 0 },
      missedBy: {},
      examples: { contradicted: [], missed: [], unconfirmed: [] },
    };

    const facts = new Set<string>();
    const lines = new Map<string, string[]>();
    const lineOf = (path: string, n: number): string => {
      let text = lines.get(path);
      if (!text) {
        try {
          text = readFileSync(join(project.root, path), "utf8").split(/\r?\n/);
        } catch {
          text = [];
        }
        lines.set(path, text);
      }
      return text[n - 1] ?? "";
    };
    for (const path of covered) {
      for (const fact of project.store.scipFactsOf(path)) {
        if (!CALL_KINDS.includes(fact.kind)) continue;
        const dstFile = fact.dst.includes("#") ? fact.dst.slice(0, fact.dst.indexOf("#")) : fact.dst;
        if (!covered.has(dstFile)) continue;
        const pair = key(fact.src, fact.dst);
        if (facts.has(pair)) continue;
        facts.add(pair);
        report.compilerCalls.total++;
        if (before.has(pair)) {
          report.compilerCalls.found++;
          continue;
        }
        const shape = shapeOf(lineOf(path, fact.line), memberName(fact.dst));
        report.missedBy[shape] = (report.missedBy[shape] ?? 0) + 1;
        if (report.examples.missed.length < EXAMPLES) {
          report.examples.missed.push(`${path}:${fact.line}  ${lineOf(path, fact.line).trim().slice(0, 100)}`);
        }
      }
    }

    for (const [pair, edge] of before) {
      if (!covered.has(edge.origin)) continue;
      const [src, dst] = pair.split("\u0000") as [string, string];
      const dstFile = dst.includes("#") ? dst.slice(0, dst.indexOf("#")) : dst;
      if (!covered.has(dstFile)) continue;
      if (edge.confidence === "heuristic") {
        report.guesses.total++;
        const now = after.get(pair);
        if (now === undefined) {
          report.guesses.contradicted++;
          if (report.examples.contradicted.length < EXAMPLES) report.examples.contradicted.push(`${src} -> ${dst}`);
        } else if (now === "exact") report.guesses.confirmed++;
        else report.guesses.unknown++;
      } else {
        report.linked.total++;
        if (facts.has(pair)) report.linked.confirmed++;
        else if (report.examples.unconfirmed.length < EXAMPLES) report.examples.unconfirmed.push(`${src} -> ${dst}`);
      }
    }
    return report;
  } finally {
    await project.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Read a question set: `{ "questions": [{ "ask": "...", "expect": ["id", ...] }] }`. */
export function readQuestions(path: string): Question[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { questions?: unknown };
  if (!Array.isArray(parsed.questions)) throw new Error(`${path}: expected an object with a "questions" list`);
  return parsed.questions.map((q, i) => {
    const item = q as { ask?: unknown; expect?: unknown };
    if (typeof item.ask !== "string" || !Array.isArray(item.expect) || item.expect.some((e) => typeof e !== "string")) {
      throw new Error(`${path}: question ${i + 1} needs "ask" (text) and "expect" (a list of node ids)`);
    }
    return { ask: item.ask, expect: item.expect as string[] };
  });
}

/**
 * Ask each question of `graph_search` and `graph_context` and see where the
 * expected answers land. Uses search by meaning when the project has it on.
 */
export async function measureAnswers(project: Project, questions: Question[]): Promise<AnswerQuality> {
  const results: QuestionResult[] = [];
  const unknownIds = new Set<string>();
  for (const question of questions) {
    for (const id of question.expect) if (!project.node(id)) unknownIds.add(id);
    const expected = new Set(question.expect);
    const search = await project.searchWithMeaning({ query: question.ask, limit: 20 });
    const searchIndex = search.hits.findIndex((hit) => expected.has(hit.node.id));
    const context = await project.contextWithMeaning({ task: question.ask, maxItems: 60 });
    const contextIndex = context.items.findIndex((item) => expected.has(item.node.id));
    results.push({
      ...question,
      searchRank: searchIndex < 0 ? null : searchIndex + 1,
      contextSeed: context.seeds.some((node) => expected.has(node.id)),
      contextRank: contextIndex < 0 ? null : contextIndex + 1,
    });
  }
  const count = (test: (r: QuestionResult) => boolean) => results.filter(test).length;
  return {
    questions: results,
    searchTop5: count((r) => r.searchRank !== null && r.searchRank <= 5),
    searchMrr:
      results.length === 0
        ? 0
        : results.reduce((sum, r) => sum + (r.searchRank ? 1 / r.searchRank : 0), 0) / results.length,
    contextSeeds: count((r) => r.contextSeed),
    contextTop10: count((r) => r.contextRank !== null && r.contextRank <= 10),
    meaning: project.embeddingStatus().embedded > 0,
    unknownIds: [...unknownIds],
  };
}
