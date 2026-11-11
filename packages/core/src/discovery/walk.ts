import { readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { FileSubkind } from "../types.js";
import { posixDirname } from "../util.js";
import { classifyFile, languageOf } from "./classify.js";

/**
 * Ignored unless a `.vertskimignore` (or `.gitignore`) re-includes them with a
 * negated pattern such as `!dist/`.
 */
export const DEFAULT_IGNORES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "__pycache__/",
  ".venv/",
  "venv/",
  ".tox/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".ruff_cache/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".gradle/",
  ".idea/",
  ".terraform/",
  ".vertskim/",
  "dist/",
  "build/",
  "out/",
  "target/",
  "coverage/",
  "*.pyc",
  "*.tsbuildinfo",
  "*.scip",
  ".DS_Store",
  "Thumbs.db",
];

/** Files that change what is ignored. A change to one of them calls for a full scan. */
export const RULE_FILES = [".gitignore", ".vertskimignore"];

/** Hard stop so pointing the server at a home directory cannot run away. */
export const MAX_FILES = 100_000;

export interface DiscoveredFile {
  /** Posix path relative to the project root. */
  path: string;
  abs: string;
  size: number;
  mtimeMs: number;
  language: string | null;
  subkind: FileSubkind;
}

export interface WalkResult {
  files: Map<string, DiscoveredFile>;
  /** True when the walk stopped at {@link MAX_FILES}. */
  truncated: boolean;
}

interface RuleSet {
  /** Posix directory the rules are relative to; empty for the root. */
  base: string;
  ig: Ignore;
}

function readRules(dirAbs: string, name: string): string | null {
  try {
    return readFileSync(join(dirAbs, name), "utf8");
  } catch {
    return null;
  }
}

/** Git semantics: the deepest rule file with an opinion wins. */
function isIgnored(rules: RuleSet[], rel: string, isDir: boolean): boolean {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    const sub = rule.base === "" ? rel : rel.slice(rule.base.length + 1);
    const result = rule.ig.test(isDir ? `${sub}/` : sub);
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}

/** One discovery pass. Never follows symlinks, so it cannot leave the project. */
class Walker {
  readonly files = new Map<string, DiscoveredFile>();
  truncated = false;
  private readonly ruleCache = new Map<string, Ignore | null>();

  constructor(private readonly root: string) {}

  /** Rules declared in one directory: the defaults at the root, plus its ignore files. */
  private ownRules(dirRel: string): Ignore | null {
    const cached = this.ruleCache.get(dirRel);
    if (cached !== undefined) return cached;
    const dirAbs = dirRel === "" ? this.root : join(this.root, dirRel);
    const own = ignore();
    let any = false;
    if (dirRel === "") {
      own.add(DEFAULT_IGNORES);
      any = true;
    }
    for (const name of RULE_FILES) {
      const text = readRules(dirAbs, name);
      if (text !== null) {
        own.add(text);
        any = true;
      }
    }
    const result = any ? own : null;
    this.ruleCache.set(dirRel, result);
    return result;
  }

  /** Rules that apply to the entries of `dirRel`: its own and those of every ancestor. */
  private rulesFor(dirRel: string): RuleSet[] {
    const stack: RuleSet[] = [];
    const push = (base: string) => {
      const ig = this.ownRules(base);
      if (ig) stack.push({ base, ig });
    };
    push("");
    let current = "";
    for (const segment of dirRel === "" ? [] : dirRel.split("/")) {
      current = current === "" ? segment : `${current}/${segment}`;
      push(current);
    }
    return stack;
  }

  private add(rel: string, abs: string, size: number, mtimeMs: number): void {
    if (this.files.size >= MAX_FILES) {
      this.truncated = true;
      return;
    }
    this.files.set(rel, { path: rel, abs, size, mtimeMs, language: languageOf(rel), subkind: classifyFile(rel) });
  }

  /** Walk a directory that is already known not to be ignored. */
  async visit(dirRel: string): Promise<void> {
    if (this.truncated) return;
    const dirAbs = dirRel === "" ? this.root : join(this.root, dirRel);
    const rules = this.rulesFor(dirRel);

    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip it
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const subdirs: string[] = [];
    const pending: Promise<void>[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!isIgnored(rules, rel, true)) subdirs.push(rel);
      } else if (entry.isFile()) {
        if (isIgnored(rules, rel, false)) continue;
        const abs = join(dirAbs, entry.name);
        pending.push(
          lstat(abs).then(
            (st) => this.add(rel, abs, st.size, st.mtimeMs),
            () => undefined, // vanished between readdir and stat
          ),
        );
      }
    }
    await Promise.all(pending);
    for (const sub of subdirs) await this.visit(sub);
  }

  /** Discover whatever exists at one path: a file, or a directory and its contents. */
  async visitPath(rel: string): Promise<void> {
    if (rel === "") return this.visit("");
    // Every ancestor must be a real, non-ignored directory.
    const segments = rel.split("/");
    let ancestor = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const parent = ancestor;
      ancestor = ancestor === "" ? segments[i]! : `${ancestor}/${segments[i]}`;
      if (isIgnored(this.rulesFor(parent), ancestor, true)) return;
      const st = await lstat(join(this.root, ancestor)).catch(() => null);
      if (!st || !st.isDirectory() || st.isSymbolicLink()) return;
    }
    const abs = join(this.root, rel);
    const st = await lstat(abs).catch(() => null);
    if (!st || st.isSymbolicLink()) return;
    const rules = this.rulesFor(posixDirname(rel));
    if (st.isDirectory()) {
      if (!isIgnored(rules, rel, true)) await this.visit(rel);
    } else if (st.isFile()) {
      if (!isIgnored(rules, rel, false)) this.add(rel, abs, st.size, st.mtimeMs);
    }
  }
}

/** List every non-ignored file under `root`. */
export async function walkProject(root: string): Promise<WalkResult> {
  const walker = new Walker(root);
  await walker.visit("");
  return { files: walker.files, truncated: walker.truncated };
}

/**
 * List the non-ignored files at the given project-relative paths, applying the
 * same rules as a full walk. A path that no longer exists, or is ignored,
 * simply contributes nothing.
 */
export async function walkPaths(root: string, paths: Iterable<string>): Promise<WalkResult> {
  const walker = new Walker(root);
  for (const path of paths) await walker.visitPath(path);
  return { files: walker.files, truncated: walker.truncated };
}
