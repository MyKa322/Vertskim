import { createHash } from "node:crypto";

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
