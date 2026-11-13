import { useRef, useState } from "react";
import type { Api } from "../api";
import { Glyph, IconButton, Logo } from "./Glyph";
import { HitRow, useSearch } from "./search";

/**
 * The search box in the middle of the title bar, an editor's "go to file": type a name,
 * move through the answers with the arrow keys, Enter to go there.
 */
function CommandCenter({ api, project, onGoTo }: { api: Api; project: string; onGoTo(id: string): void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLElement>(null);
  const { hits, partial } = useSearch(api, query, 14);

  const choose = (id: string) => {
    onGoTo(id);
    setQuery("");
    setOpen(false);
    box.current?.querySelector("input")?.blur();
  };

  const index = hits && hits.length > 0 ? Math.min(active, hits.length - 1) : 0;

  return (
    <search
      className="command-center"
      ref={box}
      onBlur={(event) => {
        if (!box.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <label className="visually-hidden" htmlFor="search">
        Search the graph
      </label>
      <Glyph name="search" size={14} />
      <input
        id="search"
        type="search"
        placeholder={`Search ${project}: files and symbols`}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open && hits !== null}
        aria-controls="search-results"
        aria-autocomplete="list"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const count = hits?.length ?? 0;
            if (count > 0) setActive((index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
          } else if (event.key === "Enter" && hits?.[index]) {
            choose(hits[index].id);
          } else if (event.key === "Escape") {
            setQuery("");
            event.currentTarget.blur();
          }
        }}
      />
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a kbd element is not focusable; this is a visual hint for the / shortcut */}
      <kbd aria-hidden="true">/</kbd>
      {open && hits && (
        // Kept from taking the focus, so a click on an answer lands before the list closes.
        // biome-ignore lint/a11y/noStaticElementInteractions: only stops the pointer from moving the focus; the buttons inside are the controls
        <div className="quick-pick" onMouseDown={(event) => event.preventDefault()}>
          <ul className="results" id="search-results">
            {hits.length === 0 && <li className="empty">Nothing matches “{query.trim()}”.</li>}
            {partial && hits.length > 0 && <li className="empty">No match for every word. Closest:</li>}
            {hits.map((node, at) => (
              <li key={node.id}>
                <HitRow node={node} active={at === index} onChoose={choose} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </search>
  );
}

export interface TitleBarProps {
  api: Api;
  project: string;
  sideOpen: boolean;
  inspectorOpen: boolean;
  onGoTo(id: string): void;
  onToggleSide(): void;
  onToggleInspector(): void;
}

export function TitleBar(props: TitleBarProps) {
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <Logo size={18} />
        <span>Vertskim</span>
      </div>
      <CommandCenter api={props.api} project={props.project} onGoTo={props.onGoTo} />
      <div className="titlebar-actions">
        <IconButton
          icon="side-left"
          label={props.sideOpen ? "Hide the side bar (Ctrl+B)" : "Show the side bar (Ctrl+B)"}
          pressed={props.sideOpen}
          onClick={props.onToggleSide}
        />
        <IconButton
          icon="side-right"
          label={props.inspectorOpen ? "Hide the inspector" : "Show the inspector"}
          pressed={props.inspectorOpen}
          onClick={props.onToggleInspector}
        />
      </div>
    </header>
  );
}
