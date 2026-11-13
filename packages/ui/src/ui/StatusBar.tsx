import { useHovered } from "../hover";
import { kindName } from "../theme";
import type { ColorBy, ControlType, GraphNode, GraphView, ServerStatus } from "../types";
import { Glyph } from "./Glyph";
import { languageName } from "./Inspector";

export interface StatusBarProps {
  status: ServerStatus | null;
  view: GraphView | null;
  live: boolean;
  problem: string | null;
  /** A passing message, such as a node that could not be opened. */
  notice: string | null;
  selected: GraphNode | null;
  colorBy: ColorBy;
  controlType: ControlType;
  onColorBy(next: ColorBy): void;
  onControlType(next: ControlType): void;
  onGoTo(id: string): void;
}

/** The node under the pointer, named as a browser names the link under it. */
function Hovered() {
  const id = useHovered();
  return id ? (
    <span className="status-item status-hover" title={id}>
      {id}
    </span>
  ) : null;
}

/** The strip along the foot of the window: the state of the index at the left, the view's settings at the right. */
export function StatusBar(props: StatusBarProps) {
  const { status, view, selected } = props;

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

  const broken = status?.syntaxErrors ?? [];
  const lines =
    selected && selected.kind !== "file" && selected.startLine
      ? selected.endLine && selected.endLine !== selected.startLine
        ? `Ln ${selected.startLine}–${selected.endLine}`
        : `Ln ${selected.startLine}`
      : null;

  return (
    <footer className="statusbar">
      <div className="status-side">
        <span className={`status-item status-state ${stateClass}`} role="status" title={props.problem ?? undefined}>
          <Glyph name="broadcast" size={13} />
          {state}
        </span>
        <span className="status-item" data-item="counts" title="What the index holds">
          {status ? `${status.files.toLocaleString()} files · ${status.nodes.toLocaleString()} nodes` : " "}
        </span>
        {view && (
          <span className="status-item" title="What the scene is drawing now">
            <Glyph name="graph" size={13} />
            {view.nodes.length.toLocaleString()} drawn · {view.links.length.toLocaleString()} links
            {view.truncated ? " · more than can be drawn" : ""}
          </span>
        )}
        {broken.length > 0 && (
          <button
            type="button"
            className="status-item warn"
            title={`Files that do not parse:\n${broken.map((file) => `${file.path}:${file.line}`).join("\n")}`}
            onClick={() => props.onGoTo(broken[0]!.path)}
          >
            <Glyph name="warning" size={13} />
            {broken.length}
          </button>
        )}
        <Hovered />
      </div>
      <div className="status-side">
        {props.notice && <span className="status-item warn">{props.notice}</span>}
        {selected && (
          <span className="status-item">
            {[kindName(selected), lines, selected.kind === "section" ? null : languageName(selected.language)]
              .filter(Boolean)
              .join("  ·  ")}
          </span>
        )}
        <button
          type="button"
          className="status-item"
          title="Colour the nodes by what they are, or by the folder they are in"
          onClick={() => props.onColorBy(props.colorBy === "kind" ? "folder" : "kind")}
        >
          <Glyph name="palette" size={13} />
          Colour: {props.colorBy === "kind" ? "Kind" : "Folder"}
        </button>
        <button
          type="button"
          className="status-item"
          title={
            props.controlType === "orbit"
              ? "Orbit: drag to rotate, scroll to zoom. Click to fly instead."
              : "Fly: W A S D to move, drag to look. Click to orbit instead."
          }
          onClick={() => props.onControlType(props.controlType === "orbit" ? "fly" : "orbit")}
        >
          <Glyph name={props.controlType === "orbit" ? "orbit" : "fly"} size={13} />
          {props.controlType === "orbit" ? "Orbit" : "Fly"}
        </button>
      </div>
    </footer>
  );
}
