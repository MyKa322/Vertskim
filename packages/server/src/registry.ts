import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a running visualizer writes into the project's data folder so other processes can find it. */
export interface UiRecord {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

/** A visualizer served by another process. */
export interface RemoteUi {
  origin: string;
  token: string;
  /** Page address, optionally opening on a node. */
  link(focus?: string): string;
  /** Tell the page which nodes were just queried. */
  trail(tool: string, ids: string[]): Promise<void>;
  /** Tell the page to fly to a node. */
  focus(id: string): Promise<void>;
}

const FILE = "ui.json";
const PROBE_TIMEOUT_MS = 500;

export function pageLink(origin: string, token: string, focus?: string): string {
  const hash = focus ? `#focus=${encodeURIComponent(focus)}` : "";
  return `${origin}/?t=${token}${hash}`;
}

export function writeUiRecord(dataDir: string, record: UiRecord): void {
  writeFileSync(join(dataDir, FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function removeUiRecord(dataDir: string, pid: number): void {
  try {
    const record = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as UiRecord;
    if (record.pid === pid) rmSync(join(dataDir, FILE), { force: true });
  } catch {
    // nothing to remove
  }
}

async function post(origin: string, token: string, path: string, body: unknown): Promise<void> {
  await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
  });
}

/**
 * Find a visualizer already running for this project, in any process. The
 * record is only trusted once the server it names answers with the same token.
 */
export async function findRunningUi(dataDir: string): Promise<RemoteUi | null> {
  let record: UiRecord;
  try {
    record = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as UiRecord;
  } catch {
    return null;
  }
  if (!Number.isInteger(record.port) || typeof record.token !== "string") return null;
  const origin = `http://127.0.0.1:${record.port}`;
  try {
    const response = await fetch(`${origin}/api/status`, {
      headers: { Authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
  } catch {
    return null; // stale record: the process is gone or the port was reused
  }
  const { token } = record;
  return {
    origin,
    token,
    link: (focus) => pageLink(origin, token, focus),
    trail: (tool, ids) => post(origin, token, "/api/trail", { tool, ids }),
    focus: (id) => post(origin, token, "/api/focus", { id }),
  };
}
