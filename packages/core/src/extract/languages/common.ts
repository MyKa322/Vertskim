import type { Node } from "@vscode/tree-sitter-wasm";
import { tidySignature, truncate } from "../../util.js";
import type { DocInfo, RawDef } from "../spec.js";

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

export function fieldIs(parent: Node, field: string, node: Node): boolean {
  return parent.childForFieldName(field)?.id === node.id;
}

/** Nearest ancestor of one of the given types. */
export function ancestor(node: Node, types: Set<string> | string): Node | null {
  for (let a = node.parent; a; a = a.parent) {
    if (typeof types === "string" ? a.type === types : types.has(a.type)) return a;
  }
  return null;
}

/** First sentence-or-so of a comment, without its markers. */
export function cleanComment(raw: string): string | null {
  const out: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine
      .trim()
      .replace(/^\/\*+!?/, "")
      .replace(/\*+\/$/, "")
      .replace(/^\*+ ?/, "")
      .replace(/^\/\/+!? ?/, "")
      .replace(/^#+!? ?/, "")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "") // XML doc tags (C#) and stray HTML (Javadoc)
      .trim();
    if (line.startsWith("@")) break;
    if (line === "") {
      if (out.length > 0) break;
      continue;
    }
    out.push(line);
  }
  const text = out.join(" ");
  if (text === "" || /^(eslint|prettier|istanbul|c8|@ts-|biome|nolint|go:|clippy|noinspection|pragma)/.test(text)) {
    return null;
  }
  return truncate(text, 200);
}

/**
 * The comment written directly above a definition. Line comments are joined
 * while they stay adjacent; a block comment stands alone. Sibling nodes of the
 * `skip` types (attributes, annotations) may sit in between. `clean` turns the
 * comment's text into the doc line, for languages whose markers {@link cleanComment}
 * does not know.
 */
export function commentAbove(
  outer: Node,
  skip: Set<string> = new Set(),
  clean: (raw: string) => string | null = cleanComment,
): DocInfo {
  const comments: Node[] = [];
  let expectedRow = outer.startPosition.row;
  let prev = outer.previousNamedSibling;
  while (prev) {
    if (skip.has(prev.type)) {
      expectedRow = prev.startPosition.row;
      prev = prev.previousNamedSibling;
      continue;
    }
    if (!COMMENT_TYPES.has(prev.type) || prev.endPosition.row < expectedRow - 1) break;
    comments.unshift(prev);
    if (prev.text.startsWith("/*")) break;
    expectedRow = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  const first = comments[0];
  if (!first) return { text: null };
  const text = clean(comments.map((c) => c.text).join("\n"));
  return text ? { text, startLine: first.startPosition.row + 1 } : { text: null };
}

/**
 * A definition's text up to where its body starts, on one line. With no body
 * (a constant, a prototype) the whole definition is used, cut short.
 */
export function signatureBeforeBody(def: RawDef, source: string, bodyFields: string[] = ["body"]): string | null {
  const node = def.node;
  const start = node.startIndex;
  let end = node.endIndex;
  let hasBody = false;
  for (const field of bodyFields) {
    const body = node.childForFieldName(field);
    if (body && body.startIndex > start) {
      end = body.startIndex;
      hasBody = true;
      break;
    }
  }
  const text = tidySignature(source.slice(start, end))
    .replace(/(\{|;|,|=>|=|where)$/, "")
    .trim();
  return text ? truncate(text, hasBody ? 240 : 160) : null;
}

/** Text of a string literal without its quotes. */
export function unquote(text: string): string {
  return text.length >= 2 && /^['"`]/.test(text) ? text.slice(1, -1) : text;
}
