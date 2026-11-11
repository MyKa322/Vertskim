import { spawn } from "node:child_process";
import type { Project } from "@vertskim/core";
import { findRunningUi, type RemoteUi } from "./registry.js";
import { startUiServer, type UiServer, type UiServerOptions } from "./server.js";

/** How long a "no visualizer is running elsewhere" answer is trusted before looking again. */
const REMOTE_RECHECK_MS = 5000;

/**
 * One process's handle on the project's visualizer, wherever it runs.
 *
 * A project has at most one visualizer at a time. Whichever process is asked
 * first starts it; every other process finds it through the data folder and
 * forwards what it has to show.
 */
export class UiBridge {
  private local: UiServer | null = null;
  private remote: RemoteUi | null = null;
  private remoteCheckedAt = 0;
  private starting: Promise<UiServer> | null = null;

  constructor(
    private readonly project: Project,
    private readonly options: UiServerOptions = {},
  ) {}

  /** True when this process is the one serving the visualizer. */
  get serving(): boolean {
    return this.local !== null;
  }

  private async findRemote(force = false): Promise<RemoteUi | null> {
    if (this.local) return null;
    if (!force && Date.now() - this.remoteCheckedAt < REMOTE_RECHECK_MS) return this.remote;
    this.remoteCheckedAt = Date.now();
    this.remote = await findRunningUi(this.project.dataDir);
    return this.remote;
  }

  /** Make sure a visualizer is running and return its page link. */
  async open(focus?: string): Promise<string> {
    if (!this.local) {
      const remote = await this.findRemote(true);
      if (remote) {
        if (focus) await remote.focus(focus).catch(() => undefined);
        return remote.link(focus);
      }
      this.starting ??= startUiServer(this.project, this.options).finally(() => {
        this.starting = null;
      });
      this.local = await this.starting;
    }
    if (focus) this.local.focus(focus);
    return this.local.link(focus);
  }

  /** Show which nodes were just queried, if a visualizer is running anywhere. Never blocks or throws. */
  trail(tool: string, ids: string[]): void {
    if (ids.length === 0) return;
    if (this.local) {
      this.local.trail(tool, ids);
      return;
    }
    this.findRemote()
      .then((remote) => remote?.trail(tool, ids))
      .catch(() => {
        this.remote = null;
      });
  }

  async close(): Promise<void> {
    const local = this.local;
    this.local = null;
    await local?.close();
  }
}

/** Open a link in the user's default browser. Best effort: failure only means they open it themselves. */
export function openInBrowser(url: string): void {
  // Each launcher takes the address as a single argument, so no shell ever parses it.
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no launcher available
  }
}
