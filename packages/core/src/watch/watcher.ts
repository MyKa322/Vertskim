import { relative } from "node:path";
import { DEFAULT_IGNORES } from "../discovery/walk.js";
import { toPosix } from "../util.js";

export interface WatchHandle {
  close(): Promise<void>;
}

export interface WatchCallbacks {
  /** Project-relative posix paths that were created, changed or deleted. */
  onChange(paths: string[]): void;
  /** The watcher lost track of the tree (overflow, permission change). A full re-scan is needed. */
  onError(error: Error): void;
}

/**
 * Directories that are never worth watching. This only reduces noise and, on
 * Linux, the number of inotify watches: the indexer applies the real ignore
 * rules to every path it is told about.
 */
function watchIgnores(): string[] {
  const globs: string[] = [];
  for (const pattern of DEFAULT_IGNORES) {
    if (!pattern.endsWith("/")) continue;
    const name = pattern.slice(0, -1);
    // Build output folders can be re-included by the user, so they stay watched.
    if (["dist", "build", "out", "target", "coverage"].includes(name)) continue;
    globs.push(`**/${name}`, `**/${name}/**`);
  }
  return globs;
}

/**
 * Watch a project for file changes using the operating system's own
 * notifications. Returns null when the native watcher is not available on this
 * platform; callers then fall back to re-scanning before each query.
 */
export async function watchProject(root: string, callbacks: WatchCallbacks): Promise<WatchHandle | null> {
  let watcher: typeof import("@parcel/watcher");
  try {
    // An optional native module: absent on platforms it has no prebuilt binary for.
    watcher = (await import("@parcel/watcher")).default;
  } catch {
    return null;
  }
  try {
    const subscription = await watcher.subscribe(
      root,
      (error, events) => {
        if (error) {
          callbacks.onError(error);
          return;
        }
        const paths: string[] = [];
        for (const event of events) {
          const rel = toPosix(relative(root, event.path));
          if (rel !== "" && !rel.startsWith("..")) paths.push(rel);
        }
        if (paths.length > 0) callbacks.onChange(paths);
      },
      { ignore: watchIgnores() },
    );
    return { close: () => subscription.unsubscribe() };
  } catch {
    return null;
  }
}
