import { useMemo, useState } from "react";
import { highlight } from "../highlight";
import { hoverProps } from "../hover";
import { EDGE_COLORS, EDGE_PHRASES, KIND_COLORS, kindName } from "../theme";
import type { GraphNode, NodePayload, NoteView, OutlineEntry, SourcePayload, ViewNode } from "../types";
import { IconButton } from "./Glyph";
import { NodeIcon } from "./NodeIcon";
import { Pane } from "./Pane";

export interface InspectorProps {
  id: string;
  details: NodePayload | null;
  source: SourcePayload | null;
  /** The selected node as drawn, when it is in the picture. */
  drawn: ViewNode | null;
  onClose(): void;
  onGoTo(id: string): void;
  onToggle(id: string): void;
  onFly(): void;
  onAddNote(text: string): Promise<unknown>;
  onRemoveNote(note: number): Promise<unknown>;
}

const MAX_NOTE_LENGTH = 1200;

/** What has been written about the node, and a box to add to it. */
function Notes({
  notes,
  onAdd,
  onRemove,
}: {
  notes: NoteView[];
  onAdd(text: string): Promise<unknown>;
  onRemove(note: number): Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (action: Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setError(null);
    action
      .then(() => done?.())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Pane title="Notes" count={notes.length > 0 ? notes.length : undefined}>
      <div className="view-pad">
        {notes.length > 0 && (
          <ul className="notes">
            {notes.map((note) => (
              <li key={note.id}>
                <p>{note.text}</p>
                <p className="note-meta">
                  {new Date(note.createdAt).toLocaleDateString()}
                  {note.author ? ` · ${note.author}` : ""}
                  {note.stale && <span className="stale"> · the code has changed since</span>}
                  <button type="button" className="link" disabled={busy} onClick={() => run(onRemove(note.id))}>
                    Remove
                  </button>
                </p>
              </li>
            ))}
          </ul>
        )}
        <form
          className="note-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) run(onAdd(draft), () => setDraft(""));
          }}
        >
          <label className="visually-hidden" htmlFor="note-draft">
            Add a note about this node
          </label>
          <textarea
            id="note-draft"
            className="field"
            rows={2}
            maxLength={MAX_NOTE_LENGTH}
            placeholder="A decision, a trap, why it is this way…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="cta" disabled={busy || draft.trim() === ""}>
            Add note
          </button>
        </form>
        {error && <p className="hint">{error}</p>}
        <p className="fine-print">Kept outside the project; your assistant sees it whenever this node comes up.</p>
      </div>
    </Pane>
  );
}

const LANGUAGES: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  python: "Python",
  markdown: "Markdown",
  go: "Go",
  rust: "Rust",
  java: "Java",
  csharp: "C#",
  c: "C",
  cpp: "C++",
  ruby: "Ruby",
  php: "PHP",
  luau: "Luau",
  lua: "Lua",
};

export function languageName(language: string | null | undefined): string | null {
  return language ? (LANGUAGES[language] ?? language) : null;
}

function facts(node: GraphNode, fileLines: number | null): string[] {
  const out: string[] = [];
  if (node.language && node.kind !== "section") out.push(LANGUAGES[node.language] ?? node.language);
  if (node.kind === "file" && fileLines) out.push(`${fileLines.toLocaleString()} lines`);
  else if (node.startLine && node.kind !== "file") {
    out.push(
      node.endLine && node.endLine !== node.startLine
        ? `lines ${node.startLine}–${node.endLine}`
        : `line ${node.startLine}`,
    );
  }
  if (node.exported === 2) out.push("default export");
  else if (node.exported === 1) out.push("exported");
  return out;
}

/** A related node: its icon and its own name, with the file dimmed beside it. */
function NodeLink({ node, onGoTo, guess }: { node: GraphNode; onGoTo(id: string): void; guess?: boolean }) {
  const hash = node.id.indexOf("#");
  const primary = hash >= 0 ? node.id.slice(hash + 1) : node.kind === "external" ? node.name : node.id;
  const secondary = hash >= 0 ? node.path : kindName(node);
  return (
    <button
      type="button"
      className="node-link"
      onClick={() => onGoTo(node.id)}
      title={node.id}
      {...hoverProps(node.id)}
    >
      <NodeIcon node={node} />
      <span className="primary">{primary}</span>
      <span className="secondary">{secondary}</span>
      {guess && (
        <span className="tag warn" title="Matched by name only; check the source">
          guess
        </span>
      )}
    </button>
  );
}

function Outline({
  entries,
  onGoTo,
  depth = 0,
}: {
  entries: OutlineEntry[];
  onGoTo(id: string): void;
  depth?: number;
}) {
  return (
    <ul className={depth === 0 ? "outline" : "outline nested"}>
      {entries.map((entry) => (
        <li key={entry.node.id}>
          <button
            type="button"
            className="node-link"
            onClick={() => onGoTo(entry.node.id)}
            title={entry.node.id}
            {...hoverProps(entry.node.id)}
          >
            <NodeIcon node={entry.node} />
            <span className="primary">{entry.node.signature ?? entry.node.name}</span>
          </button>
          {entry.children.length > 0 && <Outline entries={entry.children} onGoTo={onGoTo} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

/** The node's own lines, numbered and tinted as an editor would show them. */
function Source({ source, language }: { source: SourcePayload; language: string | null | undefined }) {
  const text = source.text ?? "";
  const lines = useMemo(() => highlight(text, language), [text, language]);
  const first = source.startLine ?? 1;
  return (
    <Pane title="Source" count={`${source.path}:${first}`}>
      <pre className="source">
        {lines.map((tokens, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: these are the lines of one source slice; a line's number is what it is
          <span key={first + index} className="src-line">
            <span className="ln">{first + index}</span>
            {tokens.map((token, at) =>
              token.type === "plain" ? (
                token.text
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line never reorder
                <span key={at} className={`tok-${token.type}`}>
                  {token.text}
                </span>
              ),
            )}
          </span>
        ))}
      </pre>
      {source.truncated && <p className="pane-empty">Showing the first {lines.length} lines.</p>}
    </Pane>
  );
}

export function Inspector(props: InspectorProps) {
  const { details, source, drawn } = props;
  const [copied, setCopied] = useState(false);
  const node = details?.node ?? null;

  const copy = () => {
    void navigator.clipboard?.writeText(props.id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const nodeFacts = node ? facts(node, details?.file?.lines ?? null) : [];

  return (
    <aside className="inspector" aria-label="Selected node">
      <header className="inspector-header">
        <h2 className="view-title">Inspector</h2>
        <div className="header-actions">
          <IconButton icon="target" label="Fly here" onClick={props.onFly} />
          {drawn?.container && (
            <IconButton
              icon={drawn.expanded ? "fold" : "unfold"}
              label={drawn.expanded ? "Close this group in the graph" : "Open this group in the graph"}
              onClick={() => props.onToggle(props.id)}
            />
          )}
          <IconButton
            icon={copied ? "check" : "copy"}
            label={copied ? "Copied" : "Copy the node's id"}
            onClick={copy}
          />
          <IconButton icon="close" label="Close the inspector" onClick={props.onClose} />
        </div>
      </header>

      <div className="inspector-scroll">
        <div className="hero">
          <span className="hero-icon">
            <NodeIcon node={node ?? { id: props.id }} open={drawn?.expanded} size={28} />
          </span>
          <div className="hero-text">
            <h3>{node ? (node.kind === "directory" && node.id === "./" ? "Project root" : node.name) : "Loading…"}</h3>
            {node && (
              <p className="hero-facts">
                <span className="chip" style={{ color: KIND_COLORS[node.kind] }}>
                  {kindName(node)}
                </span>
                {nodeFacts.join(" · ")}
              </p>
            )}
          </div>
        </div>

        <div className="id-row">
          <code title={props.id}>{props.id}</code>
        </div>

        {node && (
          <>
            {node.signature && node.kind !== "section" && <pre className="signature">{node.signature}</pre>}
            {node.doc && <p className="doc">{node.doc}</p>}

            {details && node.kind !== "external" && (
              <Notes key={props.id} notes={details.notes ?? []} onAdd={props.onAddNote} onRemove={props.onRemoveNote} />
            )}

            {details && details.outline.length > 0 && (
              <Pane title={node.kind === "directory" ? "Contains" : "Outline"} count={details.outline.length}>
                <Outline entries={details.outline.slice(0, 80)} onGoTo={props.onGoTo} />
                {details.outline.length > 80 && <p className="pane-empty">…and {details.outline.length - 80} more</p>}
              </Pane>
            )}

            {details?.edges.map((group) => (
              <Pane
                key={`${group.direction}:${group.kind}`}
                title={EDGE_PHRASES[group.kind][group.direction]}
                count={group.count}
                className="edge-pane"
              >
                <ul className="related" style={{ borderColor: EDGE_COLORS[group.kind] }}>
                  {group.top.map((item) => (
                    <li key={item.node.id}>
                      <NodeLink node={item.node} onGoTo={props.onGoTo} guess={item.confidence === "heuristic"} />
                    </li>
                  ))}
                </ul>
                {group.count > group.top.length && (
                  <p className="pane-empty">…and {group.count - group.top.length} more</p>
                )}
              </Pane>
            ))}
            {details && details.edges.length === 0 && details.outline.length === 0 && (
              <p className="pane-empty">Nothing in the graph refers to this, and it refers to nothing.</p>
            )}

            {source?.available && source.text !== undefined && <Source source={source} language={node.language} />}
          </>
        )}
      </div>
    </aside>
  );
}
