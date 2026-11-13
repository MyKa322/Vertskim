import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "../project.js";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures", import.meta.url));

/** The sample project the tests index. */
export const FIXTURE = join(FIXTURES, "sample");

const temps: string[] = [];

/**
 * A new, empty folder, as a real path. The system's temporary folder is itself a link on
 * macOS (`/var` into `/private/var`), and a test that is not about links should not
 * depend on that; {@link linkTo} is for the ones that are.
 */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `vertskim-${prefix}-`)));
  temps.push(dir);
  return dir;
}

/** A second way to reach a folder: a symbolic link to it. Null where links cannot be made. */
export function linkTo(dir: string): string | null {
  const link = join(tempDir("link"), "linked");
  try {
    // A junction on Windows, which unlike a symbolic link there needs no special rights.
    symlinkSync(dir, link, "junction");
  } catch {
    return null;
  }
  return link;
}

/** Remove every directory handed out by {@link tempDir}. */
export function removeTempDirs(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** A private, writable copy of one of the projects under `fixtures/`. */
export function copyFixture(name = "sample"): string {
  const dir = tempDir("project");
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/** Write a file and move its mtime forward so the change is always noticed. */
export function write(root: string, path: string, content: string, tick: number): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const when = new Date(Date.now() + tick * 2000);
  utimesSync(abs, when, when);
}

export function edge(
  project: Project,
  src: string,
  kind: string,
  dst: string,
): { confidence: string; weight: number } | null {
  const row = project.store.db
    .prepare("SELECT confidence, weight FROM edges WHERE src = ? AND kind = ? AND dst = ?")
    .get(src, kind, dst);
  return row ? { confidence: row.confidence as string, weight: row.weight as number } : null;
}

/** The whole graph in a stable order, for comparing two databases. */
export function dump(project: Project): { nodes: unknown[]; edges: unknown[] } {
  const db = project.store.db;
  return {
    nodes: db
      .prepare(
        "SELECT id, kind, subkind, name, path, parent, start_line, end_line, signature, doc, exported FROM nodes ORDER BY id",
      )
      .all(),
    edges: db
      .prepare("SELECT src, kind, dst, weight, confidence, origin_file, line FROM edges ORDER BY src, kind, dst")
      .all(),
  };
}

/** Every file under a directory with its size and mtime. */
export function snapshot(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else {
        const st = statSync(abs);
        out.push(`${abs}|${st.size}|${st.mtimeMs}`);
      }
    }
  };
  visit(root);
  return out.sort();
}
