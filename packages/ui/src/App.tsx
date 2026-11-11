import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Api, AuthError } from "./api";
import { DetailsPanel } from "./DetailsPanel";
import { GraphCanvas } from "./GraphCanvas";
import { Sidebar } from "./Sidebar";
import type {
  ColorBy,
  ControlType,
  GraphView,
  NodePayload,
  NoteView,
  ServerStatus,
  SourcePayload,
  TrailEvent,
} from "./types";

const TRAIL_GLOW_MS = 12_000;
const FRESH_GLOW_MS = 6_000;
const TRAIL_KEPT = 30;

/**
 * The node standing in for `id` in the current picture: the node itself, or
 * the nearest group around it that is drawn. Ids nest (`dir/file.ts#Class.method`),
 * so the answer comes from trimming the id rather than asking the server.
 */
function anchorOf(id: string, drawn: ReadonlySet<string>): string | null {
  let cursor = id;
  for (let guard = 0; guard < 64; guard++) {
    if (drawn.has(cursor)) return cursor;
    const hash = cursor.indexOf("#");
    if (hash >= 0) {
      const dot = cursor.lastIndexOf(".");
      cursor = dot > hash ? cursor.slice(0, dot) : cursor.slice(0, hash);
      continue;
    }
    if (cursor.startsWith("ext:")) {
      if (cursor === "ext:") return null;
      cursor = "ext:";
      continue;
    }
    const trimmed = cursor.endsWith("/") ? cursor.slice(0, -1) : cursor;
    const slash = trimmed.lastIndexOf("/");
    if (slash < 0) return null;
    cursor = trimmed.slice(0, slash + 1);
  }
  return null;
}

function focusFromHash(): string | null {
  const match = /^#focus=(.+)$/.exec(window.location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export function App({ token }: { token: string }) {
  const api = useMemo(() => new Api(token), [token]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [view, setView] = useState<GraphView | null>(null);
  const [live, setLive] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<NodePayload | null>(null);
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);

  const [hiddenNodeKinds, setHiddenNodeKinds] = useState<ReadonlySet<string>>(new Set());
  const [hiddenEdgeKinds, setHiddenEdgeKinds] = useState<ReadonlySet<string>>(new Set());
  // Areas read best from afar; kinds matter once files are open, and are one click away.
  const [colorBy, setColorBy] = useState<ColorBy>("folder");
  const [controlType, setControlType] = useState<ControlType>("orbit");
  const [autoOpen, setAutoOpen] = useState(true);

  const [notes, setNotes] = useState<NoteView[]>([]);
  const [trailLog, setTrailLog] = useState<TrailEvent[]>([]);
  const [trailGlow, setTrailGlow] = useState<ReadonlyMap<string, number>>(new Map());
  const [freshGlow, setFreshGlow] = useState<ReadonlyMap<string, number>>(new Map());

  /** Groups to open; null lets the server pick a readable starting picture. */
  const expanded = useRef<string[] | null>(null);
  const viewRef = useRef<GraphView | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const loading = useRef(0);

  const fail = useCallback((err: unknown) => {
    setProblem(err instanceof AuthError ? "auth" : err instanceof Error ? err.message : String(err));
  }, []);

  const loadView = useCallback(
    async (markFresh = false) => {
      const ticket = ++loading.current;
      try {
        const next = await api.view({ expanded: expanded.current ?? undefined });
        if (ticket !== loading.current) return next; // a newer request has superseded this one
        const previous = viewRef.current;
        expanded.current = next.expanded;
        viewRef.current = next;
        setView(next);
        setProblem(null);
        if (markFresh && previous) {
          const before = new Set(previous.nodes.map((n) => n.id));
          const until = Date.now() + FRESH_GLOW_MS;
          const added = next.nodes.filter((n) => !before.has(n.id)).slice(0, 40);
          if (added.length > 0) setFreshGlow(new Map(added.map((n) => [n.id, until])));
        }
        return next;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [api, fail],
  );

  /** Fetch the list of notes again, and the selected node's own. */
  const loadNotes = useCallback(() => {
    api
      .notes()
      .then((payload) => setNotes(payload.notes))
      .catch(() => undefined);
    const selected = selectedRef.current;
    if (selected) {
      api
        .node(selected)
        .then((payload) => selectedRef.current === selected && setDetails(payload))
        .catch(() => undefined);
    }
  }, [api]);

  const toggle = useCallback(
    (id: string) => {
      const open = new Set(expanded.current ?? viewRef.current?.expanded ?? []);
      if (open.has(id)) open.delete(id);
      else open.add(id);
      expanded.current = [...open];
      void loadView();
    },
    [loadView],
  );

  /** Open whatever hides a node, then select it and fly there. */
  const goTo = useCallback(
    async (id: string) => {
      try {
        const { id: resolved, expand } = await api.reveal(id);
        const open = new Set(expanded.current ?? viewRef.current?.expanded ?? []);
        const missing = expand.filter((group) => !open.has(group));
        if (missing.length > 0 || !viewRef.current?.nodes.some((n) => n.id === resolved)) {
          for (const group of missing) open.add(group);
          expanded.current = [...open];
          const next = await loadView();
          const kind = next?.nodes.find((n) => n.id === resolved)?.kind;
          if (kind) setHiddenNodeKinds((hidden) => (hidden.has(kind) ? new Set([...hidden].filter((k) => k !== kind)) : hidden));
        }
        setSelectedId(resolved);
        // Give the new nodes a moment to be placed before flying to one of them.
        window.setTimeout(() => setFocus({ id: resolved, nonce: Date.now() }), missing.length > 0 ? 350 : 0);
      } catch (err) {
        fail(err);
      }
    },
    [api, fail, loadView],
  );

  const resetView = useCallback(
    (mode: "default" | "collapsed") => {
      expanded.current = mode === "collapsed" ? [] : null;
      // Frame the picture once the new arrangement has had a moment to spread out.
      void loadView().then(() => window.setTimeout(() => setFitNonce((n) => n + 1), 1200));
    },
    [loadView],
  );

  // ---- first load and live updates
  useEffect(() => {
    let cancelled = false;
    void api
      .status()
      .then((s) => !cancelled && setStatus(s))
      .catch(fail);
    loadNotes();
    void loadView().then(() => {
      const wanted = focusFromHash();
      if (wanted && !cancelled) void goTo(wanted);
    });
    const stop = api.events({
      onHello: (s, trail) => {
        setStatus(s);
        setTrailLog(trail.slice(-TRAIL_KEPT).reverse());
        // After a reconnect the graph may have moved on without us.
        if (viewRef.current && viewRef.current.version !== s.version) void loadView(true);
      },
      onChanged: (s) => {
        setStatus(s);
        void loadView(true);
        const selected = selectedRef.current;
        if (selected) {
          api
            .node(selected)
            .then(setDetails)
            .catch(() => {
              setSelectedId(null); // the selected node no longer exists
            });
        }
      },
      onStatus: setStatus,
      onTrail: (event) => {
        setTrailLog((log) => [event, ...log].slice(0, TRAIL_KEPT));
        const drawn = new Set(viewRef.current?.nodes.map((n) => n.id) ?? []);
        const until = Date.now() + TRAIL_GLOW_MS;
        setTrailGlow((glow) => {
          const next = new Map([...glow].filter(([, end]) => end > Date.now()));
          for (const id of event.ids) {
            const anchor = anchorOf(id, drawn);
            if (anchor) next.set(anchor, until);
          }
          return next;
        });
      },
      onFocus: (id) => void goTo(id),
      onNotes: loadNotes,
      onConnection: setLive,
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [api, fail, goTo, loadNotes, loadView]);

  // ---- details for the selection
  useEffect(() => {
    setDetails(null);
    setSource(null);
    if (!selectedId) return;
    let cancelled = false;
    api
      .node(selectedId)
      .then((payload) => {
        if (cancelled) return;
        setDetails(payload);
        if (payload.node.kind !== "directory" && payload.node.kind !== "external") {
          api
            .source(selectedId)
            .then((s) => !cancelled && setSource(s))
            .catch(() => undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) fail(err);
      });
    return () => {
      cancelled = true;
    };
  }, [api, fail, selectedId]);

  // ---- keyboard: "/" to search, Escape to let go of the selection
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#search")?.focus();
      } else if (event.key === "Escape" && !typing) {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (problem === "auth") {
    return (
      <Notice title="This link is no longer valid">
        The visualizer was restarted, so it has a new link. Run <code>vertskim ui</code> again, or ask your
        assistant to open the graph.
      </Notice>
    );
  }

  const selectedNode = selectedId ? (view?.nodes.find((n) => n.id === selectedId) ?? null) : null;

  return (
    <div className="app">
      {view && !unsupported && (
        <GraphCanvas
          view={view}
          hiddenNodeKinds={hiddenNodeKinds}
          hiddenEdgeKinds={hiddenEdgeKinds}
          colorBy={colorBy}
          controlType={controlType}
          autoOpen={autoOpen}
          selectedId={selectedId}
          trail={trailGlow}
          fresh={freshGlow}
          focus={focus}
          fitNonce={fitNonce}
          onSelect={setSelectedId}
          onToggle={toggle}
          onUnsupported={setUnsupported}
        />
      )}
      {unsupported && (
        <Notice title="This browser cannot draw the 3D graph">
          WebGL is unavailable here ({unsupported}). The panels still work: search for a node to read its details.
        </Notice>
      )}
      {!view && !problem && <div className="loading">Loading the graph…</div>}

      <Sidebar
        api={api}
        status={status}
        view={view}
        live={live}
        problem={problem}
        hiddenNodeKinds={hiddenNodeKinds}
        hiddenEdgeKinds={hiddenEdgeKinds}
        colorBy={colorBy}
        controlType={controlType}
        autoOpen={autoOpen}
        trail={trailLog}
        notes={notes}
        onHiddenNodeKinds={setHiddenNodeKinds}
        onHiddenEdgeKinds={setHiddenEdgeKinds}
        onColorBy={setColorBy}
        onControlType={setControlType}
        onAutoOpen={setAutoOpen}
        onGoTo={(id) => void goTo(id)}
        onReset={resetView}
        onFit={() => setFitNonce((n) => n + 1)}
      />

      {selectedId && (
        <DetailsPanel
          id={selectedId}
          details={details}
          source={source}
          drawn={selectedNode}
          onClose={() => setSelectedId(null)}
          onGoTo={(id) => void goTo(id)}
          onToggle={toggle}
          onFly={() => setFocus({ id: selectedId, nonce: Date.now() })}
          onAddNote={(text) => api.addNote(selectedId, text).then(loadNotes)}
          onRemoveNote={(note) => api.removeNote(note).then(loadNotes)}
        />
      )}
    </div>
  );
}

export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="notice" role="alert">
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}
