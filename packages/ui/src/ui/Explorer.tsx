import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "../api";
import { hover, hoverProps } from "../hover";
import { directoriesOf, fileOf, isDirectory } from "../ids";
import type { NoteView, OutlineEntry, TrailEvent, TreeFile } from "../types";
import { IconButton } from "./Glyph";
import { FileIcon, FolderIcon, KindBadge } from "./NodeIcon";
import { Pane } from "./Pane";

interface Dir {
  id: string;
  name: string;
  dirs: Dir[];
  files: TreeFile[];
}

type Row =
  | { type: "dir"; id: string; name: string; depth: number; open: boolean }
  | { type: "file"; id: string; name: string; depth: number; file: TreeFile };

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders from the list of file paths, each sorted as an explorer sorts: folders first, then by name. */
function buildTree(files: TreeFile[]): Dir {
  const root: Dir = { id: "./", name: "", dirs: [], files: [] };
  const dirs = new Map<string, Dir>([["./", root]]);
  const dirFor = (id: string): Dir => {
    const known = dirs.get(id);
    if (known) return known;
    const trimmed = id.slice(0, -1);
    const slash = trimmed.lastIndexOf("/");
    const dir: Dir = { id, name: trimmed.slice(slash + 1), dirs: [], files: [] };
    dirs.set(id, dir);
    (slash < 0 ? root : dirFor(trimmed.slice(0, slash + 1))).dirs.push(dir);
    return dir;
  };
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    (slash < 0 ? root : dirFor(file.path.slice(0, slash + 1))).files.push(file);
  }
  for (const dir of dirs.values()) {
    dir.dirs.sort((a, b) => byName.compare(a.name, b.name));
    dir.files.sort((a, b) => byName.compare(a.path, b.path));
  }
  return root;
}

function flatten(dir: Dir, open: ReadonlySet<string>, depth: number, out: Row[]): Row[] {
  for (const child of dir.dirs) {
    const isOpen = open.has(child.id);
    out.push({ type: "dir", id: child.id, name: child.name, depth, open: isOpen });
    if (isOpen) flatten(child, open, depth + 1, out);
  }
  for (const file of dir.files) {
    out.push({ type: "file", id: file.path, name: file.path.slice(file.path.lastIndexOf("/") + 1), depth, file });
  }
  return out;
}

/** What to mark on the rows: notes kept on a file, and files the assistant has just looked at. */
function useDecorations(notes: NoteView[], trail: TrailEvent[], files: TreeFile[]) {
  // Activity fades from the tree after a couple of minutes; look again now and then while there is some.
  const [now, setNow] = useState(Date.now());
  const newest = trail[0]?.at ?? 0;
  useEffect(() => {
    if (newest === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [newest]);

  return useMemo(() => {
    const noted = new Map<string, number>();
    const touched = new Set<string>();
    const broken = new Set<string>();
    const mark = (id: string, each: (key: string) => void) => {
      const file = fileOf(id) ?? (id.endsWith("/") ? id : null);
      if (!file) return;
      each(file);
      for (const dir of directoriesOf(file)) if (dir !== file) each(dir);
    };
    for (const note of notes) {
      if (!note.orphaned) mark(note.nodeId, (key) => noted.set(key, (noted.get(key) ?? 0) + 1));
    }
    for (const event of trail) {
      if (now - event.at > 120_000) continue;
      for (const id of event.ids) mark(id, (key) => touched.add(key));
    }
    for (const file of files) {
      if (file.syntaxError !== null) mark(file.path, (key) => broken.add(key));
    }
    return { noted, touched, broken };
  }, [notes, trail, files, now]);
}

function OutlineList({
  entries,
  selectedId,
  onGoTo,
  depth = 0,
}: {
  entries: OutlineEntry[];
  selectedId: string | null;
  onGoTo(id: string): void;
  depth?: number;
}) {
  return (
    <ul className="outline-list">
      {entries.map((entry) => (
        <li key={entry.node.id}>
          <button
            type="button"
            className={`tree-main${entry.node.id === selectedId ? " selected" : ""}`}
            style={{ paddingLeft: 20 + depth * 14 }}
            title={entry.node.signature ?? entry.node.id}
            onClick={() => onGoTo(entry.node.id)}
            {...hoverProps(entry.node.id)}
          >
            <KindBadge kind={entry.node.kind} subkind={entry.node.subkind} />
            <span className="tree-name">{entry.node.name}</span>
            {entry.node.startLine != null && <span className="tree-meta">{entry.node.startLine}</span>}
          </button>
          {entry.children.length > 0 && (
            <OutlineList entries={entry.children} selectedId={selectedId} onGoTo={onGoTo} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** The symbols of the file the selection is in, as an editor's outline shows them. */
function Outline(props: {
  api: Api;
  file: string | null;
  version: string;
  selectedId: string | null;
  onGoTo(id: string): void;
}) {
  const { api, file, version } = props;
  const [outline, setOutline] = useState<{ file: string; entries: OutlineEntry[] } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is not read, but a new one means the file may have new symbols
  useEffect(() => {
    if (!file) {
      setOutline(null);
      return;
    }
    let cancelled = false;
    api
      .node(file)
      .then((payload) => !cancelled && setOutline({ file, entries: payload.outline }))
      .catch(() => !cancelled && setOutline({ file, entries: [] }));
    return () => {
      cancelled = true;
    };
  }, [api, file, version]);

  const entries = outline && outline.file === file ? outline.entries : null;
  return (
    <Pane title="Outline" className="outline-pane" count={entries && entries.length > 0 ? entries.length : undefined}>
      {!file ? (
        <p className="pane-empty">Select a file or a symbol to see what the file holds.</p>
      ) : entries === null ? (
        <p className="pane-empty">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="pane-empty">No symbols were found in this file.</p>
      ) : (
        <OutlineList entries={entries} selectedId={props.selectedId} onGoTo={props.onGoTo} />
      )}
    </Pane>
  );
}

export interface ExplorerProps {
  api: Api;
  project: string;
  /** Null until the list of files has arrived. */
  files: TreeFile[] | null;
  /** Changes whenever the graph does. */
  version: string;
  selectedId: string | null;
  notes: NoteView[];
  trail: TrailEvent[];
  onGoTo(id: string): void;
  /** Keep a node's tab open, as a double click on a file does in an editor. */
  onPin(id: string): void;
}

export function Explorer(props: ExplorerProps) {
  const { files, selectedId } = props;
  const root = useMemo(() => buildTree(files ?? []), [files]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const marks = useDecorations(props.notes, props.trail, files ?? []);

  // The row the selection belongs to: the file a symbol is in, or the folder itself.
  const selectedRow = selectedId ? (fileOf(selectedId) ?? (selectedId.endsWith("/") ? selectedId : null)) : null;

  // Follow the selection: open the folders above it and bring its row into view.
  useEffect(() => {
    if (!selectedRow) return;
    setOpen((current) => {
      const missing = directoriesOf(selectedRow).filter((dir) => dir !== selectedRow && !current.has(dir));
      return missing.length > 0 ? new Set([...current, ...missing]) : current;
    });
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector(`[data-id="${CSS.escape(selectedRow)}"]`)?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedRow]);

  const rows = useMemo(() => flatten(root, open, 0, []), [root, open]);
  const tabStop = cursor !== null && rows.some((row) => row.id === cursor) ? cursor : (rows[0]?.id ?? null);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const focusRow = (id: string | undefined) => {
    if (id === undefined) return;
    list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] .tree-main`)?.focus();
  };

  // Arrow keys, as in any tree: up and down between rows, right to open or step in, left to close or step out.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = rows.findIndex((row) => row.id === cursor);
    if (at < 0) return;
    const row = rows[at]!;
    if (event.key === "ArrowDown") focusRow(rows[at + 1]?.id);
    else if (event.key === "ArrowUp") focusRow(rows[at - 1]?.id);
    else if (event.key === "Home") focusRow(rows[0]?.id);
    else if (event.key === "End") focusRow(rows[rows.length - 1]?.id);
    else if (event.key === "ArrowRight" && row.type === "dir") {
      if (row.open) focusRow(rows[at + 1]?.id);
      else toggle(row.id);
    } else if (event.key === "ArrowLeft") {
      if (row.type === "dir" && row.open) toggle(row.id);
      else {
        // The folder above: the nearest earlier row one level out.
        for (let i = at - 1; i >= 0; i--) {
          if (rows[i]!.depth < row.depth) {
            focusRow(rows[i]!.id);
            break;
          }
        }
      }
    } else return;
    event.preventDefault();
  };

  return (
    <div className="view explorer">
      <h2 className="view-title">Explorer</h2>
      <Pane
        title={props.project}
        className="tree-pane"
        actions={<IconButton icon="collapse-all" label="Close every folder" onClick={() => setOpen(new Set())} />}
      >
        {files === null ? (
          <p className="pane-empty">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="pane-empty">No files have been indexed yet.</p>
        ) : (
          <div className="tree" role="tree" aria-label="Files of the project" ref={list} onKeyDown={onKeyDown}>
            {rows.map((row) => {
              const selected = row.id === selectedRow;
              const notes = marks.noted.get(row.id) ?? 0;
              const touched = marks.touched.has(row.id);
              const broken = marks.broken.has(row.id);
              const state = `${selected ? " selected" : ""}${touched ? " touched" : ""}${broken ? " broken" : ""}`;
              return (
                <div
                  key={row.id}
                  className={`tree-row${state}`}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected={selected}
                  aria-expanded={row.type === "dir" ? row.open : undefined}
                  tabIndex={-1}
                  data-id={row.id}
                >
                  <button
                    type="button"
                    className="tree-main"
                    // The depth also draws the indent guides, one line per folder the row is in.
                    style={{ paddingLeft: 8 + row.depth * 12, "--depth": row.depth } as CSSProperties}
                    tabIndex={row.id === tabStop ? 0 : -1}
                    title={row.id}
                    onClick={() => (row.type === "dir" ? toggle(row.id) : props.onGoTo(row.id))}
                    onDoubleClick={() => row.type === "file" && props.onPin(row.id)}
                    onMouseEnter={() => hover.set(row.id)}
                    onMouseLeave={() => hover.set(null)}
                    onFocus={() => {
                      setCursor(row.id);
                      hover.set(row.id);
                    }}
                    onBlur={() => hover.set(null)}
                  >
                    <span className={`twist${row.type === "dir" ? (row.open ? " open" : " closed") : ""}`} />
                    {row.type === "dir" ? (
                      <FolderIcon path={row.id} open={row.open} />
                    ) : (
                      <FileIcon path={row.id} language={row.file.language} />
                    )}
                    <span className="tree-name">{row.name}</span>
                    {broken && row.type === "file" && (
                      <span className="tree-mark error" title={`Does not parse: line ${row.file.syntaxError}`}>
                        !
                      </span>
                    )}
                    {notes > 0 && (
                      <span
                        className={`tree-mark note${row.type === "dir" ? " dot" : ""}`}
                        title={notes === 1 ? "1 note" : `${notes} notes`}
                      >
                        {row.type === "file" ? notes : null}
                      </span>
                    )}
                    {touched && <span className="tree-mark live dot" title="Your assistant looked here a moment ago" />}
                  </button>
                  {row.type === "dir" && (
                    <IconButton
                      icon="target"
                      className="tree-action"
                      label="Show this folder in the graph"
                      onClick={() => props.onGoTo(row.id)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Pane>
      <Outline
        api={props.api}
        file={selectedId && !isDirectory(selectedId) ? fileOf(selectedId) : null}
        version={props.version}
        selectedId={selectedId}
        onGoTo={props.onGoTo}
      />
    </div>
  );
}
