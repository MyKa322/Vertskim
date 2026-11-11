import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type {
  Confidence,
  EdgeKind,
  Extraction,
  FileRecord,
  GraphEdge,
  GraphNode,
  ImportDecl,
  RawRef,
  ScipFact,
} from "../types.js";
import { dirId, posixBasename, posixDirname, splitIdentifier } from "../util.js";

/** Bump when the table layout changes; the database is rebuilt from scratch. */
export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  language TEXT,
  subkind TEXT NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  package TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS nodes (
  nid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  subkind TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  parent TEXT,
  start_line INTEGER,
  end_line INTEGER,
  language TEXT,
  signature TEXT,
  doc TEXT,
  exported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent);

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  confidence TEXT NOT NULL,
  origin_file TEXT NOT NULL,
  line INTEGER,
  PRIMARY KEY (src, kind, dst)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, kind);
CREATE INDEX IF NOT EXISTS edges_origin ON edges(origin_file);

CREATE TABLE IF NOT EXISTS refs (
  origin_file TEXT NOT NULL,
  src TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualifier TEXT,
  line INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS refs_origin ON refs(origin_file);
CREATE INDEX IF NOT EXISTS refs_name ON refs(name);

CREATE TABLE IF NOT EXISTS imports (
  origin_file TEXT NOT NULL,
  specifier TEXT NOT NULL,
  line INTEGER NOT NULL,
  names TEXT NOT NULL,
  reexport INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS imports_origin ON imports(origin_file);

CREATE TABLE IF NOT EXISTS scip_sources (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  imported_at INTEGER NOT NULL,
  documents INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  out_of_step INTEGER NOT NULL DEFAULT 0,
  facts INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS scip_files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  hash TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS scip_files_source ON scip_files(source);

-- In this scope the compiler resolved this name (member: written as x.name), to a node or to
-- something the graph has none for. A guess for the same name there is confirmed or wrong.
CREATE TABLE IF NOT EXISTS scip_settled (
  origin_file TEXT NOT NULL,
  src TEXT NOT NULL,
  name TEXT NOT NULL,
  member INTEGER NOT NULL,
  PRIMARY KEY (origin_file, src, name, member)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS scip_facts (
  origin_file TEXT NOT NULL,
  src TEXT NOT NULL,
  kind TEXT NOT NULL,
  dst TEXT NOT NULL,
  line INTEGER,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (origin_file, src, kind, dst)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, qname, tokens, path, signature, doc,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/** Edge kinds that are produced by the resolver (as opposed to structure). */
export const DERIVED_EDGE_KINDS: EdgeKind[] = [
  "imports",
  "calls",
  "references",
  "extends",
  "implements",
  "tests",
  "mentions",
  "links_to",
];

interface NodeRow {
  id: string;
  kind: string;
  subkind: string | null;
  name: string;
  path: string;
  parent: string | null;
  start_line: number | null;
  end_line: number | null;
  language: string | null;
  signature: string | null;
  doc: string | null;
  exported: number;
}

export const NODE_COLUMNS =
  "id, kind, subkind, name, path, parent, start_line, end_line, language, signature, doc, exported";

export function rowToNode(row: Record<string, unknown>): GraphNode {
  const r = row as unknown as NodeRow;
  return {
    id: r.id,
    kind: r.kind as GraphNode["kind"],
    subkind: r.subkind,
    name: r.name,
    path: r.path,
    parent: r.parent,
    startLine: r.start_line,
    endLine: r.end_line,
    language: r.language,
    signature: r.signature,
    doc: r.doc,
    exported: r.exported as GraphNode["exported"],
  };
}

function rowToFile(row: Record<string, unknown>): FileRecord {
  return {
    path: row.path as string,
    hash: row.hash as string,
    size: row.size as number,
    mtimeMs: row.mtime_ms as number,
    language: (row.language as string | null) ?? null,
    subkind: row.subkind as FileRecord["subkind"],
    lines: row.lines as number,
    package: (row.package as string | null) ?? null,
  };
}

/** Qualified name of a symbol id: `a/b.ts#Foo.bar` -> `Foo.bar`. */
function qualifiedName(node: GraphNode): string {
  const i = node.id.indexOf("#");
  return i < 0 ? node.name : node.id.slice(i + 1);
}

/**
 * SQLite-backed graph store. One connection, synchronous; callers decide
 * transaction boundaries with {@link GraphStore.tx}.
 */
export class GraphStore {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  /** Prepare (and cache) a statement. */
  stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Run `fn` inside a transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  // ---------------------------------------------------------------- meta

  getMeta(key: string): string | null {
    const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? (row.value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.stmt(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  /** Remove all indexed data. Used when the schema or extractor version changes. */
  reset(): void {
    this.tx(() => {
      // Compiler-index facts go too: they name nodes, and are read again from their files afterwards.
      const tables = ["files", "nodes", "edges", "refs", "imports", "nodes_fts", "scip_sources", "scip_files", "scip_facts", "scip_settled"];
      for (const table of tables) {
        this.db.exec(`DELETE FROM ${table}`);
      }
    });
  }

  // --------------------------------------------------------------- files

  allFiles(): Map<string, FileRecord> {
    const out = new Map<string, FileRecord>();
    for (const row of this.stmt("SELECT * FROM files").all()) {
      const rec = rowToFile(row);
      out.set(rec.path, rec);
    }
    return out;
  }

  getFile(path: string): FileRecord | null {
    const row = this.stmt("SELECT * FROM files WHERE path = ?").get(path);
    return row ? rowToFile(row) : null;
  }

  /** The file at `path`, or every file under it when it is a directory. */
  filesAt(path: string): FileRecord[] {
    const prefix = `${path}/`;
    // `0` is the character after `/`, so this range is exactly the paths starting with the prefix.
    return this.stmt("SELECT * FROM files WHERE path = ? OR (path >= ? AND path < ?)")
      .all(path, prefix, `${path}0`)
      .map(rowToFile);
  }

  touchFile(path: string, size: number, mtimeMs: number): void {
    this.stmt("UPDATE files SET size = ?, mtime_ms = ? WHERE path = ?").run(size, mtimeMs, path);
  }

  /** Remove a file and everything derived from its contents. */
  removeFile(path: string): void {
    this.tx(() => {
      this.stmt("DELETE FROM nodes_fts WHERE rowid IN (SELECT nid FROM nodes WHERE path = ? AND kind != 'directory')").run(path);
      this.stmt("DELETE FROM nodes WHERE path = ? AND kind != 'directory'").run(path);
      this.stmt("DELETE FROM edges WHERE origin_file = ?").run(path);
      this.stmt("DELETE FROM refs WHERE origin_file = ?").run(path);
      this.stmt("DELETE FROM imports WHERE origin_file = ?").run(path);
      this.stmt("DELETE FROM files WHERE path = ?").run(path);
    });
  }

  /** Replace everything known about a file with a fresh extraction. */
  replaceFile(file: FileRecord, extraction: Extraction): void {
    this.tx(() => {
      this.removeFile(file.path);
      this.stmt(
        "INSERT INTO files (path, hash, size, mtime_ms, language, subkind, lines, package) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        file.path,
        file.hash,
        file.size,
        file.mtimeMs,
        file.language,
        file.subkind,
        file.lines,
        file.package ?? extraction.package ?? null,
      );

      const dir = posixDirname(file.path);
      this.ensureDirectory(dir);
      const fileNode: GraphNode = {
        id: file.path,
        kind: "file",
        subkind: file.subkind,
        name: posixBasename(file.path),
        path: file.path,
        parent: dirId(dir),
        startLine: file.lines > 0 ? 1 : null,
        endLine: file.lines > 0 ? file.lines : null,
        language: file.language,
        signature: null,
        doc: extraction.fileDoc ?? null,
        exported: 0,
      };
      this.insertNode(fileNode);
      this.addEdge({
        src: dirId(dir),
        dst: file.path,
        kind: "contains",
        weight: 1,
        confidence: "exact",
        originFile: file.path,
      });

      for (const node of extraction.nodes) {
        this.insertNode(node);
        if (node.parent) {
          this.addEdge({
            src: node.parent,
            dst: node.id,
            kind: "contains",
            weight: 1,
            confidence: "exact",
            originFile: file.path,
            line: node.startLine,
          });
        }
      }

      const insertRef = this.stmt(
        "INSERT INTO refs (origin_file, src, kind, name, qualifier, line, count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const ref of extraction.refs) {
        insertRef.run(file.path, ref.src, ref.kind, ref.name, ref.qualifier ?? null, ref.line, ref.count);
      }
      const insertImport = this.stmt(
        "INSERT INTO imports (origin_file, specifier, line, names, reexport) VALUES (?, ?, ?, ?, ?)",
      );
      for (const imp of extraction.imports) {
        insertImport.run(file.path, imp.specifier, imp.line, JSON.stringify(imp.names), imp.reexport ? 1 : 0);
      }
    });
  }

  // --------------------------------------------------------------- nodes

  private insertNode(node: GraphNode): void {
    const result = this.stmt(
      `INSERT OR IGNORE INTO nodes (${NODE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      node.id,
      node.kind,
      node.subkind ?? null,
      node.name,
      node.path,
      node.parent ?? null,
      node.startLine ?? null,
      node.endLine ?? null,
      node.language ?? null,
      node.signature ?? null,
      node.doc ?? null,
      node.exported,
    );
    if (Number(result.changes) === 0) return;
    const qname = qualifiedName(node);
    this.stmt(
      "INSERT INTO nodes_fts (rowid, name, qname, tokens, path, signature, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      result.lastInsertRowid,
      node.name,
      qname,
      splitIdentifier(qname).join(" "),
      node.path,
      node.signature ?? "",
      node.doc ?? "",
    );
  }

  /** Create the directory node for `dir` and all of its ancestors. */
  ensureDirectory(dir: string): void {
    const id = dirId(dir);
    if (this.stmt("SELECT 1 FROM nodes WHERE id = ?").get(id)) return;
    const parentDir = dir === "" ? null : posixDirname(dir);
    if (parentDir !== null) this.ensureDirectory(parentDir);
    this.insertNode({
      id,
      kind: "directory",
      name: dir === "" ? "." : posixBasename(dir),
      path: dir === "" ? "" : `${dir}/`,
      parent: parentDir === null ? null : dirId(parentDir),
      exported: 0,
    });
    if (parentDir !== null) {
      this.addEdge({
        src: dirId(parentDir),
        dst: id,
        kind: "contains",
        weight: 1,
        confidence: "exact",
        originFile: "",
      });
    }
  }

  /** Create a node for a third-party dependency such as `ext:npm/react`. */
  ensureExternal(id: string, name: string, ecosystem: string): void {
    if (this.stmt("SELECT 1 FROM nodes WHERE id = ?").get(id)) return;
    this.insertNode({ id, kind: "external", subkind: ecosystem, name, path: "", exported: 0 });
  }

  /** Remove directories with no children, externals nobody imports, and edges to missing nodes. */
  prune(): void {
    this.tx(() => {
      this.db.exec(
        "DELETE FROM edges WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = edges.dst) OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = edges.src)",
      );
      for (;;) {
        const empty = this.stmt(
          "SELECT nid, id FROM nodes WHERE kind = 'directory' AND id != './' AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = nodes.id AND e.kind = 'contains')",
        ).all();
        if (empty.length === 0) break;
        for (const row of empty) this.deleteNodeRow(row.nid as number, row.id as string);
      }
      const orphans = this.stmt(
        "SELECT nid, id FROM nodes WHERE kind = 'external' AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst = nodes.id)",
      ).all();
      for (const row of orphans) this.deleteNodeRow(row.nid as number, row.id as string);
    });
  }

  private deleteNodeRow(nid: number, id: string): void {
    this.stmt("DELETE FROM nodes_fts WHERE rowid = ?").run(nid);
    this.stmt("DELETE FROM nodes WHERE nid = ?").run(nid);
    this.stmt("DELETE FROM edges WHERE dst = ? OR src = ?").run(id, id);
  }

  getNode(id: string): GraphNode | null {
    const row = this.stmt(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`).get(id);
    return row ? rowToNode(row) : null;
  }

  hasNode(id: string): boolean {
    return this.stmt("SELECT 1 FROM nodes WHERE id = ?").get(id) !== undefined;
  }

  /** Direct children of a node, in source order. */
  children(id: string): GraphNode[] {
    return this.stmt(
      `SELECT ${NODE_COLUMNS} FROM nodes WHERE parent = ? ORDER BY (kind = 'directory') DESC, start_line, name`,
    )
      .all(id)
      .map(rowToNode);
  }

  nodesInFile(path: string): GraphNode[] {
    return this.stmt(`SELECT ${NODE_COLUMNS} FROM nodes WHERE path = ? AND kind NOT IN ('file', 'directory')`)
      .all(path)
      .map(rowToNode);
  }

  nodesNamed(name: string): GraphNode[] {
    return this.stmt(`SELECT ${NODE_COLUMNS} FROM nodes WHERE name = ?`).all(name).map(rowToNode);
  }

  /** Names of every symbol and section defined in a file. */
  namesInFile(path: string): string[] {
    return this.stmt("SELECT DISTINCT name FROM nodes WHERE path = ? AND kind NOT IN ('file', 'directory')")
      .all(path)
      .map((r) => r.name as string);
  }

  // --------------------------------------------------------------- edges

  addEdge(edge: GraphEdge): void {
    this.stmt(
      `INSERT INTO edges (src, dst, kind, weight, confidence, origin_file, line) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src, kind, dst) DO UPDATE SET weight = weight + excluded.weight`,
    ).run(edge.src, edge.dst, edge.kind, edge.weight, edge.confidence, edge.originFile, edge.line ?? null);
  }

  /** Remove resolver-produced edges that originate in a file, keeping structure. */
  deleteDerivedEdges(originFile: string): void {
    this.stmt("DELETE FROM edges WHERE origin_file = ? AND kind != 'contains'").run(originFile);
  }

  edgesFrom(src: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind
      ? this.stmt("SELECT * FROM edges WHERE src = ? AND kind = ?").all(src, kind)
      : this.stmt("SELECT * FROM edges WHERE src = ?").all(src);
    return rows.map(rowToEdge);
  }

  edgesTo(dst: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind
      ? this.stmt("SELECT * FROM edges WHERE dst = ? AND kind = ?").all(dst, kind)
      : this.stmt("SELECT * FROM edges WHERE dst = ?").all(dst);
    return rows.map(rowToEdge);
  }

  /** Files other than `path` that currently have an edge into any node of `path`. */
  filesWithEdgesInto(path: string): string[] {
    return this.stmt(
      `SELECT DISTINCT e.origin_file AS f FROM edges e
       JOIN nodes n ON n.id = e.dst
       WHERE n.path = ? AND e.origin_file != ? AND e.origin_file != '' AND e.kind != 'contains'`,
    )
      .all(path, path)
      .map((r) => r.f as string);
  }

  // ----------------------------------------------------- refs and imports

  refsOf(path: string): RawRef[] {
    return this.stmt("SELECT src, kind, name, qualifier, line, count FROM refs WHERE origin_file = ?")
      .all(path)
      .map((r) => ({
        src: r.src as string,
        kind: r.kind as RawRef["kind"],
        name: r.name as string,
        qualifier: (r.qualifier as string | null) ?? null,
        line: r.line as number,
        count: r.count as number,
      }));
  }

  importsOf(path: string): ImportDecl[] {
    return this.stmt("SELECT specifier, line, names, reexport FROM imports WHERE origin_file = ? ORDER BY line")
      .all(path)
      .map((r) => ({
        specifier: r.specifier as string,
        line: r.line as number,
        names: JSON.parse(r.names as string) as ImportDecl["names"],
        reexport: (r.reexport as number) === 1,
      }));
  }

  /** Files containing a reference whose name is one of `names`. */
  filesReferencingNames(names: string[]): string[] {
    const out = new Set<string>();
    for (let i = 0; i < names.length; i += 400) {
      const chunk = names.slice(i, i + 400);
      const marks = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT DISTINCT origin_file AS f FROM refs WHERE name IN (${marks})`)
        .all(...(chunk as SQLInputValue[]));
      for (const row of rows) out.add(row.f as string);
    }
    return [...out];
  }

  // ------------------------------------------------ compiler index facts

  scipSources(): ScipSourceRow[] {
    return this.stmt("SELECT * FROM scip_sources ORDER BY path")
      .all()
      .map((r) => ({
        path: r.path as string,
        size: r.size as number,
        mtimeMs: r.mtime_ms as number,
        tool: r.tool as string,
        importedAt: r.imported_at as number,
        documents: r.documents as number,
        matched: r.matched as number,
        outOfStep: r.out_of_step as number,
        facts: r.facts as number,
      }));
  }

  putScipSource(row: Omit<ScipSourceRow, "importedAt">): void {
    this.stmt(
      `INSERT OR REPLACE INTO scip_sources (path, size, mtime_ms, tool, imported_at, documents, matched, out_of_step, facts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.path, row.size, row.mtimeMs, row.tool, Date.now(), row.documents, row.matched, row.outOfStep, row.facts);
  }

  /** Forget an index file and everything taken from it. */
  removeScipSource(path: string): void {
    this.tx(() => {
      this.stmt("DELETE FROM scip_facts WHERE origin_file IN (SELECT path FROM scip_files WHERE source = ?)").run(path);
      this.stmt("DELETE FROM scip_settled WHERE origin_file IN (SELECT path FROM scip_files WHERE source = ?)").run(path);
      this.stmt("DELETE FROM scip_files WHERE source = ?").run(path);
      this.stmt("DELETE FROM scip_sources WHERE path = ?").run(path);
    });
  }

  /** Project files an index file has facts for. */
  scipFilesOf(source: string): string[] {
    return this.stmt("SELECT path FROM scip_files WHERE source = ?")
      .all(source)
      .map((r) => r.path as string);
  }

  /** Replace the facts held for one file, noting the content they were true of. */
  replaceScipFile(path: string, source: string, hash: string, facts: ScipFact[], settled: string[]): void {
    this.tx(() => {
      this.stmt("DELETE FROM scip_facts WHERE origin_file = ?").run(path);
      this.stmt("DELETE FROM scip_settled WHERE origin_file = ?").run(path);
      const note = this.stmt("INSERT OR IGNORE INTO scip_settled (origin_file, src, name, member) VALUES (?, ?, ?, ?)");
      for (const key of settled) {
        const [src, name, member] = key.split("\u0000");
        note.run(path, src!, name!, Number(member));
      }
      this.stmt("INSERT OR REPLACE INTO scip_files (path, source, hash) VALUES (?, ?, ?)").run(path, source, hash);
      const insert = this.stmt(
        "INSERT OR REPLACE INTO scip_facts (origin_file, src, kind, dst, line, count) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const fact of facts) insert.run(path, fact.src, fact.kind, fact.dst, fact.line, fact.count);
    });
  }

  removeScipFile(path: string): void {
    this.tx(() => {
      this.stmt("DELETE FROM scip_facts WHERE origin_file = ?").run(path);
      this.stmt("DELETE FROM scip_settled WHERE origin_file = ?").run(path);
      this.stmt("DELETE FROM scip_files WHERE path = ?").run(path);
    });
  }

  /** Content hash a file had when its compiler-index facts were taken, if it has any. */
  scipHashOf(path: string): string | null {
    const row = this.stmt("SELECT hash FROM scip_files WHERE path = ?").get(path);
    return row ? (row.hash as string) : null;
  }

  scipFactsOf(path: string): ScipFact[] {
    return this.stmt("SELECT src, kind, dst, line, count FROM scip_facts WHERE origin_file = ?")
      .all(path)
      .map((r) => ({
        src: r.src as string,
        kind: r.kind as EdgeKind,
        dst: r.dst as string,
        line: (r.line as number | null) ?? 1,
        count: r.count as number,
      }));
  }

  /** Files of an index whose content is still what the index describes. */
  scipFilesInUse(source: string): number {
    const row = this.stmt(
      "SELECT COUNT(*) AS c FROM scip_files s JOIN files f ON f.path = s.path AND f.hash = s.hash WHERE s.source = ?",
    ).get(source);
    return Number(row?.c ?? 0);
  }

  /** What the compiler resolved in a file: scope, name and member flag (0 or 1), joined by NULs. */
  scipSettled(path: string): Set<string> {
    return new Set(
      this.stmt("SELECT src, name, member FROM scip_settled WHERE origin_file = ?")
        .all(path)
        .map((r) => `${r.src as string}\u0000${r.name as string}\u0000${r.member as number}`),
    );
  }

  /** A guess turned out right. */
  confirmGuess(src: string, kind: EdgeKind, dst: string): void {
    this.stmt("UPDATE edges SET confidence = 'exact' WHERE src = ? AND kind = ? AND dst = ? AND confidence = 'heuristic'").run(
      src,
      kind,
      dst,
    );
  }

  /** A guess turned out wrong. An edge that something else also vouches for is left alone. */
  deleteGuess(src: string, kind: EdgeKind, dst: string): void {
    this.stmt("DELETE FROM edges WHERE src = ? AND kind = ? AND dst = ? AND confidence = 'heuristic'").run(src, kind, dst);
  }

  /** True when one node inherits from or implements the other. */
  inherits(src: string, dst: string): boolean {
    return (
      this.stmt("SELECT 1 FROM edges WHERE src = ? AND dst = ? AND kind IN ('extends', 'implements')").get(src, dst) !==
      undefined
    );
  }

  /** Add an edge known for certain, or mark the existing one as certain. */
  addExactEdge(edge: Omit<GraphEdge, "confidence">): void {
    this.stmt(
      `INSERT INTO edges (src, dst, kind, weight, confidence, origin_file, line) VALUES (?, ?, ?, ?, 'exact', ?, ?)
       ON CONFLICT(src, kind, dst) DO UPDATE SET confidence = 'exact', weight = max(weight, excluded.weight)`,
    ).run(edge.src, edge.dst, edge.kind, edge.weight, edge.originFile, edge.line ?? null);
  }

  // --------------------------------------------------------------- stats

  counts(): { files: number; nodes: number; edges: number } {
    const one = (sql: string) => Number(this.stmt(sql).get()?.c ?? 0);
    return {
      files: one("SELECT COUNT(*) AS c FROM files"),
      nodes: one("SELECT COUNT(*) AS c FROM nodes"),
      edges: one("SELECT COUNT(*) AS c FROM edges"),
    };
  }
}

/** A SCIP index file that has been read, and what came of it. */
export interface ScipSourceRow {
  path: string;
  size: number;
  mtimeMs: number;
  tool: string;
  importedAt: number;
  documents: number;
  matched: number;
  outOfStep: number;
  facts: number;
}

export function rowToEdge(row: Record<string, unknown>): GraphEdge {
  return {
    src: row.src as string,
    dst: row.dst as string,
    kind: row.kind as EdgeKind,
    weight: row.weight as number,
    confidence: row.confidence as Confidence,
    originFile: row.origin_file as string,
    line: (row.line as number | null) ?? null,
  };
}
