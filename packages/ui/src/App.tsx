import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, AuthError } from "./api";
import { GraphCanvas } from "./graph/GraphCanvas";
import { anchorOf } from "./ids";
import { loadPrefs, savePrefs } from "./prefs";
import { folderColors, KIND_COLORS, KIND_LABELS, KIND_ORDER } from "./theme";
import type {
  ColorBy,
  ControlType,
  EditorTab,
  GraphNode,
  GraphView,
  NodePayload,
  NoteView,
  ServerStatus,
  SideView,
  SourcePayload,
  TrailEvent,
  TreeFile,
} from "./types";
import { ActivityBar } from "./ui/ActivityBar";
import { Breadcrumbs, EditorTabs } from "./ui/EditorTabs";
import { Explorer } from "./ui/Explorer";
import { Inspector } from "./ui/Inspector";
import type { IconSubject } from "./ui/NodeIcon";
import { Sash } from "./ui/Sash";
import { ActivityView, GraphSettings, NotesView, SearchView } from "./ui/SideViews";
import { StatusBar } from "./ui/StatusBar";
import { TitleBar } from "./ui/TitleBar";

const TRAIL_GLOW_MS = 12_000;
const FRESH_GLOW_MS = 6_000;
const TRAIL_KEPT = 30;
const MAX_TABS = 10;
const NARROW = 760;

function focusFromHash(): string | null {
  const match = /^#focus=(.+)$/.exec(window.location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** The tabs with `id` among them: in place of the preview tab, or at the end when it is to be kept. */
function withTab(tabs: EditorTab[], id: string, pin: boolean): EditorTab[] {
  const at = tabs.findIndex((tab) => tab.id === id);
  if (at >= 0) {
    if (!pin || tabs[at]!.pinned) return tabs;
    return tabs.map((tab, index) => (index === at ? { ...tab, pinned: true } : tab));
  }
  const preview = tabs.findIndex((tab) => !tab.pinned);
  if (preview >= 0 && !pin) return tabs.map((tab, index) => (index === preview ? { id, pinned: false } : tab));
  const next = [...tabs, { id, pinned: pin }];
  return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next;
}

/** What the colours in the scene stand for, kept in a corner of it. */
function SceneLegend({ view, colorBy, hidden }: { view: GraphView; colorBy: ColorBy; hidden: ReadonlySet<string> }) {
  const entries = useMemo(() => {
    const nodes = view.nodes.filter((node) => !hidden.has(node.kind));
    if (colorBy === "folder") {
      return [...folderColors(view.nodes)]
        .filter(([id]) => nodes.some((node) => node.group === id))
        .slice(0, 9)
        .map(([id, color]) => ({
          key: id,
          color,
          label: id === "./" ? "root" : id === "ext:" ? "external" : id.replace(/\/$/, ""),
        }));
    }
    const present = new Set(nodes.map((node) => node.kind));
    return KIND_ORDER.filter((kind) => present.has(kind)).map((kind) => ({
      key: kind,
      color: KIND_COLORS[kind],
      label: KIND_LABELS[kind].toLowerCase(),
    }));
  }, [view, colorBy, hidden]);
  if (entries.length === 0) return null;
  return (
    <ul
      className="scene-legend"
      aria-label={colorBy === "folder" ? "Colours: areas of the project" : "Colours: kinds of node"}
    >
      {entries.map((entry) => (
        <li key={entry.key}>
          <span className="dot" style={{ background: entry.color, color: entry.color }} />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

export function App({ token }: { token: string }) {
  const api = useMemo(() => new Api(token), [token]);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [view, setView] = useState<GraphView | null>(null);
  const [files, setFiles] = useState<TreeFile[] | null>(null);
  const [live, setLive] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  // ---- the window: which panels are open, how wide, and which nodes have tabs
  const [prefs, setPrefs] = useState(loadPrefs);
  const [sideView, setSideView] = useState<SideView | null>(() => (window.innerWidth < NARROW ? null : "explorer"));
  const [lastSideView, setLastSideView] = useState<SideView>("explorer");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [unseen, setUnseen] = useState(0);
  /** What has been learnt of nodes that are not in the picture, for their icons. */
  const [known, setKnown] = useState<ReadonlyMap<string, IconSubject>>(new Map());

  /** Groups to open; null lets the server pick a readable starting picture. */
  const expanded = useRef<string[] | null>(null);
  const viewRef = useRef<GraphView | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const sideRef = useRef<SideView | null>(sideView);
  sideRef.current = sideView;
  const loading = useRef(0);
  const noticeTimer = useRef(0);

  const fail = useCallback((err: unknown) => {
    setProblem(err instanceof AuthError ? "auth" : err instanceof Error ? err.message : String(err));
  }, []);

  /** Say something in the status bar for a few seconds. */
  const flash = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const updatePrefs = useCallback((change: Partial<typeof prefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...change };
      savePrefs(next);
      return next;
    });
  }, []);

  const remember = useCallback((nodes: GraphNode[]) => {
    setKnown((current) => {
      const fresh = nodes.filter((node) => current.get(node.id)?.kind !== node.kind);
      if (fresh.length === 0) return current;
      const next = new Map(current.size > 4000 ? [] : current);
      for (const node of fresh) {
        next.set(node.id, { id: node.id, kind: node.kind, subkind: node.subkind, language: node.language });
      }
      return next;
    });
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

  const loadFiles = useCallback(() => {
    api
      .tree()
      .then((payload) => setFiles(payload.files))
      .catch(() => undefined);
  }, [api]);

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
          if (kind)
            setHiddenNodeKinds((hidden) =>
              hidden.has(kind) ? new Set([...hidden].filter((k) => k !== kind)) : hidden,
            );
        }
        setSelectedId(resolved);
        // Give the new nodes a moment to be placed before flying to one of them.
        window.setTimeout(() => setFocus({ id: resolved, nonce: Date.now() }), missing.length > 0 ? 350 : 0);
      } catch (err) {
        if (err instanceof AuthError) fail(err);
        else {
          // Most often a node that has since been renamed or removed: say so, and drop its tab.
          flash(err instanceof Error ? err.message : String(err));
          setTabs((current) => current.filter((tab) => tab.id !== id));
        }
      }
    },
    [api, fail, flash, loadView],
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
    loadFiles();
    void loadView().then(() => {
      const wanted = focusFromHash();
      if (wanted && !cancelled) void goTo(wanted);
    });
    const stop = api.events({
      onHello: (s, trail) => {
        setStatus(s);
        setTrailLog(trail.slice(-TRAIL_KEPT).reverse());
        // After a reconnect the graph may have moved on without us.
        if (viewRef.current && viewRef.current.version !== s.version) {
          void loadView(true);
          loadFiles();
        }
      },
      onChanged: (s) => {
        setStatus(s);
        void loadView(true);
        loadFiles();
        const selected = selectedRef.current;
        if (selected) {
          api
            .node(selected)
            .then(setDetails)
            .catch(() => {
              // the selected node no longer exists
              setSelectedId(null);
              setTabs((current) => current.filter((tab) => tab.id !== selected));
            });
        }
      },
      onStatus: setStatus,
      onTrail: (event) => {
        setTrailLog((log) => [event, ...log].slice(0, TRAIL_KEPT));
        if (sideRef.current !== "activity") setUnseen((count) => count + 1);
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
  }, [api, fail, goTo, loadFiles, loadNotes, loadView]);

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

  // Whatever is selected has a tab, however it came to be selected.
  useEffect(() => {
    if (selectedId) setTabs((current) => withTab(current, selectedId, false));
  }, [selectedId]);

  // The inspector's answer also says what kind of thing each node it names is.
  useEffect(() => {
    if (!details) return;
    remember([
      details.node,
      ...details.outline.map((entry) => entry.node),
      ...details.edges.flatMap((group) => group.top.map((item) => item.node)),
    ]);
  }, [details, remember]);

  const chooseSideView = useCallback((next: SideView) => {
    setLastSideView(next);
    // Choosing the view that is already open hides the side bar, as in an editor.
    setSideView((current) => (current === next ? null : next));
    if (next === "activity") setUnseen(0);
  }, []);

  const toggleSide = useCallback(() => {
    setSideView((current) => (current ? null : lastSideView));
  }, [lastSideView]);

  const closeTab = useCallback(
    (id: string) => {
      const at = tabs.findIndex((tab) => tab.id === id);
      if (at < 0) return;
      const rest = tabs.filter((tab) => tab.id !== id);
      setTabs(rest);
      if (id !== selectedRef.current) return;
      // Closing the active tab moves to its neighbour, or back to the graph when it was the last.
      const neighbour = rest[Math.min(at, rest.length - 1)];
      if (neighbour) void goTo(neighbour.id);
      else setSelectedId(null);
    },
    [goTo, tabs],
  );

  // ---- keyboard: "/" or Ctrl+P to search, Ctrl+B for the side bar, Escape to let go of the selection
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      const command = event.ctrlKey || event.metaKey;
      if ((event.key === "/" && !typing && !command) || (command && !event.shiftKey && event.code === "KeyP")) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#search")?.focus();
      } else if (command && !event.shiftKey && event.code === "KeyB") {
        event.preventDefault();
        toggleSide();
      } else if (command && event.shiftKey && event.code === "KeyE") {
        event.preventDefault();
        setLastSideView("explorer");
        setSideView("explorer");
      } else if (command && event.shiftKey && event.code === "KeyF") {
        event.preventDefault();
        setLastSideView("search");
        setSideView("search");
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#side-search")?.focus());
      } else if (event.key === "Escape" && !typing) {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSide]);

  const drawn = useMemo(() => new Map((view?.nodes ?? []).map((node) => [node.id, node])), [view]);
  const describe = useCallback((id: string): IconSubject => drawn.get(id) ?? known.get(id) ?? { id }, [drawn, known]);

  if (problem === "auth") {
    return (
      <Notice title="This link is no longer valid">
        The visualizer was restarted, so it has a new link. Run <code>vertskim ui</code> again, or ask your assistant to
        open the graph.
      </Notice>
    );
  }

  const project = status?.name ?? "Vertskim";
  const selectedNode = selectedId ? (drawn.get(selectedId) ?? null) : null;
  const inspecting = inspectorOpen && selectedId !== null;
  const layout = { "--side-width": `${prefs.sideWidth}px`, "--inspector-width": `${prefs.inspectorWidth}px` };
  const openGoTo = (id: string) => void goTo(id);

  return (
    <div className="app" style={layout as CSSProperties}>
      <TitleBar
        api={api}
        project={project}
        sideOpen={sideView !== null}
        inspectorOpen={inspectorOpen}
        onGoTo={openGoTo}
        onToggleSide={toggleSide}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
      />

      <div className="workbench">
        <ActivityBar active={sideView} badges={{ notes: notes.length, activity: unseen }} onChoose={chooseSideView} />

        {/* Every view stays mounted, so a folded tree or a typed search is still there on coming back. */}
        <aside className="sidebar" aria-label="Side bar" hidden={sideView === null}>
          <div className="side-slot" hidden={sideView !== "explorer"}>
            <Explorer
              api={api}
              project={project}
              files={files}
              version={status?.version ?? ""}
              selectedId={selectedId}
              notes={notes}
              trail={trailLog}
              onGoTo={openGoTo}
              onPin={(id) => setTabs((current) => withTab(current, id, true))}
            />
          </div>
          <div className="side-slot" hidden={sideView !== "search"}>
            <SearchView api={api} onGoTo={openGoTo} />
          </div>
          <div className="side-slot" hidden={sideView !== "graph"}>
            <GraphSettings
              view={view}
              hiddenNodeKinds={hiddenNodeKinds}
              hiddenEdgeKinds={hiddenEdgeKinds}
              colorBy={colorBy}
              controlType={controlType}
              autoOpen={autoOpen}
              glow={prefs.glow}
              onHiddenNodeKinds={setHiddenNodeKinds}
              onHiddenEdgeKinds={setHiddenEdgeKinds}
              onColorBy={setColorBy}
              onControlType={setControlType}
              onAutoOpen={setAutoOpen}
              onGlow={(glow) => updatePrefs({ glow })}
              onGoTo={openGoTo}
              onReset={resetView}
              onFit={() => setFitNonce((n) => n + 1)}
            />
          </div>
          <div className="side-slot" hidden={sideView !== "notes"}>
            <NotesView notes={notes} onGoTo={openGoTo} />
          </div>
          <div className="side-slot" hidden={sideView !== "activity"}>
            <ActivityView trail={trailLog} onGoTo={openGoTo} />
          </div>
        </aside>
        {sideView !== null && (
          <Sash
            label="Resize the side bar"
            value={prefs.sideWidth}
            min={180}
            max={520}
            direction={1}
            onChange={(sideWidth) => updatePrefs({ sideWidth })}
          />
        )}

        <main className="editor">
          <EditorTabs
            project={project}
            tabs={tabs}
            activeId={selectedId}
            describe={describe}
            onSelect={(id) => (id === null ? setSelectedId(null) : openGoTo(id))}
            onPin={(id) => setTabs((current) => withTab(current, id, true))}
            onClose={closeTab}
            onFit={() => setFitNonce((n) => n + 1)}
            onReset={resetView}
          />
          <Breadcrumbs
            project={project}
            selectedId={selectedId}
            describe={describe}
            onGoTo={openGoTo}
            onSelect={setSelectedId}
          />
          <div className="stage">
            {view && !unsupported && (
              <GraphCanvas
                view={view}
                hiddenNodeKinds={hiddenNodeKinds}
                hiddenEdgeKinds={hiddenEdgeKinds}
                colorBy={colorBy}
                controlType={controlType}
                autoOpen={autoOpen}
                glow={prefs.glow}
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
            {view && !unsupported && <SceneLegend view={view} colorBy={colorBy} hidden={hiddenNodeKinds} />}
            {unsupported && (
              <Notice title="This browser cannot draw the 3D graph">
                WebGL is unavailable here ({unsupported}). The panels still work: search for a node to read its details.
              </Notice>
            )}
            {!view && !problem && <div className="loading">Loading the graph…</div>}
            {!view && problem && (
              <Notice title="The graph could not be loaded">
                {problem}. Check that <code>vertskim ui</code> is still running, then reload this page.
              </Notice>
            )}
          </div>
        </main>

        {inspecting && (
          <Sash
            label="Resize the inspector"
            value={prefs.inspectorWidth}
            min={280}
            max={720}
            direction={-1}
            onChange={(inspectorWidth) => updatePrefs({ inspectorWidth })}
          />
        )}
        {inspecting && (
          <Inspector
            id={selectedId}
            details={details}
            source={source}
            drawn={selectedNode}
            onClose={() => setInspectorOpen(false)}
            onGoTo={openGoTo}
            onToggle={toggle}
            onFly={() => setFocus({ id: selectedId, nonce: Date.now() })}
            onAddNote={(text) => api.addNote(selectedId, text).then(loadNotes)}
            onRemoveNote={(note) => api.removeNote(note).then(loadNotes)}
          />
        )}
      </div>

      <StatusBar
        status={status}
        view={view}
        live={live}
        problem={problem}
        notice={notice}
        selected={details?.node ?? null}
        colorBy={colorBy}
        controlType={controlType}
        onColorBy={setColorBy}
        onControlType={setControlType}
        onGoTo={openGoTo}
      />
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
