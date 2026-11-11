import { useEffect, useMemo, useState } from "react";
import type { Api } from "./api";
import {
  EDGE_COLORS,
  EDGE_LABELS,
  EDGE_ORDER,
  folderColors,
  KIND_COLORS,
  KIND_LABELS,
  KIND_ORDER,
  kindName,
} from "./theme";
import type { ColorBy, ControlType, GraphNode, GraphView, NoteView, ServerStatus, TrailEvent } from "./types";

export interface SidebarProps {
  api: Api;
  status: ServerStatus | null;
  view: GraphView | null;
  live: boolean;
  problem: string | null;
  hiddenNodeKinds: ReadonlySet<string>;
  hiddenEdgeKinds: ReadonlySet<string>;
  colorBy: ColorBy;
  controlType: ControlType;
  autoOpen: boolean;
  trail: TrailEvent[];
  /** Newest first. */
  notes: NoteView[];
  onHiddenNodeKinds(next: ReadonlySet<string>): void;
  onHiddenEdgeKinds(next: ReadonlySet<string>): void;
  onColorBy(next: ColorBy): void;
  onControlType(next: ControlType): void;
  onAutoOpen(next: boolean): void;
  onGoTo(id: string): void;
  onReset(mode: "default" | "collapsed"): void;
  onFit(): void;
}

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

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function ago(at: number, now: number): string {
  const seconds = Math.max(Math.round((now - at) / 1000), 0);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function shortId(id: string): string {
  const hash = id.indexOf("#");
  if (hash >= 0) return id.slice(hash + 1);
  const trimmed = id.endsWith("/") ? id.slice(0, -1) : id;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) + (id.endsWith("/") ? "/" : "");
}

function Search({ api, onGoTo }: { api: Api; onGoTo(id: string): void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GraphNode[] | null>(null);
  const [partial, setPartial] = useState(false);

  useEffect(() => {
    const text = query.trim();
    if (text === "") {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .search(text)
        .then((result) => {
          if (cancelled) return;
          setHits(result.hits.map((h) => h.node));
          setPartial(result.partial);
        })
        .catch(() => !cancelled && setHits([]));
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, query]);

  const choose = (id: string) => {
    onGoTo(id);
    setQuery("");
  };

  return (
    <div className="search">
      <label className="visually-hidden" htmlFor="search">
        Search the graph
      </label>
      <input
        id="search"
        type="search"
        placeholder="Search files and symbols"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits?.[0]) choose(hits[0].id);
          if (e.key === "Escape") {
            setQuery("");
            e.currentTarget.blur();
          }
        }}
      />
      <kbd aria-hidden="true">/</kbd>
      {hits && (
        <ul className="results">
          {hits.length === 0 && <li className="empty">Nothing matches “{query.trim()}”.</li>}
          {partial && hits.length > 0 && <li className="empty">No match for every word. Closest:</li>}
          {hits.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => choose(node.id)} title={node.id}>
                <span className="dot" style={{ background: KIND_COLORS[node.kind] }} />
                <span className="primary">{node.kind === "directory" ? node.id : shortId(node.id)}</span>
                <span className="secondary">
                  {kindName(node)}
                  {node.path && node.kind !== "directory" && node.kind !== "file" ? ` · ${node.path}` : ""}
                  {node.kind === "file" ? ` · ${node.path}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { status, view } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

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

  let state = "Live";
  let stateClass = "ok";
  if (props.problem) {
    state = "Cannot reach the server";
    stateClass = "bad";
  } else if (!props.live) {
    state = "Reconnecting…";
    stateClass = "warn";
  } else if (status?.state === "indexing") {
    state = `Indexing ${Math.round(status.progress * 100)}%`;
    stateClass = "warn";
  } else if (status && !status.watching) {
    state = "Not watching for changes";
    stateClass = "warn";
  }

  if (collapsed) {
    return (
      <button type="button" className="panel-toggle" onClick={() => setCollapsed(false)}>
        Show panel
      </button>
    );
  }

  return (
    <aside className="sidebar panel" aria-label="Graph controls">
      <header>
        <div>
          <h1>{status?.name ?? "Vertskim"}</h1>
          <p className="muted">
            {status ? `${status.files.toLocaleString()} files · ${status.nodes.toLocaleString()} nodes` : " "}
          </p>
        </div>
        <button type="button" className="ghost" onClick={() => setCollapsed(true)} title="Hide this panel">
          Hide
        </button>
      </header>
      <p className={`state ${stateClass}`} role="status">
        <span className="pulse" />
        {state}
      </p>

      <Search api={props.api} onGoTo={props.onGoTo} />

      <section>
        <h2>View</h2>
        <div className="row">
          <span>Colour by</span>
          <div className="segmented" role="group" aria-label="Colour by">
            {(["kind", "folder"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={props.colorBy === value}
                onClick={() => props.onColorBy(value)}
              >
                {value === "kind" ? "Kind" : "Folder"}
              </button>
            ))}
          </div>
        </div>
        <div className="row">
          <span>Camera</span>
          <div className="segmented" role="group" aria-label="Camera">
            {(["orbit", "fly"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={props.controlType === value}
                onClick={() => props.onControlType(value)}
                title={value === "orbit" ? "Drag to rotate, scroll to zoom" : "W A S D to move, drag to look"}
              >
                {value === "orbit" ? "Orbit" : "Fly"}
              </button>
            ))}
          </div>
        </div>
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
      </section>

      {props.colorBy === "folder" && areas.length > 0 && (
        <section>
          <h2>Areas</h2>
          <ul className="areas">
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
                    <div className="area">{row}</div>
                  ) : (
                    <button type="button" className="area" onClick={() => props.onGoTo(area.id)} title="Fly to this directory">
                      {row}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h2>Nodes</h2>
        <ul className="legend">
          {KIND_ORDER.filter((kind) => nodeCounts.has(kind)).map((kind) => (
            <li key={kind}>
              <label>
                <input
                  type="checkbox"
                  checked={!props.hiddenNodeKinds.has(kind)}
                  onChange={() => props.onHiddenNodeKinds(toggled(props.hiddenNodeKinds, kind))}
                />
                <span className="dot" style={{ background: props.colorBy === "kind" ? KIND_COLORS[kind] : "#8a93a6" }} />
                <span className="name">{KIND_LABELS[kind]}</span>
                <span className="count">{nodeCounts.get(kind)}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Relationships</h2>
        <ul className="legend">
          {EDGE_ORDER.filter((kind) => edgeCounts.has(kind)).map((kind) => (
            <li key={kind}>
              <label>
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
      </section>

      <section>
        <h2>
          Notes {props.notes.length > 0 && <span className="count">{props.notes.length}</span>}
        </h2>
        {props.notes.length === 0 ? (
          <p className="muted">
            What your assistant, or you, write about a node is kept here for later sessions. Select a node to add a
            note.
          </p>
        ) : (
          <ul className="activity">
            {props.notes.slice(0, 8).map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => !note.orphaned && props.onGoTo(note.nodeId)}
                  disabled={note.orphaned}
                  title={note.orphaned ? `${note.nodeId} no longer exists` : note.nodeId}
                >
                  <span className="primary">
                    <b>{shortId(note.nodeId)}</b>
                    {note.orphaned ? " (gone)" : note.stale ? " (code changed since)" : ""}
                  </span>
                  <span className="secondary note-preview">{note.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Assistant activity</h2>
        {props.trail.length === 0 ? (
          <p className="muted">Nodes your assistant queries light up here and in the graph.</p>
        ) : (
          <ul className="activity">
            {props.trail.slice(0, 12).map((event) => (
              <li key={`${event.at}:${event.tool}:${event.ids[0]}`}>
                <button type="button" onClick={() => props.onGoTo(event.ids[0]!)} title={event.ids.join("\n")}>
                  <span className="primary">
                    {TOOL_NAMES[event.tool] ?? event.tool} <b>{shortId(event.ids[0]!)}</b>
                    {event.ids.length > 1 ? ` +${event.ids.length - 1}` : ""}
                  </span>
                  <span className="secondary">{ago(event.at, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
