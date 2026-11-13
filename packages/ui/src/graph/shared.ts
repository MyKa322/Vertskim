import type * as THREE from "three";
import type { ViewLink, ViewNode } from "../types";

/** How a node is drawn right now, and what it is easing towards. */
export interface Look {
  /** The node's own colour, as `#rrggbb` and as linear red, green and blue. */
  color: string;
  rgb: [number, number, number];
  /** World radius of the node's body. */
  radius: number;
  /** Size of the body against its resting size; grows a little under the pointer. */
  scale: number;
  scaleTo: number;
  /** Strength of the halo around it, 0 to 1. */
  glow: number;
  glowTo: number;
  selected: boolean;
  hovered: boolean;
  /** Tied to the selected or the hovered node. */
  near: boolean;
  /** Pushed into the background because something else is selected. */
  dim: boolean;
}

export interface SimNode {
  id: string;
  data: ViewNode;
  look: Look;
  /** The node's body in the scene, once the graph library has asked for one. */
  body?: THREE.Group;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

export interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  data: ViewLink;
}

export const REL_SIZE = 5;

export function isGroup(node: ViewNode): boolean {
  return node.kind === "directory" || (node.kind === "external" && node.subkind === "group");
}

/** Relative volume of a node's body. */
export function nodeVal(node: ViewNode): number {
  if (node.expanded) return 0.5;
  if (isGroup(node)) return 4 + Math.min(node.files + node.symbols / 20, 400) * 0.45;
  if (node.kind === "file") return 1.4 + Math.min(node.symbols, 200) * 0.1 + Math.log2(1 + node.fanIn) * 0.4;
  return 0.8 + Math.log2(1 + node.fanIn) * 0.7;
}

export function radiusOf(node: ViewNode): number {
  return Math.cbrt(nodeVal(node)) * REL_SIZE;
}

export function endId(end: string | SimNode): string {
  return typeof end === "string" ? end : end.id;
}

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
