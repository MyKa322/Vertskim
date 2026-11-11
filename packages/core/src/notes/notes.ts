import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Something worth remembering about a node, written by an assistant or a person. */
export interface Note {
  /** Number used to refer to the note, e.g. when removing it. */
  id: number;
  /** Graph node the note is about. */
  nodeId: string;
  text: string;
  /** Who wrote it: a client name, `assistant`, `user`. */
  author: string | null;
  createdAt: number;
  /** Fingerprint of the node's source when the note was written, to tell whether it changed since. */
  anchor: string | null;
}

/** A note together with how it stands against the current graph. */
export interface NoteView extends Note {
  /** The node's source has changed since the note was written. */
  stale: boolean;
  /** The node no longer exists (renamed, moved or deleted). */
  orphaned: boolean;
}

export const MAX_NOTE_LENGTH = 1200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL,
  anchor TEXT
);
CREATE INDEX IF NOT EXISTS notes_node ON notes(node_id);
`;

function rowToNote(row: Record<string, unknown>): Note {
  return {
    id: Number(row.id),
    nodeId: row.node_id as string,
    text: row.text as string,
    author: (row.author as string | null) ?? null,
    createdAt: Number(row.created_at),
    anchor: (row.anchor as string | null) ?? null,
  };
}

/**
 * Notes live in their own database beside the graph. The graph is a cache that
 * is thrown away and rebuilt whenever its format changes; notes are not, so
 * they must not share its file. Nothing is created until the first note is written.
 */
export class NoteStore {
  private db: DatabaseSync | null = null;

  constructor(private readonly path: string) {}

  private open(create: boolean): DatabaseSync | null {
    if (this.db) return this.db;
    if (!create && !existsSync(this.path)) return null;
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    this.db = db;
    return db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  add(nodeId: string, text: string, author: string | null, anchor: string | null): Note {
    const db = this.open(true)!;
    const createdAt = Date.now();
    const result = db
      .prepare("INSERT INTO notes (node_id, text, author, created_at, anchor) VALUES (?, ?, ?, ?, ?)")
      .run(nodeId, text, author, createdAt, anchor);
    return { id: Number(result.lastInsertRowid), nodeId, text, author, createdAt, anchor };
  }

  get(id: number): Note | null {
    const row = this.open(false)?.prepare("SELECT * FROM notes WHERE id = ?").get(id);
    return row ? rowToNote(row) : null;
  }

  remove(id: number): boolean {
    const db = this.open(false);
    return db ? Number(db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes) > 0 : false;
  }

  /** Notes on any of the given nodes, oldest first. */
  forNodes(nodeIds: string[]): Note[] {
    const db = this.open(false);
    if (!db || nodeIds.length === 0) return [];
    const out: Note[] = [];
    for (let i = 0; i < nodeIds.length; i += 400) {
      const chunk = nodeIds.slice(i, i + 400);
      const rows = db
        .prepare(`SELECT * FROM notes WHERE node_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY id`)
        .all(...chunk);
      for (const row of rows) out.push(rowToNote(row));
    }
    return out;
  }

  /** Every note, newest first. */
  all(limit = 200): Note[] {
    const db = this.open(false);
    return db ? db.prepare("SELECT * FROM notes ORDER BY id DESC LIMIT ?").all(limit).map(rowToNote) : [];
  }

  /** Notes whose text contains every one of the words, newest first. */
  matching(words: string[], limit = 20): Note[] {
    const db = this.open(false);
    if (!db || words.length === 0) return [];
    const like = (word: string) => `%${word.replace(/[\\%_]/g, "\\$&")}%`;
    const where = words.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
    return db
      .prepare(`SELECT * FROM notes WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...words.map(like), limit)
      .map(rowToNote);
  }

  counts(): { notes: number; nodes: number } {
    const row = this.open(false)
      ?.prepare("SELECT COUNT(*) AS notes, COUNT(DISTINCT node_id) AS nodes FROM notes")
      .get();
    return { notes: Number(row?.notes ?? 0), nodes: Number(row?.nodes ?? 0) };
  }

  /** Changes whenever a note is added or removed, in this process or another. */
  stamp(): string {
    const row = this.open(false)?.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS top FROM notes").get();
    return `${Number(row?.n ?? 0)}:${Number(row?.top ?? 0)}`;
  }
}
