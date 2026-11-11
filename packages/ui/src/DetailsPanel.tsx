import { useState } from "react";
import { EDGE_PHRASES, KIND_COLORS, kindName } from "./theme";
import type { GraphNode, NodePayload, NoteView, OutlineEntry, SourcePayload, ViewNode } from "./types";

export interface DetailsPanelProps {
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
function Notes({ notes, onAdd, onRemove }: { notes: NoteView[]; onAdd(text: string): Promise<unknown>; onRemove(note: number): Promise<unknown> }) {
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
    <section>
      <h3>
        Notes {notes.length > 0 && <span className="count">{notes.length}</span>}
      </h3>
      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((note) => (
            <li key={note.id}>
              <p>{note.text}</p>
              <p className="note-meta">
                {new Date(note.createdAt).toLocaleDateString()}
                {note.author ? ` · ${note.author}` : ""}
                {note.stale && <span className="stale"> · the code has changed since</span>}
                <button type="button" className="ghost" disabled={busy} onClick={() => run(onRemove(note.id))}>
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
          rows={2}
          maxLength={MAX_NOTE_LENGTH}
          placeholder="A decision, a trap, why it is this way…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          Add note
        </button>
      </form>
      {error && <p className="hint">{error}</p>}
      <p className="muted small">Kept outside the project; your assistant sees it whenever this node comes up.</p>
    </section>
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
};

function facts(node: GraphNode, fileLines: number | null): string[] {
  const out: string[] = [];
  if (node.language && node.kind !== "section") out.push(LANGUAGES[node.language] ?? node.language);
  if (node.kind === "file" && fileLines) out.push(`${fileLines.toLocaleString()} lines`);
  else if (node.startLine && node.kind !== "file") {
    out.push(node.endLine && node.endLine !== node.startLine ? `lines ${node.startLine}–${node.endLine}` : `line ${node.startLine}`);
  }
  if (node.exported === 2) out.push("default export");
  else if (node.exported === 1) out.push("exported");
  return out;
}

/** Name to show for a related node: its own name, with the file dimmed beside it. */
function NodeLink({ node, onGoTo, guess }: { node: GraphNode; onGoTo(id: string): void; guess?: boolean }) {
  const hash = node.id.indexOf("#");
  const primary = hash >= 0 ? node.id.slice(hash + 1) : node.kind === "external" ? node.name : node.id;
  const secondary = hash >= 0 ? node.path : kindName(node);
  return (
    <button type="button" className="node-link" onClick={() => onGoTo(node.id)} title={node.id}>
      <span className="dot" style={{ background: KIND_COLORS[node.kind] }} />
      <span className="primary">{primary}</span>
      <span className="secondary">{secondary}</span>
      {guess && (
        <span className="guess" title="Matched by name only; check the source">
          guess
        </span>
      )}
    </button>
  );
}

function Outline({ entries, onGoTo, depth = 0 }: { entries: OutlineEntry[]; onGoTo(id: string): void; depth?: number }) {
  return (
    <ul className={depth === 0 ? "outline" : "outline nested"}>
      {entries.map((entry) => (
        <li key={entry.node.id}>
          <button type="button" onClick={() => onGoTo(entry.node.id)} title={entry.node.id}>
            <span className="dot" style={{ background: KIND_COLORS[entry.node.kind] }} />
            <code>{entry.node.signature ?? entry.node.name}</code>
          </button>
          {entry.children.length > 0 && <Outline entries={entry.children} onGoTo={onGoTo} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function DetailsPanel(props: DetailsPanelProps) {
  const { details, source, drawn } = props;
  const [copied, setCopied] = useState(false);
  const node = details?.node ?? null;

  const copy = () => {
    void navigator.clipboard?.writeText(props.id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <aside className="details panel" aria-label="Selected node">
      <header>
        <div className="title">
          {node && (
            <span className="chip" style={{ color: KIND_COLORS[node.kind], borderColor: KIND_COLORS[node.kind] }}>
              {kindName(node)}
            </span>
          )}
          <h2>{node ? (node.kind === "directory" && node.id === "./" ? "Project root" : node.name) : "Loading…"}</h2>
        </div>
        <button type="button" className="ghost" onClick={props.onClose} aria-label="Close details">
          Close
        </button>
      </header>

      <div className="id-row">
        <code title={props.id}>{props.id}</code>
        <button type="button" className="ghost" onClick={copy}>
          {copied ? "Copied" : "Copy id"}
        </button>
      </div>

      {node && (
        <>
          {facts(node, details?.file?.lines ?? null).length > 0 && (
            <p className="muted">{facts(node, details?.file?.lines ?? null).join(" · ")}</p>
          )}
          {node.signature && node.kind !== "section" && <pre className="signature">{node.signature}</pre>}
          {node.doc && <p className="doc">{node.doc}</p>}

          <div className="buttons">
            {drawn?.container && (
              <button type="button" onClick={() => props.onToggle(props.id)}>
                {drawn.expanded ? "Close group" : "Open group"}
              </button>
            )}
            <button type="button" onClick={props.onFly}>
              Fly here
            </button>
          </div>

          {details && node.kind !== "external" && (
            <Notes key={props.id} notes={details.notes ?? []} onAdd={props.onAddNote} onRemove={props.onRemoveNote} />
          )}

          {details && details.outline.length > 0 && (
            <section>
              <h3>{node.kind === "directory" ? "Contains" : "Outline"}</h3>
              <Outline entries={details.outline.slice(0, 80)} onGoTo={props.onGoTo} />
              {details.outline.length > 80 && <p className="muted">…and {details.outline.length - 80} more</p>}
            </section>
          )}

          {details?.edges.map((group) => (
            <section key={`${group.direction}:${group.kind}`}>
              <h3>
                {EDGE_PHRASES[group.kind][group.direction]} <span className="count">{group.count}</span>
              </h3>
              <ul className="related">
                {group.top.map((item) => (
                  <li key={item.node.id}>
                    <NodeLink node={item.node} onGoTo={props.onGoTo} guess={item.confidence === "heuristic"} />
                  </li>
                ))}
              </ul>
              {group.count > group.top.length && (
                <p className="muted">…and {group.count - group.top.length} more</p>
              )}
            </section>
          ))}
          {details && details.edges.length === 0 && details.outline.length === 0 && (
            <p className="muted">Nothing in the graph refers to this, and it refers to nothing.</p>
          )}

          {source?.available && source.text !== undefined && (
            <section>
              <h3>
                Source{" "}
                <span className="count">
                  {source.path}:{source.startLine}
                </span>
              </h3>
              <pre className="source">
                {source.text.split("\n").map((line, index) => (
                  <span key={index} className="src-line">
                    <span className="ln">{(source.startLine ?? 1) + index}</span>
                    {line}
                    {"\n"}
                  </span>
                ))}
              </pre>
              {source.truncated && <p className="muted">Showing the first {source.text.split("\n").length} lines.</p>}
            </section>
          )}
        </>
      )}
    </aside>
  );
}
