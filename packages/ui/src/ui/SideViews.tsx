import { useEffect, useMemo, useState } from "react";
import type { Api } from "../api";
import { hoverProps } from "../hover";
import { shortId } from "../ids";
import { EDGE_COLORS, EDGE_LABELS, EDGE_ORDER, folderColors, KIND_COLORS, KIND_LABELS, KIND_ORDER } from "../theme";
import type { ColorBy, ControlType, GraphView, NoteView, TrailEvent } from "../types";
import { Glyph } from "./Glyph";
import { NodeIcon } from "./NodeIcon";
import { Pane } from "./Pane";
import { HitRow, useSearch } from "./search";

// ------------------------------------------------------------------ search

/** Search with the answers kept on show, to go through them one after another. */
export function SearchView({ api, onGoTo }: { api: Api; onGoTo(id: string): void }) {
  const [query, setQuery] = useState("");
  const { hits, partial } = useSearch(api, query, 40);
  return (
    <div className="view search-view">
      <h2 className="view-title">Search</h2>
      <div className="view-pad">
        <label className="visually-hidden" htmlFor="side-search">
          Search files and symbols
        </label>
        <input
          id="side-search"
          className="field"
          type="search"
          placeholder="Search files and symbols"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="view-scroll">
        {hits === null ? (
          <p className="pane-empty">
            Type a name, or a few words about what the code does. Answers marked ≈ were found by meaning.
          </p>
        ) : hits.length === 0 ? (
          <p className="pane-empty">Nothing matches “{query.trim()}”.</p>
        ) : (
          <>
            <p className="pane-empty">
              {partial
                ? "No match for every word. Closest:"
                : `${hits.length} ${hits.length === 1 ? "result" : "results"}`}
            </p>
            <ul className="hits">
              {hits.map((node) => (
                <li key={node.id}>
                  <HitRow node={node} onChoose={onGoTo} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- graph

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange(value: T): void;
}) {
  return (
    <div className="setting">
      <span>{props.label}</span>
      <fieldset className="segmented" aria-label={props.label}>
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={props.value === option.value}
            title={option.title}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

export interface GraphViewProps {
  view: GraphView | null;
  hiddenNodeKinds: ReadonlySet<string>;
  hiddenEdgeKinds: ReadonlySet<string>;
  colorBy: ColorBy;
  controlType: ControlType;
  autoOpen: boolean;
  glow: boolean;
  onHiddenNodeKinds(next: ReadonlySet<string>): void;
  onHiddenEdgeKinds(next: ReadonlySet<string>): void;
  onColorBy(next: ColorBy): void;
  onControlType(next: ControlType): void;
  onAutoOpen(next: boolean): void;
  onGlow(next: boolean): void;
  onGoTo(id: string): void;
  onReset(mode: "default" | "collapsed"): void;
  onFit(): void;
}

/** What the scene draws and how: its colours, its camera, and which kinds of thing are shown. */
export function GraphSettings(props: GraphViewProps) {
  const { view } = props;
  const nodeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of view?.nodes ?? []) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    return counts;
  }, [view]);
  const edgeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of view?.links ?? []) counts.set(link.kind, (counts.get(link.kind) ?? 0) + 1);
    return counts;
  }, [view]);
  const areas = useMemo(() => {
    const nodes = view?.nodes ?? [];
    const counts = new Map<string, number>();
    for (const node of nodes) counts.set(node.group, (counts.get(node.group) ?? 0) + 1);
    return [...folderColors(nodes)].map(([id, color]) => ({ id, color, count: counts.get(id) ?? 0 }));
  }, [view]);

  return (
    <div className="view graph-view">
      <h2 className="view-title">Graph</h2>
      <div className="view-scroll">
        <Pane title="View">
          <div className="view-pad">
            <Segmented
              label="Colour by"
              value={props.colorBy}
              onChange={props.onColorBy}
              options={[
                { value: "kind", label: "Kind" },
                { value: "folder", label: "Folder" },
              ]}
            />
            <Segmented
              label="Camera"
              value={props.controlType}
              onChange={props.onControlType}
              options={[
                { value: "orbit", label: "Orbit", title: "Drag to rotate, scroll to zoom" },
                { value: "fly", label: "Fly", title: "W A S D to move, drag to look" },
              ]}
            />
            <label className="check">
              <input type="checkbox" checked={props.glow} onChange={(e) => props.onGlow(e.target.checked)} />
              Glow
            </label>
            <label className="check">
              <input type="checkbox" checked={props.autoOpen} onChange={(e) => props.onAutoOpen(e.target.checked)} />
              Open groups as I fly into them
            </label>
            <div className="buttons">
              <button type="button" onClick={props.onFit}>
                Fit to screen
              </button>
              <button type="button" onClick={() => props.onReset("default")}>
                Reset
              </button>
              <button type="button" onClick={() => props.onReset("collapsed")}>
                Close all
              </button>
            </div>
            {view?.truncated && (
              <p className="hint">Too much to draw at once. Close some groups, or hide a relationship below.</p>
            )}
          </div>
        </Pane>

        {props.colorBy === "folder" && areas.length > 0 && (
          <Pane title="Areas" count={areas.length}>
            <ul className="legend">
              {areas.map((area) => {
                const label = area.id === "./" ? "project root" : area.id === "ext:" ? "external modules" : area.id;
                const row = (
                  <>
                    <span className="dot" style={{ background: area.color }} />
                    <span className="name">{label}</span>
                    <span className="count">{area.count}</span>
                  </>
                );
                return (
                  <li key={area.id}>
                    {area.id === "./" || area.id === "ext:" ? (
                      <div className="legend-row">{row}</div>
                    ) : (
                      <button
                        type="button"
                        className="legend-row"
                        onClick={() => props.onGoTo(area.id)}
                        title="Fly to this directory"
                        {...hoverProps(area.id)}
                      >
                        {row}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Pane>
        )}

        <Pane title="Nodes">
          <ul className="legend">
            {KIND_ORDER.filter((kind) => nodeCounts.has(kind)).map((kind) => (
              <li key={kind}>
                <label className="legend-row">
                  <input
                    type="checkbox"
                    checked={!props.hiddenNodeKinds.has(kind)}
                    onChange={() => props.onHiddenNodeKinds(toggled(props.hiddenNodeKinds, kind))}
                  />
                  {/* The shape is the node's own in the scene; its colour only means something when colouring by kind. */}
                  <span
                    className={`shape shape-${kind}`}
                    style={{ color: props.colorBy === "kind" ? KIND_COLORS[kind] : "var(--fg-faint)" }}
                  />
                  <span className="name">{KIND_LABELS[kind]}</span>
                  <span className="count">{nodeCounts.get(kind)}</span>
                </label>
              </li>
            ))}
          </ul>
        </Pane>

        <Pane title="Relationships">
          <ul className="legend">
            {EDGE_ORDER.filter((kind) => edgeCounts.has(kind)).map((kind) => (
              <li key={kind}>
                <label className="legend-row">
                  <input
                    type="checkbox"
                    checked={!props.hiddenEdgeKinds.has(kind)}
                    onChange={() => props.onHiddenEdgeKinds(toggled(props.hiddenEdgeKinds, kind))}
                  />
                  <span className="line" style={{ background: EDGE_COLORS[kind] }} />
                  <span className="name">{EDGE_LABELS[kind]}</span>
                  <span className="count">{edgeCounts.get(kind)}</span>
                </label>
              </li>
            ))}
          </ul>
        </Pane>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- notes

export function NotesView({ notes, onGoTo }: { notes: NoteView[]; onGoTo(id: string): void }) {
  return (
    <div className="view notes-view">
      <h2 className="view-title">Notes {notes.length > 0 && <span className="count">{notes.length}</span>}</h2>
      <div className="view-scroll">
        {notes.length === 0 ? (
          <p className="pane-empty">
            What your assistant, or you, write about a node is kept here for later sessions. Select a node to add a
            note.
          </p>
        ) : (
          <ul className="note-cards">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="note-card"
                  onClick={() => !note.orphaned && onGoTo(note.nodeId)}
                  disabled={note.orphaned}
                  title={note.orphaned ? `${note.nodeId} no longer exists` : note.nodeId}
                  {...hoverProps(note.nodeId)}
                >
                  <span className="card-head">
                    <NodeIcon node={{ id: note.nodeId }} />
                    <b>{shortId(note.nodeId)}</b>
                    {note.orphaned ? (
                      <span className="tag warn">gone</span>
                    ) : note.stale ? (
                      <span className="tag warn">code changed since</span>
                    ) : null}
                  </span>
                  <span className="card-text">{note.text}</span>
                  <span className="card-meta">
                    {new Date(note.createdAt).toLocaleDateString()}
                    {note.author ? ` · ${note.author}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- activity

const TOOL_NAMES: Record<string, string> = {
  graph_search: "searched",
  graph_node: "inspected",
  graph_neighbors: "walked from",
  graph_impact: "checked impact of",
  graph_path: "traced a path through",
  graph_context: "gathered context around",
  graph_overview: "mapped",
  graph_open_ui: "pointed at",
  graph_annotate: "left a note on",
};

function ago(at: number, now: number): string {
  const seconds = Math.max(Math.round((now - at) / 1000), 0);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** What the assistant has been asking the graph, newest first. */
export function ActivityView({ trail, onGoTo }: { trail: TrailEvent[]; onGoTo(id: string): void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="view activity-view">
      <h2 className="view-title">Assistant activity</h2>
      <div className="view-scroll">
        {trail.length === 0 ? (
          <p className="pane-empty">Nodes your assistant queries light up here and in the graph.</p>
        ) : (
          <ol className="timeline">
            {trail.map((event) => (
              <li key={`${event.at}:${event.tool}:${event.ids[0]}`}>
                <button
                  type="button"
                  className="event"
                  onClick={() => onGoTo(event.ids[0]!)}
                  title={event.ids.join("\n")}
                  {...hoverProps(event.ids[0]!)}
                >
                  <span className="event-dot">
                    <Glyph name="broadcast" size={12} />
                  </span>
                  <span className="event-what">
                    {TOOL_NAMES[event.tool] ?? event.tool} <b>{shortId(event.ids[0]!)}</b>
                    {event.ids.length > 1 ? ` +${event.ids.length - 1}` : ""}
                  </span>
                  <span className="event-when">{ago(event.at, now)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
