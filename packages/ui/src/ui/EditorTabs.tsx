import { hoverProps } from "../hover";
import { crumbsOf, leafName } from "../ids";
import type { EditorTab } from "../types";
import { Glyph, IconButton } from "./Glyph";
import { type IconSubject, NodeIcon } from "./NodeIcon";

export interface EditorTabsProps {
  project: string;
  tabs: EditorTab[];
  /** The selected node, whose tab is the active one; null when the graph itself is. */
  activeId: string | null;
  /** What is known of a node, for its icon. */
  describe(id: string): IconSubject;
  onSelect(id: string | null): void;
  onPin(id: string): void;
  onClose(id: string): void;
  onFit(): void;
  onReset(mode: "default" | "collapsed"): void;
}

/**
 * The row of tabs over the scene. The first is the graph itself; each of the others is a node
 * that was opened. A tab in italics is a preview: the next node opened takes its place,
 * unless it is pinned with a double click.
 */
export function EditorTabs(props: EditorTabsProps) {
  const { tabs, activeId } = props;
  return (
    <div className="tabs">
      <div className="tab-strip" role="tablist" aria-label="Open nodes">
        <div className={`tab graph-tab${activeId === null ? " active" : ""}`}>
          <button type="button" role="tab" aria-selected={activeId === null} onClick={() => props.onSelect(null)}>
            <Glyph name="graph" size={15} />
            <span className="tab-name">{props.project}</span>
          </button>
        </div>
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={`tab${active ? " active" : ""}${tab.pinned ? "" : " preview"}`}
              // A press of the wheel closes a tab, as in an editor.
              onAuxClick={(event) => event.button === 1 && props.onClose(tab.id)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.pinned ? tab.id : `${tab.id}\nDouble click to keep this tab open`}
                onClick={() => props.onSelect(tab.id)}
                onDoubleClick={() => props.onPin(tab.id)}
                {...hoverProps(tab.id)}
              >
                <NodeIcon node={props.describe(tab.id)} />
                <span className="tab-name">{leafName(tab.id)}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${leafName(tab.id)}`}
                title="Close"
                onClick={() => props.onClose(tab.id)}
              >
                <Glyph name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tab-actions">
        <IconButton icon="fit" label="Fit the graph to the screen" onClick={props.onFit} />
        <IconButton icon="reset" label="Reset: back to the starting picture" onClick={() => props.onReset("default")} />
        <IconButton icon="collapse-all" label="Close every group" onClick={() => props.onReset("collapsed")} />
      </div>
    </div>
  );
}

export interface BreadcrumbsProps {
  project: string;
  selectedId: string | null;
  describe(id: string): IconSubject;
  onGoTo(id: string): void;
  onSelect(id: string | null): void;
}

/** The way down to the selected node, each step a place to go. */
export function Breadcrumbs({ project, selectedId, describe, onGoTo, onSelect }: BreadcrumbsProps) {
  const crumbs = selectedId ? crumbsOf(selectedId) : [];
  return (
    <nav className="breadcrumbs" aria-label="Where the selected node is">
      <button type="button" className="crumb" onClick={() => onSelect(null)} title="The whole graph">
        <NodeIcon node={{ id: "./" }} open />
        <span>{project}</span>
      </button>
      {crumbs.map((crumb, index) => (
        <span key={crumb.id} className="crumb-step">
          <Glyph name="chevron-right" size={12} />
          <button
            type="button"
            className={`crumb${index === crumbs.length - 1 ? " current" : ""}`}
            title={crumb.id}
            onClick={() => onGoTo(crumb.id)}
            {...hoverProps(crumb.id)}
          >
            <NodeIcon node={describe(crumb.id)} open />
            <span>{crumb.label}</span>
          </button>
        </span>
      ))}
      {!selectedId && <span className="crumb-hint">Click a node to select it; click it again to open it</span>}
    </nav>
  );
}
