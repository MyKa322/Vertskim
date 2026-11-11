import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Project } from "@vertskim/core";
import type { ToolContext } from "./define.js";
import { TOOLS } from "./registry.js";

export const VERSION = "0.1.0";

/** Sent to the client at initialization; clients place it in the model's context. */
export const INSTRUCTIONS = `Vertskim is a live knowledge graph of this project: every file, symbol and doc section, and how they relate (imports, calls, references, inheritance, tests, doc links).
Prefer it over reading or grepping files to find, understand, or assess code:
- New to the project or a directory -> graph_overview
- Starting a task -> graph_context (the most relevant code within a token budget)
- "Where is X?" -> graph_search, then graph_node for its signature, outline or source
- "What is in this file, class or directory?" -> graph_node (returns an outline, not the contents)
- "Who uses X / what does X use?" -> graph_neighbors
- Before changing, renaming or deleting something -> graph_impact
- "How does A reach B?" -> graph_path
- The user wants to see the project as a picture -> graph_open_ui
- Learned something a later session should know (a decision and why, a trap, unfinished work) -> graph_annotate. Notes are shown with their node from then on.
Node ids look like \`src/auth/session.ts\` (file), \`src/auth/\` (directory), \`src/auth/session.ts#SessionStore.refresh\` (symbol) or \`docs/guide.md#install\` (doc section). Pass them between tools.
Results are ranked and trimmed to max_tokens. Edges marked ~ are name-based guesses; confirm in source before relying on them. The graph follows file changes on its own; graph_sync is only for when results look out of date.`;

/** Services outside the MCP layer that tools can reach. */
export interface ServerHooks {
  /** Called with the nodes each tool call was about. Must not throw or block. */
  onTrace?(tool: string, ids: string[]): void;
  /** Start or find the visualizer and return its page link. */
  openUi?(focus?: string): Promise<string>;
}

export interface ServeOptions {
  root: string;
  dataDir?: string;
  /** Set up services that live as long as the project is open, such as the visualizer. */
  attach?(project: Project, log: (message: string) => void): { hooks: ServerHooks; close(): Promise<void> };
}

export function createServer(project: Project, hooks: ServerHooks = {}): McpServer {
  const server = new McpServer({ name: "vertskim", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    const context: ToolContext = {
      trace: (ids) => {
        try {
          hooks.onTrace?.(tool.name, ids);
        } catch {
          // showing activity is a nicety; it never gets in the way of an answer
        }
      },
      openUi: hooks.openUi,
      author: () => server.server.getClientVersion()?.name ?? null,
    };
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          // A tool that syncs does its own; everything else first makes sure the graph is current.
          if (tool.readOnly) await project.refresh(tool.ids(args));
          return { content: [{ type: "text" as const, text: await tool.run(project, args, context) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `${tool.name} failed: ${(err as Error).message}` }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

/**
 * Serve the project over stdio. stdout carries the protocol, so every
 * diagnostic goes to stderr.
 */
export async function serveStdio(options: ServeOptions): Promise<void> {
  const log = (message: string) => process.stderr.write(`[vertskim] ${message}\n`);
  const project = Project.open({ root: options.root, dataDir: options.dataDir, log });
  const attached = options.attach?.(project, log);
  const server = createServer(project, attached?.hooks);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Give the watcher and any sync in flight a moment to finish, but never hang.
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    Promise.resolve(attached?.close())
      .catch(() => undefined)
      .then(() => project.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  transport.onclose = shutdown;
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);

  await server.connect(transport);
  log(`serving ${project.root} (data in ${project.dataDir})`);
  // Watch first, so nothing that changes during the initial index is missed; index in the
  // background so initialization is never held up.
  const watching = await project.watch();
  if (watching) log("watching for file changes");
  project.sync({ full: true }).catch(() => undefined);
}
