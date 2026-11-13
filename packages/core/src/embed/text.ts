import type { GraphNode } from "../types.js";
import { splitIdentifier } from "../util.js";

/** Kinds of node that get a vector. Variables are left out: there are too many and their names say it all. */
export const EMBEDDED_KINDS = ["function", "method", "class", "interface", "type", "section", "file"] as const;

/** Most small embedding models read about 500 tokens; staying well under it means nothing is cut off unseen. */
const MAX_CHARS = 1200;
const MAX_MEMBERS = 24;
/**
 * Lines of the body to include. A description says more than code, so it goes first and a
 * documented symbol needs fewer lines of code. Of five recipes tried on `bench/questions.json`
 * with nomic-embed-text, this one put the most right answers among graph_context's starting points.
 */
const BODY_LINES_DOCUMENTED = 4;
const BODY_LINES_UNDOCUMENTED = 10;
const BODY_LINES_SECTION = 14;

/** Bump when the recipe below changes, so vectors made from the old texts are remade. */
export const TEXT_VERSION = 2;

const COMMENT_LINE = /^\s*(\/\*\*?|\*\/?|\/\/\/?|#|"""|''')/;

function qualifiedName(node: GraphNode): string {
  const hash = node.id.indexOf("#");
  return hash < 0 ? node.name : node.id.slice(hash + 1);
}

/**
 * What a node is, in the words a person would search with: its name spelled
 * out, where it lives, its signature and description, what it contains and
 * how it begins. `lines` are the lines of the node's file; `members` the names
 * of what it directly contains.
 */
export function embeddingText(node: GraphNode, lines: string[] | null, members: string[]): string {
  const parts: string[] = [];
  if (node.doc && node.kind !== "section") parts.push(node.doc);
  if (node.kind === "file") {
    parts.push(`file ${node.path}`);
  } else if (node.kind === "section") {
    parts.push(`${node.name}`, `section of ${node.path}`);
  } else {
    const qualified = qualifiedName(node);
    const words = splitIdentifier(qualified.replace(/\./g, "_")).join(" ");
    parts.push(
      `${node.subkind ?? node.kind} ${qualified}${words && words !== qualified.toLowerCase() ? ` (${words})` : ""}`,
    );
    parts.push(`in ${node.path}`);
  }
  if (node.signature && node.kind !== "section") parts.push(node.signature);
  if (node.doc && node.kind === "section") parts.push(node.doc);
  if (members.length > 0) {
    const shown = members.slice(0, MAX_MEMBERS);
    parts.push(`contains: ${shown.join(", ")}${members.length > shown.length ? ", …" : ""}`);
  }

  const maxBody =
    node.kind === "section" ? BODY_LINES_SECTION : node.doc ? BODY_LINES_DOCUMENTED : BODY_LINES_UNDOCUMENTED;
  if (lines && node.kind !== "file" && maxBody > 0) {
    const start = Math.max(node.startLine ?? 1, 1);
    const end = Math.min(node.endLine ?? start, lines.length);
    const body: string[] = [];
    let leading = true;
    // A section's first line is its heading, a symbol's is its signature: both are above already.
    for (let i = node.kind === "section" ? start : start - 1; i < end && body.length < maxBody; i++) {
      const line = (lines[i] ?? "").trimEnd();
      if (line.trim() === "") continue;
      if (leading && COMMENT_LINE.test(line)) continue; // the doc comment, already included as `doc`
      leading = false;
      body.push(line.trim().length > 160 ? `${line.trim().slice(0, 160)}…` : line.trim());
    }
    if (body.length > 0) parts.push(body.join("\n"));
  }

  const text = parts.join("\n");
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}
