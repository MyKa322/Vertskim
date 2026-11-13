import { useEffect, useRef, useState } from "react";
import { chooseTheme, type ThemeChoice, themeChoice } from "../theme";
import type { SideView } from "../types";
import { Glyph, type GlyphName } from "./Glyph";

const VIEWS: { view: SideView; icon: GlyphName; label: string }[] = [
  { view: "explorer", icon: "files", label: "Explorer" },
  { view: "search", icon: "search", label: "Search" },
  { view: "graph", icon: "graph", label: "Graph: what is drawn, and how" },
  { view: "notes", icon: "note", label: "Notes" },
  { view: "activity", icon: "pulse", label: "Assistant activity" },
];

const THEMES: { choice: ThemeChoice; label: string }[] = [
  { choice: "system", label: "Follow the system" },
  { choice: "dark", label: "Dark" },
  { choice: "light", label: "Light" },
];

/** The gear at the foot of the bar: the page's appearance. */
function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = themeChoice();

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="activity-menu" ref={box}>
      <button
        type="button"
        className="activity-button"
        title="Colour theme"
        aria-label="Colour theme"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Glyph name="gear" size={22} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Colour theme">
          <p className="menu-title">Colour theme</p>
          {THEMES.map((theme) => (
            <button
              key={theme.choice}
              type="button"
              role="menuitemradio"
              aria-checked={current === theme.choice}
              onClick={() => (current === theme.choice ? setOpen(false) : chooseTheme(theme.choice))}
            >
              <span className="menu-check">{current === theme.choice && <Glyph name="check" size={14} />}</span>
              {theme.label}
            </button>
          ))}
          <p className="menu-note">Changing it reloads the page.</p>
        </div>
      )}
    </div>
  );
}

export interface ActivityBarProps {
  /** The view shown in the side bar; null when the side bar is hidden. */
  active: SideView | null;
  /** A number to show on a view's button, such as how many notes there are. */
  badges: Partial<Record<SideView, number>>;
  onChoose(view: SideView): void;
}

/** The rail of view buttons down the left edge. Choosing the open view again hides the side bar. */
export function ActivityBar({ active, badges, onChoose }: ActivityBarProps) {
  return (
    <nav className="activitybar" aria-label="Views">
      <div className="activity-group">
        {VIEWS.map(({ view, icon, label }) => {
          const badge = badges[view] ?? 0;
          return (
            <button
              key={view}
              type="button"
              className="activity-button"
              title={label}
              aria-label={badge > 0 ? `${label} (${badge})` : label}
              aria-pressed={active === view}
              onClick={() => onChoose(view)}
            >
              <Glyph name={icon} size={22} />
              {badge > 0 && <span className="activity-badge">{badge > 99 ? "99+" : badge}</span>}
            </button>
          );
        })}
      </div>
      <ThemeMenu />
    </nav>
  );
}
