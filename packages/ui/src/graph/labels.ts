import * as THREE from "three";
import { fileIcon, folderIcon } from "../fileIcons";
import { KIND_COLORS, KIND_LETTERS, kindName } from "../theme";
import { isGroup, type SimNode } from "./shared";

const MAX_LABELS = 64;
const PICK_EVERY_MS = 140;
/** Below this score a node goes unnamed until the camera comes closer. */
const MIN_SCORE = 9;

interface Placed {
  sim: SimNode;
  element: HTMLDivElement;
  /** `hot`, `dim` and so on, as last written to the element. */
  state: string;
}

interface Candidate {
  sim: SimNode;
  score: number;
  x: number;
  y: number;
  /** Half the label's width and its whole height, in pixels. */
  half: number;
  tall: number;
}

function textOf(sim: SimNode): string {
  const data = sim.data;
  if (data.kind === "directory") return data.id === "./" ? "project root" : `${data.name}/`;
  return data.name;
}

/** What the card under a pointed-at node adds to its name. */
function detailOf(sim: SimNode): string {
  const data = sim.data;
  const parts = [kindName(data)];
  if (data.kind !== "directory" && data.kind !== "external" && data.kind !== "file") parts.push(data.path);
  if (data.container && !data.expanded) {
    if (data.files > 0) parts.push(`${data.files.toLocaleString()} ${data.files === 1 ? "file" : "files"}`);
    else if (data.symbols > 0) parts.push(`${data.symbols.toLocaleString()} symbols`);
  }
  if (data.fanIn > 0) parts.push(`used ${data.fanIn.toLocaleString()}×`);
  return parts.join("  ·  ");
}

function build(sim: SimNode): HTMLDivElement {
  const data = sim.data;
  const element = document.createElement("div");
  const head = document.createElement("div");
  head.className = "glabel-head";
  if (data.kind === "directory" || data.kind === "file" || isGroup(data)) {
    const icon = document.createElement("img");
    icon.alt = "";
    icon.draggable = false;
    icon.src =
      data.kind === "file"
        ? fileIcon(data.id, data.language)
        : folderIcon(data.kind === "directory" ? data.id : "packages/", data.expanded);
    head.append(icon);
  } else {
    const badge = document.createElement("span");
    badge.className = "kbadge";
    badge.style.color = KIND_COLORS[data.kind];
    badge.textContent = data.kind === "type" && data.subkind === "enum" ? "E" : KIND_LETTERS[data.kind];
    head.append(badge);
  }
  const name = document.createElement("span");
  name.className = "glabel-name";
  name.textContent = textOf(sim);
  head.append(name);
  const detail = document.createElement("div");
  detail.className = "glabel-detail";
  detail.textContent = detailOf(sim);
  element.append(head, detail);
  return element;
}

/**
 * The names in the scene. They are ordinary page text laid over the canvas, not part of the
 * 3D picture: that keeps them sharp at every distance and out of the bloom. There is room
 * for only so many, so a few times a second the nodes that matter most from where the
 * camera stands are chosen, and none is allowed to sit on top of another.
 */
export class Labels {
  private readonly root: HTMLDivElement;
  private readonly placed = new Map<string, Placed>();
  private readonly point = new THREE.Vector3();
  private lastPick = 0;
  private stale = true;

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "glabels";
    this.root.setAttribute("aria-hidden", "true");
    container.append(this.root);
  }

  /** Ask for the choice of labels to be made again on the next frame. */
  invalidate(): void {
    this.stale = true;
  }

  /** Forget a node's label, as when the node is rebuilt with a new shape. */
  drop(id: string): void {
    const placed = this.placed.get(id);
    if (!placed) return;
    placed.element.remove();
    this.placed.delete(id);
  }

  update(now: number, nodes: Iterable<SimNode>, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const focal = height / (2 * Math.tan((camera.fov * Math.PI) / 360));

    if (this.stale || now - this.lastPick > PICK_EVERY_MS) {
      this.stale = false;
      this.lastPick = now;
      this.pick(nodes, camera, width, height, focal);
    }

    for (const placed of this.placed.values()) {
      const at = this.project(placed.sim, camera, width, height, focal);
      const style = placed.element.style;
      if (!at) {
        style.display = "none";
        continue;
      }
      // Hung just under the node and centred on it, whatever width the text turns out to have.
      style.transform = `translate3d(${at.x.toFixed(1)}px, ${(at.y + at.radius + 5).toFixed(1)}px, 0) translateX(-50%)`;
      style.display = "";
    }
  }

  /** Where a node is on screen, and how large; null when it is behind the camera. */
  private project(sim: SimNode, camera: THREE.PerspectiveCamera, width: number, height: number, focal: number) {
    if (sim.x === undefined) return null;
    const point = this.point.set(sim.x, sim.y ?? 0, sim.z ?? 0).applyMatrix4(camera.matrixWorldInverse);
    const depth = -point.z;
    if (depth < camera.near * 2) return null;
    point.applyMatrix4(camera.projectionMatrix);
    return {
      x: (point.x * 0.5 + 0.5) * width,
      y: (-point.y * 0.5 + 0.5) * height,
      radius: (sim.look.radius * sim.look.scale * focal) / depth,
      depth,
    };
  }

  private pick(
    nodes: Iterable<SimNode>,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    focal: number,
  ) {
    const candidates: Candidate[] = [];
    for (const sim of nodes) {
      const at = this.project(sim, camera, width, height, focal);
      if (!at || at.x < -60 || at.x > width + 60 || at.y < -40 || at.y > height + 20) continue;
      const data = sim.data;
      const look = sim.look;
      // The larger a node is on screen, the more it deserves its name; groups and files more than symbols.
      let score = Math.min(at.radius, 60);
      if (isGroup(data)) score = score * 2.2 + (data.expanded ? 20 : 12);
      else if (data.kind === "file") score = score * 1.5 + (data.expanded ? 12 : 3);
      if (look.near) score += 34;
      if (look.dim) score *= 0.45;
      if (look.selected) score += 2000;
      if (look.hovered) score += 1000;
      if (score < MIN_SCORE) continue;
      const emphatic = look.selected || look.hovered;
      // How much room the label takes, estimated from its text: the card under the pointer has a second line.
      const name = (26 + textOf(sim).length * (isGroup(data) ? 7.1 : 6.5)) / 2 + (emphatic ? 8 : 0);
      const half = look.hovered ? Math.max(name, (16 + detailOf(sim).length * 5.9) / 2) : name;
      const tall = look.hovered ? 40 : 19;
      candidates.push({ sim, score, x: at.x, y: at.y + at.radius + 5, half, tall });
    }
    candidates.sort((a, b) => b.score - a.score);

    // Take them in order of importance, skipping any that would cover one already taken.
    const taken: Candidate[] = [];
    for (const candidate of candidates) {
      if (taken.length >= MAX_LABELS) break;
      const emphatic = candidate.sim.look.selected || candidate.sim.look.hovered;
      let free = true;
      if (!emphatic) {
        for (const other of taken) {
          const across = Math.abs(candidate.x - other.x) < candidate.half + other.half + 6;
          const down = candidate.y < other.y + other.tall + 2 && other.y < candidate.y + candidate.tall + 2;
          if (across && down) {
            free = false;
            break;
          }
        }
      }
      if (free) taken.push(candidate);
    }

    const wanted = new Set<string>();
    for (const candidate of taken) {
      const sim = candidate.sim;
      wanted.add(sim.id);
      const look = sim.look;
      const data = sim.data;
      const kind = isGroup(data) ? "group" : data.kind === "file" ? "file" : "symbol";
      const state = `${kind}${look.hovered ? " hot pointed" : look.selected ? " hot" : ""}${look.dim ? " dim" : ""}${look.near ? " near" : ""}`;
      let placed = this.placed.get(sim.id);
      if (placed && placed.sim !== sim) {
        // The node was rebuilt (opened or closed): its icon and wording may have changed.
        this.drop(sim.id);
        placed = undefined;
      }
      if (!placed) {
        placed = { sim, element: build(sim), state: "" };
        // Off screen until the next frame puts it in its place.
        placed.element.style.display = "none";
        this.root.append(placed.element);
        this.placed.set(sim.id, placed);
      }
      if (placed.state !== state) {
        placed.state = state;
        placed.element.className = `glabel ${state}`;
      }
    }
    for (const id of [...this.placed.keys()]) if (!wanted.has(id)) this.drop(id);
  }

  dispose(): void {
    this.root.remove();
    this.placed.clear();
  }
}
