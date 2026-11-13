import type { ColorBy, EdgeKind, NodeKind, ViewNode } from "./types";

const THEME_KEY = "vertskim-theme";

/** `system` follows the operating system; the other two hold the page to one appearance. */
export type ThemeChoice = "system" | "dark" | "light";

export function themeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // storage unavailable: follow the system
  }
  return "system";
}

/**
 * Remember a choice of appearance and load the page again with it. The 3D scene bakes its
 * colours into materials and textures when it is built, so a reload is the honest way to switch.
 */
export function chooseTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    return; // nowhere to keep the choice, so nothing would change
  }
  window.location.reload();
}

const systemLight = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
const choice = themeChoice();

/** True when the page is drawn light: asked for, or the system's own choice. */
export const LIGHT = choice === "light" || (choice === "system" && systemLight);

// The stylesheet keys everything off this attribute; set before the first paint.
if (typeof document !== "undefined") document.documentElement.dataset.theme = LIGHT ? "light" : "dark";

export const BACKGROUND = LIGHT ? "#f5f6f8" : "#0c0e12";
export const SELECTION = LIGHT ? "#c2410c" : "#ffcc66";
export const TRAIL = LIGHT ? "#0b8f80" : "#5eead4";
export const FRESH = LIGHT ? "#1b2130" : "#f5f7fb";

/** One hue per kind of thing, chosen to stay distinct on the page's ground, dark or light. */
export const KIND_COLORS: Record<NodeKind, string> = LIGHT
  ? {
      directory: "#5a6680",
      file: "#56607a",
      external: "#7a7f89",
      class: "#c8691c",
      interface: "#a88a10",
      function: "#1f6fd1",
      method: "#0f8c94",
      variable: "#7656d6",
      type: "#c2457c",
      section: "#3f8f3f",
    }
  : {
      directory: "#8b9bbd",
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

/** The letter on a symbol's badge, as an editor's outline shows it. */
export const KIND_LETTERS: Record<NodeKind, string> = {
  directory: "D",
  file: "F",
  external: "↗",
  class: "C",
  interface: "I",
  function: "ƒ",
  method: "M",
  variable: "V",
  type: "T",
  section: "§",
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

export const EDGE_COLORS: Record<EdgeKind, string> = LIGHT
  ? {
      contains: "#aab2c2",
      imports: "#7f8ba6",
      calls: "#1f6fd1",
      references: "#8892a8",
      extends: "#c8691c",
      implements: "#a88a10",
      tests: "#3f8f3f",
      mentions: "#8a5fd0",
      links_to: "#8a5fd0",
    }
  : {
      contains: "#56627d",
      imports: "#8ea2cc",
      calls: "#6cb6ff",
      references: "#a9b4ca",
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

/** Phrases for the inspector: how a relationship reads from each end. */
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

const FOLDER_PALETTE = LIGHT
  ? ["#1f6fd1", "#c8691c", "#3f8f3f", "#c2457c", "#7656d6", "#a88a10", "#0f8c94", "#cf4f3a", "#6f8f1f", "#a655b0"]
  : ["#6cb6ff", "#f2a65a", "#8fd18f", "#f08fb8", "#b9a3f5", "#e6cf6a", "#4fd1d9", "#ff8f7a", "#a8c66c", "#d19bd8"];

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

/** What a node is, in a word or two, for chips and tooltips. */
export function kindName(node: { kind: NodeKind; subkind?: string | null }): string {
  if (node.kind === "type" && node.subkind === "enum") return "enum";
  if (node.kind === "external") return node.subkind === "group" ? "external modules" : "external module";
  if (node.kind === "section") return "doc section";
  if (node.kind === "file" && node.subkind && node.subkind !== "source") return `${node.subkind} file`;
  return node.kind;
}
