import type { GraphNode, NoteView, Project } from "@vertskim/core";

/**
 * Rough token count. Code averages fewer characters per token than prose, so
 * this errs on the side of overestimating and staying inside the budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** Collects output lines until a token budget is spent. */
export class Budget {
  private readonly blocks: string[] = [];
  private used = 0;

  constructor(readonly maxTokens: number) {}

  get remaining(): number {
    return Math.max(this.maxTokens - this.used, 0);
  }

  /** Add a block if it fits. Returns false, adding nothing, when it does not. */
  add(block: string): boolean {
    const cost = estimateTokens(block) + 1;
    if (this.used + cost > this.maxTokens) return false;
    this.push(block);
    return true;
  }

  /** Add a block regardless of the budget: headers, truncation notices, the status line. */
  push(block: string): void {
    this.blocks.push(block);
    this.used += estimateTokens(block) + 1;
  }

  toString(): string {
    return this.blocks.join("\n");
  }
}

const LANGUAGE_SHORT: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  markdown: "md",
  csharp: "c#",
  rust: "rs",
};

export function lineRange(node: GraphNode): string {
  if (!node.startLine) return "";
  return !node.endLine || node.endLine === node.startLine ? `L${node.startLine}` : `L${node.startLine}-${node.endLine}`;
}

export function kindLabel(node: GraphNode): string {
  if (node.kind === "type" && node.subkind === "enum") return "enum";
  if (node.kind === "section") return "section";
  if ((node.kind === "file" || node.kind === "external") && node.subkind) return `${node.kind}:${node.subkind}`;
  return node.kind;
}

/** `kind · lang · L10-20 · exported` */
export function facts(node: GraphNode, extra: string[] = []): string {
  const parts = [kindLabel(node)];
  if (node.language && node.kind !== "section") parts.push(LANGUAGE_SHORT[node.language] ?? node.language);
  const range = lineRange(node);
  if (range && node.kind !== "file") parts.push(range);
  if (node.kind === "file" && node.endLine) parts.push(`${node.endLine} lines`);
  if (node.exported > 0) parts.push(node.exported === 2 ? "default export" : "exported");
  parts.push(...extra);
  return parts.join(" · ");
}

/** `note #3 (2026-11-11 · claude-code): text`, flagged when the code it describes has moved on. */
export function noteLine(note: NoteView, withNode = false): string {
  const parts = [new Date(note.createdAt).toISOString().slice(0, 10)];
  if (note.author) parts.push(note.author);
  if (note.orphaned) parts.push("its node no longer exists");
  else if (note.stale) parts.push("written before this code last changed");
  const where = withNode ? ` on ${note.nodeId}` : "";
  return `note #${note.id}${where} (${parts.join(" · ")}): ${note.text.replace(/\s*\n\s*/g, " ")}`;
}

/** Mark a name-only match so the model knows to verify it. */
export function mark(confidence: string): string {
  return confidence === "heuristic" ? "~" : "";
}

/** One line describing how current the answer is. */
export function statusLine(project: Project): string {
  const status = project.status();
  if (status.error) return `index: last sync failed (${status.error}); results may be stale`;
  if (status.state === "indexing") {
    return `index: indexing ${Math.round(status.progress * 100)}%, results may be incomplete; ask again shortly`;
  }
  const note = status.truncated ? ", file limit reached so some files are not indexed" : "";
  return `index: fresh (${status.files} files, ${status.nodes} nodes${note})`;
}

/** Prefix every line with its line number: `42| code`. */
export function numberLines(text: string, startLine: number): string {
  const lines = text.split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}| ${line}`).join("\n");
}

/** `kind · L10-20`, the short form used in lists of related nodes. */
export function briefFacts(node: GraphNode): string {
  const parts = [kindLabel(node)];
  const range = lineRange(node);
  if (range && node.kind !== "file") parts.push(range);
  return parts.join(" · ");
}

/** Source text with a line-number gutter, cut to fit the remaining budget. */
export function sourceBlock(text: string, startLine: number, budget: Budget, path: string): void {
  const lines = text.split("\n");
  const endLine = startLine + lines.length - 1;
  const width = String(endLine).length;
  const reserve = 30; // room for the truncation notice
  let shown = 0;
  const out: string[] = [];
  let cost = 0;
  for (const line of lines) {
    const rendered = `${String(startLine + shown).padStart(width)}| ${line}`;
    cost += estimateTokens(rendered) + 1;
    if (cost > budget.remaining - reserve && shown > 0) break;
    out.push(rendered);
    shown++;
  }
  budget.push(out.join("\n"));
  if (shown < lines.length) {
    budget.push(
      `… ${lines.length - shown} more lines not shown (raise max_tokens, or read ${path} from line ${startLine + shown})`,
    );
  }
}
