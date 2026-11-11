import type { ColorBy, EdgeKind, NodeKind, ViewNode } from "./types";

export const BACKGROUND = "#0a0c11";
export const SELECTION = "#ffb454";
export const TRAIL = "#5eead4";
export const FRESH = "#f5f7fb";
export const LABEL = "#d5dbe8";

/** One hue per kind of thing, chosen to stay distinct on a dark ground. */
export const KIND_COLORS: Record<NodeKind, string> = {
  directory: "#7f8ca8",
  file: "#c7cfe0",
  external: "#8a8f99",
  class: "#f2a65a",
  interface: "#e6cf6a",
  function: "#6cb6ff",
  method: "#4fd1d9",
  variable: "#b9a3f5",
  type: "#f08fb8",
  section: "#8fd18f",
};

export const KIND_LABELS: Record<NodeKind, string> = {
  directory: "Directories",
  file: "Files",
  external: "External modules",
  class: "Classes",
  interface: "Interfaces",
  function: "Functions",
  method: "Methods",
  variable: "Variables",
  type: "Types",
  section: "Doc sections",
};

export const KIND_ORDER: NodeKind[] = [
  "directory",
  "file",
  "class",
  "interface",
  "function",
  "method",
  "variable",
  "type",
  "section",
  "external",
];

export const EDGE_COLORS: Record<EdgeKind, string> = {
  contains: "#3a4357",
  imports: "#7385a8",
  calls: "#6cb6ff",
  references: "#9aa5bb",
  extends: "#f2a65a",
  implements: "#e6cf6a",
  tests: "#8fd18f",
  mentions: "#c79bf2",
  links_to: "#c79bf2",
};

export const EDGE_LABELS: Record<EdgeKind, string> = {
  contains: "Contains",
  imports: "Imports",
  calls: "Calls",
  references: "References",
  extends: "Extends",
  implements: "Implements",
  tests: "Tests",
  mentions: "Mentions",
  links_to: "Links to",
};

export const EDGE_ORDER: EdgeKind[] = [
  "contains",
  "imports",
  "calls",
  "references",
  "extends",
  "implements",
  "tests",
  "mentions",
  "links_to",
];

/** Phrases for the details panel: how a relationship reads from each end. */
export const EDGE_PHRASES: Record<EdgeKind, { out: string; in: string }> = {
  contains: { out: "Contains", in: "Inside" },
  imports: { out: "Imports", in: "Imported by" },
  calls: { out: "Calls", in: "Called by" },
  references: { out: "Refers to", in: "Referred to by" },
  extends: { out: "Extends", in: "Extended by" },
  implements: { out: "Implements", in: "Implemented by" },
  tests: { out: "Tests", in: "Tested by" },
  mentions: { out: "Mentions", in: "Mentioned in" },
  links_to: { out: "Links to", in: "Linked from" },
};

const FOLDER_PALETTE = [
  "#6cb6ff",
  "#f2a65a",
  "#8fd18f",
  "#f08fb8",
  "#b9a3f5",
  "#e6cf6a",
  "#4fd1d9",
  "#ff8f7a",
  "#a8c66c",
  "#d19bd8",
];

/** Stable colour for each top-level area, in order of first appearance. */
export function folderColors(nodes: ViewNode[]): Map<string, string> {
  const groups = [...new Set(nodes.map((n) => n.group))].sort();
  const colors = new Map<string, string>();
  groups.forEach((group, index) => {
    colors.set(group, group === "ext:" ? KIND_COLORS.external : FOLDER_PALETTE[index % FOLDER_PALETTE.length]!);
  });
  return colors;
}

export function colorOf(node: ViewNode, colorBy: ColorBy, folders: Map<string, string>): string {
  if (colorBy === "folder") return folders.get(node.group) ?? KIND_COLORS[node.kind];
  return KIND_COLORS[node.kind];
}

/** `#rrggbb` with an alpha, as the graph library accepts it. */
export function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** What a node is, in a word or two, for chips and tooltips. */
export function kindName(node: { kind: NodeKind; subkind?: string | null }): string {
  if (node.kind === "type" && node.subkind === "enum") return "enum";
  if (node.kind === "external") return node.subkind === "group" ? "external modules" : "external module";
  if (node.kind === "section") return "doc section";
  if (node.kind === "file" && node.subkind && node.subkind !== "source") return `${node.subkind} file`;
  return node.kind;
}
