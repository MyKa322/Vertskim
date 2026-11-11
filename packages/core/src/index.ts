export {
  Project,
  dataRoot,
  projectDataDir,
  type OpenOptions,
  type ProjectStatus,
  type SourceSlice,
  type SyncRequest,
} from "./project.js";
export { GraphStore } from "./store/store.js";
export { MAX_NOTE_LENGTH, type Note, type NoteView } from "./notes/notes.js";
export { parsedLanguages } from "./extract/index.js";
export type { ScipSourceStatus } from "./scip/indexes.js";
export { MAX_VECTORS, type EmbedProgress, type EmbedResult, type EmbeddingStatus } from "./embed/embeddings.js";
export {
  PROVIDERS,
  defaultUrl as defaultEmbeddingUrl,
  checkConfig as checkEmbeddingConfig,
  ollamaEmbeddingModels,
  type EmbeddingConfig,
  type ProviderName,
} from "./embed/provider.js";
export type { ContextItem, ContextOptions, ContextResult } from "./analyze/context.js";
export type { ImpactedNode, ImpactOptions, ImpactResult } from "./analyze/impact.js";
export type { DirSummary, Overview } from "./analyze/overview.js";
export type { PathOptions, PathResult, PathStep } from "./analyze/path.js";
export { EXTERNAL_GROUP } from "./analyze/view.js";
export type { GraphView, ViewLink, ViewNode, ViewOptions } from "./analyze/view.js";
export type { NodeDetails, OutlineEntry, EdgeGroup } from "./query/details.js";
export type { Neighbor, NeighborOptions, NeighborResult } from "./query/neighbors.js";
export type { SearchHit, SearchOptions, SearchResult } from "./query/search.js";
export { DEFAULT_IGNORES } from "./discovery/walk.js";
export { EDGE_KINDS, NODE_KINDS } from "./types.js";
export type {
  Confidence,
  EdgeKind,
  Exported,
  FileRecord,
  FileSubkind,
  GraphEdge,
  GraphNode,
  IndexStatus,
  NodeKind,
  SyncResult,
} from "./types.js";
