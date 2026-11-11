import { ANALYSIS_TOOLS } from "./analysis-tools.js";
import type { ToolSpec } from "./define.js";
import { NOTE_TOOLS } from "./notes-tools.js";
import { QUERY_TOOLS } from "./tools.js";

/** Every tool the server offers, in the order a client lists them. */
export const TOOLS: ToolSpec[] = [
  ...ANALYSIS_TOOLS.slice(0, 2), // overview, context
  ...QUERY_TOOLS, // search, node, neighbors
  ...ANALYSIS_TOOLS.slice(2, 4), // impact, path
  ...NOTE_TOOLS, // annotate
  ...ANALYSIS_TOOLS.slice(4), // sync, open_ui
];

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}
