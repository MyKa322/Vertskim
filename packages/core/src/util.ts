import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * A path with its symbolic links followed, so that two spellings of one place compare equal:
 * on macOS `/tmp` and `/var` are links into `/private`. The part that does not exist (yet, or
 * any more) is kept as written, below the nearest folder that does.
 */
export function realPath(path: string): string {
  const abs = resolve(path);
  let current = abs;
  let rest = "";
  for (;;) {
    try {
      return join(realpathSync(current), rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      rest = join(basename(current), rest);
      current = parent;
    }
  }
}

/** `path` relative to `root` with forward slashes, or null when it is not inside it. Both absolute. */
export function pathInside(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return toPosix(rel);
}

/**
 * Text of a source file. UTF-8 unless a byte-order mark says otherwise; the
 * mark itself is dropped. Some Windows tools save files as UTF-16.
 */
export function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}

/**
 * Replace control characters other than tab and line breaks, which in a terminal can
 * recolour text, move the cursor or set the clipboard, with visible stand-ins.
 */
export function stripControl(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? "\u2421" : "\ufffd";
  });
}

export function sha1(text: string | Uint8Array): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Convert an OS path fragment to forward slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Directory part of a posix path, without trailing slash. `a/b/c.ts` -> `a/b`, `c.ts` -> ``. */
export function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function posixBasename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Extension including the dot, lower-cased. `a/b.test.TS` -> `.ts`. */
export function extname(p: string): string {
  const base = posixBasename(p);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
}

/**
 * Join and normalise posix path segments, resolving `.` and `..`.
 * Returns null when the result would escape the root.
 */
export function posixJoin(...parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    for (const seg of part.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length === 0) return null;
        out.pop();
      } else {
        out.push(seg);
      }
    }
  }
  return out.join("/");
}

/** Id of the directory node for a posix directory path. Root is `./`. */
export function dirId(dir: string): string {
  return dir === "" ? "./" : `${dir}/`;
}

/** Split an identifier into lower-cased words: `SessionStore_refreshV2` -> session, store, refresh, v2. */
export function splitIdentifier(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One-line form of a declaration head: `f(\n  a,\n  b,\n)` becomes `f(a, b)`. */
export function tidySignature(text: string): string {
  return collapseWhitespace(text)
    .replace(/([([])\s+/g, "$1")
    .replace(/,?\s+([)\]])/g, "$1")
    .replace(/,\s*}/g, " }");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  if (text.charCodeAt(text.length - 1) === 10) n--;
  return n;
}

/** Yield to the event loop so pending I/O (such as MCP requests) can run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
