import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Writes SCIP index files for tests, straight to the protobuf wire format, so
 * the reader is checked against bytes it did not produce itself.
 */

/** How an occurrence's range is written; real indexers use all of these. */
export type RangeForm = "packed" | "unpacked" | "single" | "multi";

export interface FakeOccurrence {
  line: number;
  start: number;
  end: number;
  symbol: string;
  roles?: number;
  form?: RangeForm;
}

export interface FakeSymbol {
  symbol: string;
  implementations?: string[];
}

export interface FakeDocument {
  path: string;
  language?: string;
  /** 1 = UTF-8 bytes, 2 = UTF-16 code units, 3 = code points; left out of the file when undefined. */
  encoding?: number;
  occurrences: FakeOccurrence[];
  symbols?: FakeSymbol[];
  /** Embedded source text, which a reader has no use for and should skip. */
  text?: string;
}

export interface FakeIndex {
  tool?: string;
  version?: string;
  projectRoot?: string;
  documents: FakeDocument[];
}

class Writer {
  private readonly out: number[] = [];

  varint(value: number): this {
    let v = BigInt.asUintN(64, BigInt(value));
    while (v >= 0x80n) {
      this.out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.out.push(Number(v));
    return this;
  }

  int(field: number, value: number): this {
    return this.varint(field * 8).varint(value);
  }

  bytes(field: number, data: Uint8Array): this {
    this.varint(field * 8 + 2).varint(data.length);
    for (const byte of data) this.out.push(byte);
    return this;
  }

  string(field: number, text: string): this {
    return this.bytes(field, new TextEncoder().encode(text));
  }

  message(field: number, build: (w: Writer) => void): this {
    const inner = new Writer();
    build(inner);
    return this.bytes(field, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

function writeOccurrence(w: Writer, o: FakeOccurrence): void {
  const form = o.form ?? "packed";
  if (form === "packed") {
    w.message(1, (r) => r.varint(o.line).varint(o.start).varint(o.end));
  } else if (form === "unpacked") {
    w.int(1, o.line).int(1, o.start).int(1, o.end);
  } else if (form === "single") {
    w.message(8, (r) => {
      // proto3 leaves zero values out
      if (o.line !== 0) r.int(1, o.line);
      if (o.start !== 0) r.int(2, o.start);
      if (o.end !== 0) r.int(3, o.end);
    });
  } else {
    w.message(9, (r) => {
      if (o.line !== 0) r.int(1, o.line);
      if (o.start !== 0) r.int(2, o.start);
      if (o.line !== 0) r.int(3, o.line);
      if (o.end !== 0) r.int(4, o.end);
    });
  }
  w.string(2, o.symbol);
  if (o.roles) w.int(3, o.roles);
}

export function encodeScip(index: FakeIndex): Uint8Array {
  const top = new Writer();
  top.message(1, (meta) => {
    meta.int(1, 0);
    meta.message(2, (tool) => {
      tool.string(1, index.tool ?? "scip-test");
      tool.string(2, index.version ?? "1.0.0");
      tool.string(3, "--flag");
    });
    if (index.projectRoot) meta.string(3, index.projectRoot);
    meta.int(4, 1);
  });
  for (const doc of index.documents) {
    top.message(2, (d) => {
      d.string(4, doc.language ?? "typescript");
      d.string(1, doc.path);
      for (const o of doc.occurrences) d.message(2, (w) => writeOccurrence(w, o));
      for (const s of doc.symbols ?? []) {
        d.message(3, (w) => {
          w.string(1, s.symbol);
          w.string(3, "documentation the reader ignores");
          for (const impl of s.implementations ?? []) {
            w.message(4, (r) => {
              r.string(1, impl);
              r.int(3, 1);
            });
          }
        });
      }
      if (doc.text !== undefined) d.string(5, doc.text);
      if (doc.encoding !== undefined) d.int(6, doc.encoding);
    });
  }
  // An external symbol, which a reader interested in this project's edges passes over.
  top.message(3, (w) => w.string(1, "scip-test npm other 1.0.0 lib/`x.ts`/thing."));
  return top.finish();
}

export const ROLE_DEFINITION = 1;
export const ROLE_IMPORT = 2;

/** Builds one document of an index by pointing at text in the real file. */
export class FakeDocumentBuilder {
  readonly doc: FakeDocument;
  private readonly lines: string[];

  constructor(root: string, path: string, encoding: number | undefined) {
    this.lines = readFileSync(join(root, path), "utf8").split(/\r?\n/);
    this.doc = { path, encoding, occurrences: [], symbols: [] };
  }

  /** Position of `word` inside the first line containing `snippet`. */
  private locate(snippet: string, word: string): { line: number; start: number; end: number } {
    const line = this.lines.findIndex((l) => l.includes(snippet));
    if (line < 0) throw new Error(`${this.doc.path}: no line contains ${JSON.stringify(snippet)}`);
    if (!snippet.includes(word)) throw new Error(`${JSON.stringify(snippet)} does not contain ${JSON.stringify(word)}`);
    const text = this.lines[line]!;
    const index = text.indexOf(snippet) + snippet.indexOf(word);
    const measure = (upTo: number): number => {
      const prefix = text.slice(0, upTo);
      if (this.doc.encoding === 1) return Buffer.byteLength(prefix, "utf8");
      if (this.doc.encoding === 3) return Array.from(prefix).length;
      return prefix.length;
    };
    return { line, start: measure(index), end: measure(index + word.length) };
  }

  /** Write the document's path the way an indexer on Windows does, with backslashes. */
  withBackslashes(): this {
    this.doc.path = this.doc.path.split("/").join("\\");
    return this;
  }

  /** The symbol is defined where `word` appears in `snippet`. */
  def(snippet: string, word: string, symbol: string, form?: RangeForm): this {
    this.doc.occurrences.push({ ...this.locate(snippet, word), symbol, roles: ROLE_DEFINITION, form });
    return this;
  }

  /** The symbol is used where `word` appears in `snippet`. */
  ref(snippet: string, word: string, symbol: string, form?: RangeForm, roles = 0): this {
    this.doc.occurrences.push({ ...this.locate(snippet, word), symbol, roles, form });
    return this;
  }

  /** `symbol` implements, extends or overrides each of `bases`. */
  implementing(symbol: string, ...bases: string[]): this {
    this.doc.symbols!.push({ symbol, implementations: bases });
    return this;
  }
}

export class FakeIndexBuilder {
  private readonly documents: FakeDocumentBuilder[] = [];

  constructor(
    private readonly root: string,
    private readonly options: { tool?: string; projectRoot?: string | null } = {},
  ) {}

  doc(path: string, encoding: number | undefined = 2): FakeDocumentBuilder {
    const builder = new FakeDocumentBuilder(this.root, path, encoding);
    this.documents.push(builder);
    return builder;
  }

  bytes(): Uint8Array {
    return encodeScip({
      tool: this.options.tool ?? "scip-typescript",
      version: "0.4.0",
      projectRoot:
        this.options.projectRoot === null ? undefined : (this.options.projectRoot ?? pathToFileURL(this.root).href),
      documents: this.documents.map((d) => d.doc),
    });
  }

  /** Write the index, by default where indexers put it, with a modification time that always differs. */
  write(tick: number, to = join(this.root, "index.scip")): string {
    writeFileSync(to, this.bytes());
    const when = new Date(Date.now() + tick * 2000);
    utimesSync(to, when, when);
    return to;
  }
}
