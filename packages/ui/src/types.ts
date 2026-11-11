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
  hits: { node: GraphNode; fanIn: number }[];
}

export type ColorBy = "kind" | "folder";
export type ControlType = "orbit" | "fly";
