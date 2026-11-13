import type { KeyboardEvent, PointerEvent } from "react";

export interface SashProps {
  label: string;
  /** The width of the panel this edge resizes, in pixels. */
  value: number;
  min: number;
  max: number;
  /** +1 when dragging right widens the panel (it lies to the left of the edge), -1 when it narrows it. */
  direction: 1 | -1;
  onChange(width: number): void;
}

/** The edge between two panels: drag it, or focus it and use the arrow keys, to resize. */
export function Sash({ label, value, min, max, direction, onChange }: SashProps) {
  const clamp = (width: number) => Math.round(Math.min(Math.max(width, min), max));

  /** The panel's width as drawn, which on a narrow window can be less than the width asked for. */
  const drawnWidth = (sash: HTMLElement) => {
    const panel = direction === 1 ? sash.previousElementSibling : sash.nextElementSibling;
    return panel ? panel.getBoundingClientRect().width : value;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const sash = event.currentTarget;
    const startX = event.clientX;
    const start = drawnWidth(sash);
    sash.setPointerCapture(event.pointerId);
    sash.classList.add("dragging");
    const move = (e: globalThis.PointerEvent) => onChange(clamp(start + (e.clientX - startX) * direction));
    const stop = () => {
      sash.classList.remove("dragging");
      sash.removeEventListener("pointermove", move);
      sash.removeEventListener("pointerup", stop);
      sash.removeEventListener("pointercancel", stop);
    };
    sash.addEventListener("pointermove", move);
    sash.addEventListener("pointerup", stop);
    sash.addEventListener("pointercancel", stop);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onChange(clamp(drawnWidth(event.currentTarget) + (event.key === "ArrowRight" ? 16 : -16) * direction));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be dragged; this is the ARIA pattern for a splitter
    <div
      className="sash"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
