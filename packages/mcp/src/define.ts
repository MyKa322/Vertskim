import { stripControl, type Project } from "@vertskim/core";
import { z } from "zod";

/** What the surrounding server offers a tool beyond the project itself. All of it is optional. */
export interface ToolContext {
  /** Report the nodes a call was about, so the visualizer can light them up. */
  trace?(ids: string[]): void;
  /** Start or find the visualizer and return its page link. Absent when there is none in this setup. */
  openUi?(focus?: string): Promise<string>;
  /** Name of the client the call came from, recorded on notes it writes. */
  author?(): string | null;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  /** False for tools that change something besides answering: the index, or what is running. */
  readOnly: boolean;
  /** Node ids named in the arguments; their files are checked for fresh edits before the tool runs. */
  ids(args: unknown): string[];
  /** Validates `args` against the shape, runs the query and returns the text shown to the model. */
  run(project: Project, args: unknown, context?: ToolContext): string | Promise<string>;
}

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  shape: S;
  readOnly?: boolean;
  ids?(args: z.infer<z.ZodObject<S>>): string[];
  run(project: Project, args: z.infer<z.ZodObject<S>>, context: ToolContext): string | Promise<string>;
}): ToolSpec {
  const schema = z.object(def.shape);
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    shape: def.shape,
    readOnly: def.readOnly ?? true,
    ids: (args) => {
      const parsed = schema.safeParse(args ?? {});
      return parsed.success && def.ids ? def.ids(parsed.data as z.infer<z.ZodObject<S>>) : [];
    },
    run: (project, args, context = {}) => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);
        throw new Error(`invalid arguments (${problems.join("; ")})`);
      }
      const reply = def.run(project, parsed.data as z.infer<z.ZodObject<S>>, context);
      return typeof reply === "string" ? stripControl(reply) : reply.then(stripControl);
    },
  };
}

export const maxTokens = (fallback: number) =>
  z
    .number()
    .int()
    .min(200)
    .max(20_000)
    .default(fallback)
    .describe(`Approximate size limit for the reply. Default ${fallback}.`);

export function notFound(project: Project, input: string): string {
  const suggestions = project.suggest(input);
  return suggestions.length > 0
    ? `${input}: no such node. Did you mean: ${suggestions.map((n) => n.id).join(", ")}`
    : `${input}: no such node. Use graph_search to find the id.`;
}
