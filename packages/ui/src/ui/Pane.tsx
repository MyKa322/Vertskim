import { type ReactNode, useId, useState } from "react";
import { Glyph } from "./Glyph";

export interface PaneProps {
  title: string;
  /** A number shown beside the title, such as how many rows the pane holds. */
  count?: number | string;
  /** Buttons shown at the right of the header while the pane is open. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}

/** A titled section that folds away, like the panes of an editor's side bar. */
export function Pane({ title, count, actions, defaultOpen = true, className, children }: PaneProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className={`pane${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <div className="pane-header">
        <button
          type="button"
          className="pane-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <Glyph name={open ? "chevron-down" : "chevron-right"} size={14} />
          <span className="pane-title">{title}</span>
          {count !== undefined && <span className="count">{count}</span>}
        </button>
        {open && actions && <div className="pane-actions">{actions}</div>}
      </div>
      {open && (
        <div className="pane-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
