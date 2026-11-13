import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vectors (
  node_id TEXT PRIMARY KEY,
  -- hash of the text the vector was made from: unchanged text is never embedded twice
  text_hash TEXT NOT NULL,
  -- content hash of the node's file at the time, so unchanged files need not be read again
  file_hash TEXT NOT NULL,
  vector BLOB NOT NULL
);
`;

/** Layout of vectors.db. Unlike notes, vectors can be remade, so an unknown layout is replaced. */
const VECTORS_VERSION = 1;

export interface VectorRow {
  id: string;
  textHash: string;
  fileHash: string;
  vector: Float32Array;
}

/** Every stored vector, laid end to end, in the order of `ids`. */
export interface VectorMatrix {
  ids: string[];
  dims: number;
  data: Float32Array;
}

/**
 * Vectors live in their own database beside the graph. They cost far more to
 * make than the graph does, so they must survive the graph being rebuilt.
 * Nothing is created until the first vector is stored.
 */
export class VectorStore {
  private db: DatabaseSync | null = null;
  private cached: { stamp: string; matrix: VectorMatrix } | null = null;

  constructor(private readonly path: string) {}

  private open(create: boolean): DatabaseSync | null {
    if (this.db) return this.db;
    if (!create && !existsSync(this.path)) return null;
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > VECTORS_VERSION) {
      // Made by a newer version: vectors can always be made again, so start over in this layout.
      db.exec("DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS meta;");
    }
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${VECTORS_VERSION}`);
    this.db = db;
    return db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.cached = null;
  }

  /** The model the stored vectors came from. */
  model(): string | null {
    const row = this.open(false)?.prepare("SELECT value FROM meta WHERE key = 'model'").get();
    return row ? (row.value as string) : null;
  }

  /** Which version of the text recipe the stored vectors were made with. */
  textVersion(): number {
    const row = this.open(false)?.prepare("SELECT value FROM meta WHERE key = 'text_version'").get();
    return row ? Number(row.value) : 0;
  }

  setTextVersion(version: number): void {
    this.open(true)!
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('text_version', ?)")
      .run(String(version));
  }

  /** Start over for a different model: its vectors cannot be compared with the old ones. */
  reset(model: string): void {
    const db = this.open(true)!;
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM vectors");
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?)").run(model);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    this.cached = null;
  }

  /** Remove everything, as when embeddings are switched off. */
  clear(): void {
    const db = this.open(false);
    if (!db) return;
    db.exec("DELETE FROM vectors; DELETE FROM meta;");
    this.cached = null;
  }

  count(): number {
    const row = this.open(false)?.prepare("SELECT COUNT(*) AS c FROM vectors").get();
    return Number(row?.c ?? 0);
  }

  /** What each stored vector was made from. */
  known(): Map<string, { textHash: string; fileHash: string }> {
    const out = new Map<string, { textHash: string; fileHash: string }>();
    const rows = this.open(false)?.prepare("SELECT node_id, text_hash, file_hash FROM vectors").all() ?? [];
    for (const row of rows) {
      out.set(row.node_id as string, { textHash: row.text_hash as string, fileHash: row.file_hash as string });
    }
    return out;
  }

  put(rows: VectorRow[]): void {
    if (rows.length === 0) return;
    const db = this.open(true)!;
    const insert = db.prepare(
      "INSERT OR REPLACE INTO vectors (node_id, text_hash, file_hash, vector) VALUES (?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const bytes = new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
        insert.run(row.id, row.textHash, row.fileHash, bytes);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Record that these nodes were looked at again and their text had not changed. */
  touch(rows: { id: string; fileHash: string }[]): void {
    const db = this.open(false);
    if (!db || rows.length === 0) return;
    const update = db.prepare("UPDATE vectors SET file_hash = ? WHERE node_id = ?");
    db.exec("BEGIN");
    try {
      for (const row of rows) update.run(row.fileHash, row.id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  remove(ids: string[]): void {
    const db = this.open(false);
    if (!db || ids.length === 0) return;
    const del = db.prepare("DELETE FROM vectors WHERE node_id = ?");
    db.exec("BEGIN");
    try {
      for (const id of ids) del.run(id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Changes whenever the stored vectors do, in this process or another. */
  private stamp(db: DatabaseSync): string {
    const version = db.prepare("PRAGMA data_version").get() as { data_version: number };
    const total = db.prepare("SELECT total_changes() AS c").get() as { c: number };
    return `${version.data_version}:${total.c}`;
  }

  /** All vectors, read once and kept until the store changes. */
  matrix(): VectorMatrix | null {
    const db = this.open(false);
    if (!db) return null;
    const stamp = this.stamp(db);
    if (this.cached?.stamp === stamp) return this.cached.matrix;

    const rows = db.prepare("SELECT node_id, vector FROM vectors").all();
    const first = rows[0]?.vector as Uint8Array | undefined;
    const dims = first ? first.byteLength / 4 : 0;
    const ids: string[] = [];
    const data = new Float32Array(rows.length * dims);
    for (const row of rows) {
      const bytes = row.vector as Uint8Array;
      if (bytes.byteLength !== dims * 4) continue; // a leftover from another model; never comparable
      // Copied first, because a blob's bytes are not guaranteed to sit on a 4-byte boundary.
      data.set(new Float32Array(new Uint8Array(bytes).buffer, 0, dims), ids.length * dims);
      ids.push(row.node_id as string);
    }
    const matrix = { ids, dims, data: ids.length === rows.length ? data : data.subarray(0, ids.length * dims) };
    this.cached = { stamp, matrix };
    return matrix;
  }
}
