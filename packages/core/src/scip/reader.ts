/**
 * A reader for SCIP indexes (https://github.com/sourcegraph/scip), the format
 * written by scip-typescript, scip-python, scip-java, rust-analyzer and others.
 *
 * Only the parts needed to turn occurrences into graph edges are decoded, and
 * documents are handed over one at a time, so a large index is never held in
 * memory as objects. The protobuf wire format is read directly; there is no
 * dependency on a protobuf library.
 */

/** Bits of `Occurrence.symbol_roles`. */
export const ROLE_DEFINITION = 0x1;
export const ROLE_IMPORT = 0x2;

/** Values of `Document.position_encoding`: what a character offset counts. */
export const ENCODING_UTF8 = 1;
export const ENCODING_UTF16 = 2;
export const ENCODING_UTF32 = 3;

export interface ScipOccurrence {
  /** 0-based line of the start of the range. */
  line: number;
  /** Start offset within the line, in the document's position encoding. */
  start: number;
  /** End offset within the line; equal to `start` when the range runs on to another line. */
  end: number;
  symbol: string;
  roles: number;
}

export interface ScipRelationship {
  symbol: string;
  isImplementation: boolean;
}

export interface ScipSymbol {
  symbol: string;
  relationships: ScipRelationship[];
}

export interface ScipDocument {
  /** Path relative to the index's project root, with `/` separators. */
  relativePath: string;
  language: string;
  positionEncoding: number;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbol[];
}

export interface ScipMetadata {
  /** URI of the directory the indexer ran in. */
  projectRoot: string;
  toolName: string;
  toolVersion: string;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const utf8 = new TextDecoder("utf-8");

class Reader {
  pos: number;

  constructor(
    private readonly buf: Uint8Array,
    start: number,
    readonly end: number,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let factor = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error("unexpected end of data");
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * factor;
      if ((byte & 0x80) === 0) return result;
      factor *= 128;
    }
    throw new Error("malformed varint");
  }

  /** A field of protobuf type int32: negative values arrive as 64-bit two's complement. */
  int32(): number {
    const value = this.varint();
    return value > 0x7fffffff ? Number(BigInt.asIntN(32, BigInt(value))) : value;
  }

  /** The bounds of a length-delimited field, leaving the position after it. */
  span(): [number, number] {
    const length = this.varint();
    const start = this.pos;
    const end = start + length;
    if (end > this.end) throw new Error("field runs past the end of its message");
    this.pos = end;
    return [start, end];
  }

  string(): string {
    const [start, end] = this.span();
    return utf8.decode(this.buf.subarray(start, end));
  }

  sub(): Reader {
    const [start, end] = this.span();
    return new Reader(this.buf, start, end);
  }

  skip(wire: number): void {
    if (wire === WIRE_VARINT) this.varint();
    else if (wire === WIRE_FIXED64) this.pos += 8;
    else if (wire === WIRE_BYTES) this.span();
    else if (wire === WIRE_FIXED32) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
    if (this.pos > this.end) throw new Error("field runs past the end of its message");
  }

  /** Read fields until the message ends, passing each to `visit`, which returns false for fields it ignores. */
  each(visit: (field: number, wire: number) => boolean): void {
    while (!this.done) {
      const tag = this.varint();
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      if (!visit(field, wire)) this.skip(wire);
    }
  }
}

function readRange(reader: Reader, wire: number, into: number[]): void {
  if (wire === WIRE_BYTES) {
    const packed = reader.sub();
    while (!packed.done) into.push(packed.int32());
  } else {
    into.push(reader.int32());
  }
}

function readOccurrence(reader: Reader): ScipOccurrence | null {
  const range: number[] = [];
  let line = -1;
  let start = 0;
  let end = 0;
  let symbol = "";
  let roles = 0;
  reader.each((field, wire) => {
    switch (field) {
      case 1: // repeated int32 range: [line, start, end] or [line, start, endLine, end]
        readRange(reader, wire, range);
        return true;
      case 2:
        symbol = reader.string();
        return true;
      case 3:
        roles = reader.int32();
        return true;
      case 8: {
        // SingleLineRange { line = 1; start_character = 2; end_character = 3 }
        const single = reader.sub();
        line = 0;
        single.each((f) => {
          if (f === 1) line = single.int32();
          else if (f === 2) start = single.int32();
          else if (f === 3) end = single.int32();
          else return false;
          return true;
        });
        return true;
      }
      case 9: {
        // MultiLineRange { start_line = 1; start_character = 2; end_line = 3; end_character = 4 }
        const multi = reader.sub();
        let endLine = 0;
        let endChar = 0;
        line = 0;
        multi.each((f) => {
          if (f === 1) line = multi.int32();
          else if (f === 2) start = multi.int32();
          else if (f === 3) endLine = multi.int32();
          else if (f === 4) endChar = multi.int32();
          else return false;
          return true;
        });
        end = endLine === line ? endChar : start;
        return true;
      }
      default:
        return false;
    }
  });
  if (line < 0) {
    if (range.length === 3) [line, start, end] = range as [number, number, number];
    else if (range.length === 4) {
      line = range[0]!;
      start = range[1]!;
      end = range[2] === line ? range[3]! : start;
    } else return null;
  }
  return symbol === "" || line < 0 ? null : { line, start, end, symbol, roles };
}

function readSymbol(reader: Reader): ScipSymbol {
  const out: ScipSymbol = { symbol: "", relationships: [] };
  reader.each((field) => {
    if (field === 1) {
      out.symbol = reader.string();
      return true;
    }
    if (field === 4) {
      const rel = reader.sub();
      const relationship: ScipRelationship = { symbol: "", isImplementation: false };
      rel.each((f) => {
        if (f === 1) relationship.symbol = rel.string();
        else if (f === 3) relationship.isImplementation = rel.varint() !== 0;
        else return false;
        return true;
      });
      if (relationship.symbol) out.relationships.push(relationship);
      return true;
    }
    return false;
  });
  return out;
}

function readDocument(reader: Reader): ScipDocument {
  const doc: ScipDocument = { relativePath: "", language: "", positionEncoding: 0, occurrences: [], symbols: [] };
  reader.each((field) => {
    switch (field) {
      case 1:
        doc.relativePath = reader.string();
        return true;
      case 2: {
        const occurrence = readOccurrence(reader.sub());
        if (occurrence) doc.occurrences.push(occurrence);
        return true;
      }
      case 3: {
        const symbol = readSymbol(reader.sub());
        if (symbol.symbol && symbol.relationships.length > 0) doc.symbols.push(symbol);
        return true;
      }
      case 4:
        doc.language = reader.string();
        return true;
      case 6:
        doc.positionEncoding = reader.varint();
        return true;
      default:
        return false; // the embedded source text (5) is skipped without being decoded
    }
  });
  return doc;
}

/**
 * Walk an index, calling `onDocument` for each document in turn. Throws when
 * the data is not a SCIP index.
 */
export function readScip(data: Uint8Array, onDocument: (doc: ScipDocument) => void): ScipMetadata {
  const metadata: ScipMetadata = { projectRoot: "", toolName: "", toolVersion: "" };
  let documents = 0;
  const top = new Reader(data, 0, data.length);
  top.each((field, wire) => {
    if (wire !== WIRE_BYTES) return false;
    if (field === 1) {
      const meta = top.sub();
      meta.each((f) => {
        if (f === 2) {
          const tool = meta.sub();
          tool.each((tf) => {
            if (tf === 1) metadata.toolName = tool.string();
            else if (tf === 2) metadata.toolVersion = tool.string();
            else return false;
            return true;
          });
          return true;
        }
        if (f === 3) {
          metadata.projectRoot = meta.string();
          return true;
        }
        return false;
      });
      return true;
    }
    if (field === 2) {
      const doc = readDocument(top.sub());
      documents++;
      if (doc.relativePath) onDocument(doc);
      return true;
    }
    return false;
  });
  if (documents === 0 && metadata.toolName === "" && metadata.projectRoot === "") {
    throw new Error("no metadata and no documents: this does not look like a SCIP index");
  }
  return metadata;
}

const NAME = "(`(?:[^`]|``)+`|[\\w$+-]+)";
const DESCRIPTOR_END = new RegExp(`${NAME}(?:\\([\\w$+-]*\\))?[/#.:!]$`);
const BRACKET_END = new RegExp(`[\\[(]${NAME}[\\])]$`);

/** The name a symbol string ends with: `… src/a.ts/Store#refresh().` -> `refresh`. Null for locals. */
export function symbolName(symbol: string): string | null {
  if (symbol.startsWith("local ")) return null;
  // A type parameter `[T]` or parameter `(name)` is the last thing in its symbol; anything else ends in a suffix.
  const name = (DESCRIPTOR_END.exec(symbol) ?? BRACKET_END.exec(symbol))?.[1];
  if (name === undefined) return null;
  return name.startsWith("`") ? name.slice(1, -1).replace(/``/g, "`") : name;
}
