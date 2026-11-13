// The page and the server share the core's shapes; nothing here exists at run time.
export type {
  EdgeGroup,
  EdgeKind,
  GraphNode,
  GraphView,
  NodeDetails,
  NodeKind,
  NoteView,
  OutlineEntry,
  ProjectStatus,
  ViewLink,
  ViewNode,
} from "@vertskim/core";

import type { GraphNode, NodeDetails, NoteView, ProjectStatus } from "@vertskim/core";

export interface ServerStatus extends ProjectStatus {
  /** Folder name of the project. */
  name: string;
  root: string;
  /** Changes whenever the graph does. */
  version: string;
}

export interface TrailEvent {
  tool: string;
  ids: string[];
  at: number;
}

export interface NodePayload extends NodeDetails {
  /** Containers to open so the node is drawn. */
  reveal: string[];
  /** What has been written about this node, oldest first. */
  notes: NoteView[];
}

export interface NotesPayload {
  /** Newest first. */
  notes: NoteView[];
  counts: { notes: number; nodes: number };
}

export interface SourcePayload {
  available: boolean;
  path?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncated?: boolean;
  text?: string;
}

export interface SearchPayload {
  partial: boolean;
  /** `byMeaning`: found by what the code does rather than by its name. */
  hits: { node: GraphNode; fanIn: number; byMeaning?: boolean }[];
}

export type ColorBy = "kind" | "folder";
export type ControlType = "orbit" | "fly";

/** One file of the project, as the explorer lists it. Its path is also its node id. */
export interface TreeFile {
  path: string;
  language: string | null;
  subkind: string;
  lines: number;
  /** 1-based line of the first syntax error, if the file does not parse. */
  syntaxError: number | null;
}

export interface TreePayload {
  version: string;
  files: TreeFile[];
}

/** The views of the side bar, one per button of the activity bar. */
export type SideView = "explorer" | "search" | "graph" | "notes" | "activity";

/** A node kept open as a tab. Until pinned, the next node opened takes its place. */
export interface EditorTab {
  id: string;
  pinned: boolean;
}
