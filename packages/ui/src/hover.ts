import { useSyncExternalStore } from "react";

/**
 * The node under the pointer, wherever the pointer is: on the 3D scene or on a row
 * that names a node. Kept outside React's state, because it changes many times a
 * second and only two places care: the scene, which lights the node up, and the
 * status bar, which names it.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export const hover = {
  get(): string | null {
    return current;
  },
  set(id: string | null): void {
    if (id === current) return;
    current = id;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useHovered(): string | null {
  return useSyncExternalStore(hover.subscribe, hover.get);
}

/** Props for a row that names a node: while the pointer or the focus is on it, the node glows in the scene. */
export function hoverProps(id: string) {
  return {
    onMouseEnter: () => hover.set(id),
    onMouseLeave: () => hover.set(null),
    onFocus: () => hover.set(id),
    onBlur: () => hover.set(null),
  };
}
