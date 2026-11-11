import { closeSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";

/** A lock whose holder has not touched it for this long is considered abandoned. */
const STALE_MS = 30_000;
const HEARTBEAT_MS = 5_000;
const RETRY_MS = 40;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(lockPath: string): boolean {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > STALE_MS) return true;
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    return !processAlive(pid);
  } catch {
    return true; // vanished or unreadable: try to take it
  }
}

/**
 * Run `fn` while holding an exclusive lock file, so that only one process at a
 * time rewrites a project's graph. Several MCP clients on one project each
 * start their own server; without this their syncs would interleave.
 *
 * `onWait` is called once if the lock is held by someone else.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, onWait?: () => void): Promise<T> {
  let waited = false;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (isStale(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (!waited) {
        waited = true;
        onWait?.();
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }

  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // the lock file was removed from under us; nothing useful to do
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    rmSync(lockPath, { force: true });
  }
}
