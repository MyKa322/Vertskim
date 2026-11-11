import type { Extraction, GraphNode, RawRef, RefKind } from "../types.js";
import { collapseWhitespace, truncate } from "../util.js";

interface Section {
  node: GraphNode;
  level: number;
  hasDoc: boolean;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g;
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/;
const CODE_SPAN = /`([^`\n]+)`/g;

/** GitHub-style heading anchor. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Strip inline markdown so headings read as plain text. */
function plainText(text: string): string {
  return collapseWhitespace(
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*~]/g, "")
      // underscores are emphasis only at word edges; inside identifiers they stay
      .replace(/(^|[\s(])_+(?=\S)/g, "$1")
      .replace(/(\S)_+(?=$|[\s).,;:!?])/g, "$1"),
  );
}

/** A code span worth resolving: a path or an identifier, not a shell command or a literal. */
function mentionCandidate(span: string): { name: string; full: string } | null {
  const text = span
    .trim()
    .replace(/\(.*\)$/, "")
    .replace(/^[.]\//, "");
  if (text.length < 3 || text.length > 120 || /\s/.test(text)) return null;
  if (!/^[\p{L}\p{N}_$@./\\#:-]+$/u.test(text) || !/[\p{L}]/u.test(text)) return null;
  const segments = text.split(/[.#:/\\]+/).filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  return { name: last, full: text };
}

/**
 * Extract sections, links and code mentions from a Markdown document.
 * Section ids use GitHub anchors, so `[x](guide.md#install)` resolves to the
 * node `guide.md#install` directly.
 */
export function extractMarkdown(path: string, source: string): Extraction {
  const lines = source.split(/\r?\n/);
  const nodes: GraphNode[] = [];
  const refs = new Map<string, RawRef>();
  const stack: Section[] = [];
  const slugCounts = new Map<string, number>();
  let inFence = false;
  let fileDoc: string | null = null;

  const current = (): string => stack[stack.length - 1]?.node.id ?? path;
  const addRef = (kind: RefKind, name: string, qualifier: string | null, line: number) => {
    const src = current();
    const key = `${src}\u0000${kind}\u0000${qualifier ?? ""}\u0000${name}`;
    const existing = refs.get(key);
    if (existing) existing.count++;
    else refs.set(key, { src, kind, name, qualifier, line, count: 1 });
  };
  const closeSections = (level: number, endLine: number) => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
      stack.pop()!.node.endLine = endLine;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = plainText(heading[2]!);
      if (title === "") continue;
      closeSections(level, lineNo - 1);
      const base = slugify(title) || "section";
      const seen = slugCounts.get(base) ?? 0;
      slugCounts.set(base, seen + 1);
      const slug = seen === 0 ? base : `${base}-${seen}`;
      const node: GraphNode = {
        id: `${path}#${slug}`,
        kind: "section",
        subkind: `h${level}`,
        name: title,
        path,
        parent: current(),
        startLine: lineNo,
        endLine: lines.length,
        language: "markdown",
        signature: `${"#".repeat(level)} ${title}`,
        doc: null,
        exported: 0,
      };
      nodes.push(node);
      stack.push({ node, level, hasDoc: false });
      if (level === 1 && fileDoc === null) fileDoc = title;
      continue;
    }

    const trimmed = line.trim();
    const section = stack[stack.length - 1];
    if (trimmed !== "" && !/^([-*_=]{3,}|<!--)/.test(trimmed)) {
      const summary = truncate(plainText(trimmed.replace(/^([-*+>]|\d+\.)\s+/, "")), 160);
      if (section && !section.hasDoc && summary) {
        section.node.doc = summary;
        section.hasDoc = true;
      }
      if (!section && fileDoc === null && summary) fileDoc = summary;
    }

    const definition = LINK_DEFINITION.exec(line);
    if (definition) addRef("links_to", definition[1]!, null, lineNo);
    for (const match of line.matchAll(LINK)) addRef("links_to", match[1]!, null, lineNo);
    for (const match of line.matchAll(CODE_SPAN)) {
      const candidate = mentionCandidate(match[1]!);
      if (candidate) addRef("mentions", candidate.name, candidate.full, lineNo);
    }
  }
  closeSections(0, lines.length);

  return { nodes, refs: [...refs.values()], imports: [], fileDoc };
}
