/** Kinds of node in the graph. */
export const NODE_KINDS = [
  "directory",
  "file",
  "external",
  "class",
  "interface",
  "function",
  "method",
  "variable",
  "type",
  "section",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Kinds of edge in the graph. */
export const EDGE_KINDS = [
  "contains",
  "imports",
  "calls",
  "references",
  "extends",
  "implements",
  "tests",
  "mentions",
  "links_to",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * How an edge was established.
 * - exact: structural fact (containment, an import that resolved to a file)
 * - resolved: followed an import binding or a same-file scope lookup
 * - heuristic: matched by name only; may be wrong
 */
export type Confidence = "exact" | "resolved" | "heuristic";

/** 0 = not exported, 1 = named export, 2 = default export. */
export type Exported = 0 | 1 | 2;

export interface GraphNode {
  /** Stable id: `src/a.ts`, `src/`, `src/a.ts#Class.method`, `docs/x.md#anchor`, `ext:npm/react`. */
  id: string;
  kind: NodeKind;
  subkind?: string | null;
  name: string;
  /** File (or directory) the node lives in; empty for externals. */
  path: string;
  /** Id of the containing node. */
  parent?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  language?: string | null;
  signature?: string | null;
  doc?: string | null;
  exported: Exported;
}

export interface GraphEdge {
  src: string;
  dst: string;
  kind: EdgeKind;
  weight: number;
  confidence: Confidence;
  /** File whose contents produced this edge; empty for directory structure. */
  originFile: string;
  line?: number | null;
}

/** Reference kinds produced by extractors before resolution. */
export type RefKind = "calls" | "new" | "references" | "type" | "extends" | "implements" | "mentions" | "links_to";

/** Stored as a reference's qualifier when the receiver is the enclosing type itself. */
export const SELF_QUALIFIER = "@self";
/**
 * Starts a qualifier that names the receiver's type instead of the receiver.
 * `:Store` is a type written down; `:()Project open` is whatever `Project.open()`
 * returns; a qualifier starting with `?` is an expression of unknown type, followed
 * by what is known about where it starts: `?z`, `?:Store`.
 */
export const TYPED_PREFIX = ":";
/** A receiver of unknown type, followed by the start of the expression it comes from. */
export const UNKNOWN_PREFIX = "?";

/** An unresolved reference found in a file. Resolved into edges by the resolver. */
export interface RawRef {
  /** Id of the node the reference appears in (a symbol, a section, or the file). */
  src: string;
  kind: RefKind;
  /** Last segment of the referenced name, or the link target for docs. */
  name: string;
  /** Receiver or namespace text (`this`, `ns`, `pkg.mod`), or the full mention text for docs. */
  qualifier?: string | null;
  line: number;
  count: number;
}

export interface ImportName {
  /** Name bound in the importing file. `*` for wildcard imports with no binding. */
  local: string;
  /** Name in the target module: an identifier, `default`, or `*` for the whole module. */
  imported: string;
}

export interface ImportDecl {
  specifier: string;
  line: number;
  names: ImportName[];
  /** True for `export ... from` statements. */
  reexport: boolean;
}

/** Everything an extractor learned from one file. */
export interface Extraction {
  /** Symbol and section nodes (not the file node itself). */
  nodes: GraphNode[];
  refs: RawRef[];
  imports: ImportDecl[];
  /** One-line description for the file node. */
  fileDoc?: string | null;
  /** Package or namespace the file declares, in languages that have one. */
  package?: string | null;
  /** 1-based line of the first syntax error, when the file does not parse cleanly. */
  syntaxError?: number | null;
  /** Fields of the file's types whose type is written down or inferred, for following `a.b.c()`. */
  fields?: FieldHint[];
}

/** A field of a class, interface or struct, and what is known of its type (encoded as a receiver hint). */
export interface FieldHint {
  owner: string;
  name: string;
  type: string;
}

/** One relationship a compiler-backed (SCIP) index states as fact. */
export interface ScipFact {
  src: string;
  kind: EdgeKind;
  dst: string;
  line: number;
  count: number;
}

export type FileSubkind = "source" | "test" | "doc" | "config" | "asset" | "data" | "other";

export interface FileRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  language: string | null;
  subkind: FileSubkind;
  lines: number;
  /** Package or namespace the file declares, in languages that have one. */
  package?: string | null;
  /** 1-based line of the first syntax error in the file as it is now, if any. */
  syntaxError?: number | null;
  /** True when the symbols stored for the file come from an earlier version that parsed. */
  keptSymbols?: boolean;
}

/** A file that does not parse cleanly. */
export interface SyntaxErrorFile {
  path: string;
  line: number;
  /** True when its symbols are those of the last version that parsed, not of the file as it is now. */
  keptSymbols: boolean;
}

export interface IndexStatus {
  state: "idle" | "indexing";
  /** 0..1 while indexing. */
  progress: number;
  files: number;
  nodes: number;
  edges: number;
  lastSyncAt: number | null;
  lastSyncMs: number | null;
}

export interface SyncResult {
  added: number;
  changed: number;
  removed: number;
  resolvedFiles: number;
  durationMs: number;
}
