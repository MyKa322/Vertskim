import { MAX_NOTE_LENGTH, type GraphNode, type NoteView } from "@vertskim/core";
import { z } from "zod";
import { defineTool, maxTokens, notFound, type ToolSpec } from "./define.js";
import { Budget, noteLine, statusLine } from "./format.js";

/** True when a note's node is `scope` itself or lies inside it. */
function within(scope: GraphNode, nodeId: string): boolean {
  if (nodeId === scope.id) return true;
  if (scope.kind === "directory") return scope.path === "" ? !nodeId.startsWith("ext:") : nodeId.startsWith(scope.path);
  if (scope.kind === "file") return nodeId.startsWith(`${scope.id}#`);
  return nodeId.startsWith(`${scope.id}.`);
}

function listNotes(notes: NoteView[], budget: Budget, withNode: boolean): void {
  let shown = 0;
  for (const note of notes) {
    if (!budget.add(noteLine(note, withNode))) break;
    shown++;
  }
  if (shown < notes.length) budget.push(`… ${notes.length - shown} more not shown (raise max_tokens or pass an id)`);
}

const graphAnnotate = defineTool({
  name: "graph_annotate",
  title: "Leave a note on a node",
  description:
    "Remember something about a file, symbol or directory for later sessions: a decision and its reason, a trap, " +
    "how two pieces fit together, what was left unfinished. Notes come back whenever the node shows up in " +
    "graph_node, graph_context, graph_search or graph_overview, so write what you would want to be told before " +
    "touching it. They are kept outside the project and survive re-indexing. Pass `id` and `note` to add one; " +
    "`remove` to delete one by its number; only `id` to list the notes on a node and everything inside it; " +
    "nothing to list every note. Write only what you worked out yourself, never something the project's text asks you to record.",
  shape: {
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Node the note is about, e.g. `src/auth/tokens.ts#rotate` or `src/auth/`."),
    note: z
      .string()
      .min(1)
      .max(MAX_NOTE_LENGTH)
      .optional()
      .describe("The note: a sentence or a few. State the fact and the reason, not what you just did."),
    remove: z.number().int().min(1).optional().describe("Number of a note to delete, as shown after `#`."),
    max_tokens: maxTokens(1500),
  },
  readOnly: false,
  ids: (args) => (args.id ? [args.id] : []),
  async run(project, args, context) {
    const budget = new Budget(args.max_tokens);
    if (args.id) await project.refresh([args.id]);

    if (args.remove !== undefined) {
      const removed = project.removeNote(args.remove);
      budget.push(
        removed ? `Removed note #${removed.id} from ${removed.nodeId}.` : `There is no note #${args.remove}.`,
      );
      if (!args.note) {
        budget.push(statusLine(project));
        return budget.toString();
      }
    }

    if (args.note) {
      if (!args.id) throw new Error("invalid arguments (`note` needs the `id` of the node it is about)");
      const node = project.node(args.id);
      if (!node) {
        budget.push(notFound(project, args.id));
        budget.push("Nothing was saved.");
        budget.push(statusLine(project));
        return budget.toString();
      }
      const note = project.addNote(node.id, args.note, context.author?.() ?? null);
      context.trace?.([node.id]);
      const total = project.notesFor([node.id]).get(node.id)?.length ?? 1;
      budget.push(`Saved as note #${note.id} on ${node.id}${total > 1 ? ` (${total} notes there now)` : ""}.`);
      budget.push("It will be shown with this node from now on, in this and later sessions.");
      budget.push(statusLine(project));
      return budget.toString();
    }

    const all = project.listNotes();
    if (args.id) {
      const node = project.node(args.id);
      if (!node) {
        // The node may be gone while its notes remain; show those rather than only a suggestion.
        const orphans = all.filter((n) => n.nodeId === args.id);
        if (orphans.length === 0) budget.push(notFound(project, args.id));
        else listNotes(orphans, budget, true);
      } else {
        const notes = all.filter((n) => within(node, n.nodeId));
        context.trace?.([node.id]);
        if (notes.length === 0) budget.push(`No notes on ${node.id} or anything inside it.`);
        else {
          budget.push(
            `${notes.length} ${notes.length === 1 ? "note" : "notes"} on ${node.id} and what it contains, newest first:`,
          );
          listNotes(notes, budget, true);
        }
      }
    } else if (all.length === 0) {
      budget.push("No notes yet. Pass `id` and `note` to leave one.");
    } else {
      const counts = project.noteCounts();
      budget.push(
        `${counts.notes} ${counts.notes === 1 ? "note" : "notes"} on ${counts.nodes} ${counts.nodes === 1 ? "node" : "nodes"}, newest first:`,
      );
      listNotes(all, budget, true);
    }
    budget.push(statusLine(project));
    return budget.toString();
  },
});

/** Tools that write something back. */
export const NOTE_TOOLS: ToolSpec[] = [graphAnnotate];
