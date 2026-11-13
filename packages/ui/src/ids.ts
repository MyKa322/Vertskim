// Node ids nest (`dir/file.ts#Class.method`), so a good deal can be read off an id without asking the server.

export function isDirectory(id: string): boolean {
  return id.endsWith("/") || id === "ext:";
}

export function isSymbol(id: string): boolean {
  return id.includes("#");
}

/** The last part of an id: a file's name, a directory's with its slash, a symbol's qualified name. */
export function shortId(id: string): string {
  const hash = id.indexOf("#");
  if (hash >= 0) return id.slice(hash + 1);
  if (id === "./") return "project root";
  if (id === "ext:") return "external modules";
  const trimmed = id.endsWith("/") ? id.slice(0, -1) : id;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) + (id.endsWith("/") ? "/" : "");
}

/** A symbol's own name, without the names it sits inside. */
export function leafName(id: string): string {
  const short = shortId(id);
  if (!isSymbol(id)) return short.endsWith("/") ? short.slice(0, -1) : short;
  return short.slice(short.lastIndexOf(".") + 1);
}

/** The file a node is written in; null for a directory or an external module. */
export function fileOf(id: string): string | null {
  if (id.startsWith("ext:") || id.endsWith("/")) return null;
  const hash = id.indexOf("#");
  return hash >= 0 ? id.slice(0, hash) : id;
}

/** The id one step out: a symbol's owner, a file's directory. Null at the top. */
export function parentOf(id: string): string | null {
  const hash = id.indexOf("#");
  if (hash >= 0) {
    const dot = id.lastIndexOf(".");
    return dot > hash ? id.slice(0, dot) : id.slice(0, hash);
  }
  if (id.startsWith("ext:")) return id === "ext:" ? null : "ext:";
  const trimmed = id.endsWith("/") ? id.slice(0, -1) : id;
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return id === "./" ? null : "./";
  return trimmed.slice(0, slash + 1);
}

/** Every directory a path sits in, outermost first: `a/b/c.ts` -> `a/`, `a/b/`. */
export function directoriesOf(path: string): string[] {
  const out: string[] = [];
  for (let slash = path.indexOf("/"); slash >= 0 && slash < path.length - 1; slash = path.indexOf("/", slash + 1)) {
    out.push(path.slice(0, slash + 1));
  }
  return out;
}

export interface Crumb {
  id: string;
  label: string;
  type: "directory" | "file" | "symbol" | "external";
}

/** The way down to a node, one step per crumb, as an editor's breadcrumbs show it. */
export function crumbsOf(id: string): Crumb[] {
  if (id === "./") return [];
  if (id.startsWith("ext:")) {
    const out: Crumb[] = [{ id: "ext:", label: "external modules", type: "external" }];
    if (id !== "ext:") out.push({ id, label: id.slice(4), type: "external" });
    return out;
  }
  const hash = id.indexOf("#");
  const path = hash >= 0 ? id.slice(0, hash) : id;
  const out: Crumb[] = directoriesOf(path).map((dir) => ({ id: dir, label: leafName(dir), type: "directory" }));
  if (path.endsWith("/")) {
    out.push({ id: path, label: leafName(path), type: "directory" });
    return out;
  }
  out.push({ id: path, label: leafName(path), type: "file" });
  if (hash >= 0) {
    const parts = id.slice(hash + 1).split(".");
    let prefix = `${path}#`;
    parts.forEach((part, index) => {
      prefix += (index > 0 ? "." : "") + part;
      out.push({ id: prefix, label: part, type: "symbol" });
    });
  }
  return out;
}

/**
 * The node standing in for `id` in the current picture: the node itself, or
 * the nearest group around it that is drawn.
 */
export function anchorOf(id: string, drawn: { has(id: string): boolean }): string | null {
  let cursor: string | null = id;
  for (let guard = 0; cursor !== null && guard < 64; guard++) {
    if (drawn.has(cursor)) return cursor;
    cursor = parentOf(cursor);
  }
  return null;
}
