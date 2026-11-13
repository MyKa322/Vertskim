const KEY = "vertskim-layout";

/** How the user left the window: kept in this browser, and only here. */
export interface Prefs {
  sideWidth: number;
  inspectorWidth: number;
  /** The bloom around bright things in the scene. */
  glow: boolean;
}

const DEFAULTS: Prefs = { sideWidth: 264, inspectorWidth: 380, glow: true };

export function loadPrefs(): Prefs {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (stored === null || typeof stored !== "object") return DEFAULTS;
    const given = stored as Partial<Record<keyof Prefs, unknown>>;
    return {
      sideWidth: typeof given.sideWidth === "number" ? given.sideWidth : DEFAULTS.sideWidth,
      inspectorWidth: typeof given.inspectorWidth === "number" ? given.inspectorWidth : DEFAULTS.inspectorWidth,
      glow: typeof given.glow === "boolean" ? given.glow : DEFAULTS.glow,
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable: the layout lasts until the page is closed
  }
}
