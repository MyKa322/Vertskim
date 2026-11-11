import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { BACKGROUND, colorOf, EDGE_COLORS, folderColors, FRESH, kindName, LABEL, SELECTION, TRAIL, withAlpha } from "./theme";
import type { ColorBy, ControlType, GraphView, ViewLink, ViewNode } from "./types";

interface SimNode {
  id: string;
  data: ViewNode;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  data: ViewLink;
}

export interface GraphCanvasProps {
  view: GraphView;
  hiddenNodeKinds: ReadonlySet<string>;
  hiddenEdgeKinds: ReadonlySet<string>;
  colorBy: ColorBy;
  controlType: ControlType;
  /** Open collapsed groups when the camera gets close to them. */
  autoOpen: boolean;
  selectedId: string | null;
  /** Nodes the assistant queried recently: id -> time the highlight ends. */
  trail: ReadonlyMap<string, number>;
  /** Nodes that just appeared: id -> time the highlight ends. */
  fresh: ReadonlyMap<string, number>;
  /** Fly to a node; a new `nonce` repeats the flight to the same node. */
  focus: { id: string; nonce: number } | null;
  /** Bump to frame the whole graph. */
  fitNonce: number;
  onSelect(id: string | null): void;
  onToggle(id: string): void;
  onUnsupported(reason: string): void;
}

const REL_SIZE = 5;
const AUTO_OPEN_MAX_NODES = 1200;
const ARROWS_MAX_LINKS = 2500;

/** Relative volume of a node's sphere. */
function nodeVal(node: ViewNode): number {
  if (node.expanded) return 0.5;
  if (node.kind === "directory" || (node.kind === "external" && node.subkind === "group")) {
    return 4 + Math.min(node.files + node.symbols / 20, 400) * 0.45;
  }
  if (node.kind === "file") return 1.4 + Math.min(node.symbols, 200) * 0.1 + Math.log2(1 + node.fanIn) * 0.4;
  return 0.8 + Math.log2(1 + node.fanIn) * 0.7;
}

function radiusOf(node: ViewNode): number {
  return Math.cbrt(nodeVal(node)) * REL_SIZE;
}

function endId(end: string | SimNode): string {
  return typeof end === "string" ? end : end.id;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function labelFor(node: ViewNode, total: number): SpriteText | null {
  const isGroup = node.kind === "directory" || (node.kind === "external" && node.subkind === "group");
  const show =
    isGroup ||
    (node.kind === "file" && total <= 260) ||
    ((node.kind === "class" || node.kind === "interface") && total <= 140);
  if (!show) return null;
  const size = isGroup ? (node.expanded ? 7 : 9) : 4;
  const sprite = new SpriteText(node.kind === "directory" ? `${node.name}/` : node.name, size, LABEL);
  sprite.fontFace = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  sprite.fontWeight = isGroup ? "600" : "400";
  sprite.strokeWidth = 1.2;
  sprite.strokeColor = BACKGROUND;
  sprite.material.depthWrite = false;
  sprite.material.opacity = isGroup ? 0.95 : 0.75;
  sprite.position.set(0, radiusOf(node) + size * 0.9, 0);
  return sprite;
}

/** Rings and halos drawn around particular nodes, following them as the layout moves. */
class Markers {
  private readonly group = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly halo = new THREE.SphereGeometry(1, 20, 14);
  private readonly cage = new THREE.IcosahedronGeometry(1, 1);

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  private mesh(key: string, kind: "select" | "trail" | "fresh"): THREE.Mesh {
    let mesh = this.meshes.get(key);
    if (!mesh) {
      const material =
        kind === "select"
          ? new THREE.MeshBasicMaterial({ color: SELECTION, wireframe: true, transparent: true, opacity: 0.9 })
          : new THREE.MeshBasicMaterial({
              color: kind === "trail" ? TRAIL : FRESH,
              transparent: true,
              opacity: 0.3,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
            });
      mesh = new THREE.Mesh(kind === "select" ? this.cage : this.halo, material);
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
    return mesh;
  }

  update(
    now: number,
    nodes: Map<string, SimNode>,
    selectedId: string | null,
    trail: ReadonlyMap<string, number>,
    fresh: ReadonlyMap<string, number>,
  ): void {
    const wanted = new Set<string>();
    const place = (key: string, kind: "select" | "trail" | "fresh", id: string, scale: number, opacity: number) => {
      const node = nodes.get(id);
      if (!node || node.x === undefined) return;
      wanted.add(key);
      const mesh = this.mesh(key, kind);
      mesh.position.set(node.x, node.y ?? 0, node.z ?? 0);
      mesh.scale.setScalar(radiusOf(node.data) * scale);
      (mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
    };
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    if (selectedId) {
      place(`select:${selectedId}`, "select", selectedId, 1.45, 0.85);
      const cage = this.meshes.get(`select:${selectedId}`);
      if (cage) cage.rotation.y = now / 2400;
    }
    for (const [id, until] of trail) {
      const left = Math.min(Math.max((until - now) / 3000, 0), 1); // fades over its last three seconds
      if (left > 0) place(`trail:${id}`, "trail", id, 2.2 + pulse * 1.1, (0.34 + pulse * 0.26) * left);
    }
    for (const [id, until] of fresh) {
      const left = Math.min(Math.max((until - now) / 2000, 0), 1);
      if (left > 0) place(`fresh:${id}`, "fresh", id, 1.6 + pulse * 1.2, 0.3 * left);
    }
    for (const [key, mesh] of this.meshes) {
      if (wanted.has(key)) continue;
      this.group.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      this.meshes.delete(key);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) (mesh.material as THREE.Material).dispose();
    this.meshes.clear();
    this.halo.dispose();
    this.cage.dispose();
    this.group.removeFromParent();
  }
}

/** The keys that move or turn the camera in fly mode. */
const FLY_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyR", "KeyF", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

/**
 * The 3D scene. The graph library is imperative, so this component owns one
 * instance of it and pushes prop changes in; nothing in here re-renders.
 */
export function GraphCanvas(props: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const simNodes = useRef(new Map<string, SimNode>());
  const neighbours = useRef(new Set<string>());
  const folders = useRef(new Map<string, string>());
  const linkCount = useRef(0);
  const suppressed = useRef(new Set<string>());
  const flyingUntil = useRef(0);
  /** Set once the first picture has been framed; nothing opens by itself before then. */
  const framed = useRef(false);
  /** True once the user has moved the camera, after which it is never re-framed for them. */
  const touched = useRef(false);
  /** Where the camera was last sent, and the timers that re-aim it while the layout settles. */
  const aim = useRef<{ id: string; x: number; y: number; z: number; timers: number[] } | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** A node the camera was sent to before it had a place in the scene. */
  const pending = useRef<{ id: string; until: number } | null>(null);

  const stopFollowing = () => {
    for (const timer of aim.current?.timers ?? []) window.clearTimeout(timer);
    aim.current = null;
    pending.current = null;
  };

  const flyTo = (id: string, follow = true) => {
    const graph = graphRef.current;
    if (!graph) return;
    const node = simNodes.current.get(id);
    if (!node || node.x === undefined) {
      // Not drawn or not placed yet, as when a link opens straight onto a node:
      // the frame loop goes there as soon as it is.
      if (follow) {
        stopFollowing();
        pending.current = { id, until: performance.now() + 6000 };
      }
      return;
    }
    const target = { x: node.x, y: node.y ?? 0, z: node.z ?? 0 };
    if (follow) {
      // A node that has just appeared keeps moving while the layout settles; look again
      // a few times and re-aim if it has drifted, unless the user takes the camera first.
      stopFollowing();
      const timers = [1000, 2200, 3800].map((delay) =>
        window.setTimeout(() => {
          const last = aim.current;
          const now = simNodes.current.get(id);
          if (!last || last.id !== id || !now || now.x === undefined) return;
          const drift = Math.hypot(now.x - last.x, (now.y ?? 0) - last.y, (now.z ?? 0) - last.z);
          if (drift > 12) flyTo(id, false);
        }, delay),
      );
      aim.current = { id, ...target, timers };
    } else if (aim.current) {
      Object.assign(aim.current, target);
    }
    const camera = graph.cameraPosition();
    const dx = camera.x - target.x;
    const dy = camera.y - target.y;
    const dz = camera.z - target.z;
    const distance = Math.hypot(dx, dy, dz) || 1;
    // Stop far enough back that a group is seen whole and does not open by itself.
    const wanted = Math.max(70, radiusOf(node.data) * 9);
    const k = wanted / distance;
    const duration = reducedMotion() ? 0 : 900;
    flyingUntil.current = performance.now() + duration + 400;
    graph.cameraPosition({ x: target.x + dx * k, y: target.y + dy * k, z: target.z + dz * k }, target, duration);
  };

  /** Re-run the colour and width accessors after something they depend on changed. */
  const restyle = () => {
    const graph = graphRef.current;
    if (!graph) return;
    const { selectedId } = latest.current;
    const near = new Set<string>();
    if (selectedId) {
      for (const link of graph.graphData().links as unknown as SimLink[]) {
        const s = endId(link.source);
        const t = endId(link.target);
        // An open group lights up what it holds; otherwise only real relationships count.
        if (link.data.kind === "contains") {
          if (s === selectedId) near.add(t);
        } else if (s === selectedId) near.add(t);
        else if (t === selectedId) near.add(s);
      }
    }
    neighbours.current = near;
    graph
      .nodeColor(graph.nodeColor())
      .linkColor(graph.linkColor())
      .linkWidth(graph.linkWidth())
      .linkDirectionalParticles(graph.linkDirectionalParticles());
  };

  /** Hand the current view to the graph, keeping every surviving node where it is. */
  const applyData = () => {
    const graph = graphRef.current;
    if (!graph) return;
    const { view, hiddenNodeKinds, hiddenEdgeKinds } = latest.current;
    const nodes = simNodes.current;
    const shown = view.nodes.filter((n) => !hiddenNodeKinds.has(n.kind));
    const ids = new Set(shown.map((n) => n.id));
    folders.current = folderColors(view.nodes);

    for (const id of [...nodes.keys()]) if (!ids.has(id)) nodes.delete(id);
    for (const data of shown) {
      const existing = nodes.get(data.id);
      if (existing && existing.data.expanded === data.expanded) {
        existing.data = data;
        continue;
      }
      // A new object makes the library rebuild the node's shape: needed when it first
      // appears and when it turns from a group into a hub or back.
      const sim: SimNode = { id: data.id, data };
      if (existing) {
        Object.assign(sim, { x: existing.x, y: existing.y, z: existing.z, vx: 0, vy: 0, vz: 0 });
        if (existing.data.expanded && !data.expanded) suppressed.current.add(data.id);
      } else {
        // New nodes start beside the group they belong to, so the picture grows in place.
        const parent = data.parent ? nodes.get(data.parent) : undefined;
        if (parent && parent.x !== undefined) {
          const spread = 12;
          sim.x = parent.x + (Math.random() - 0.5) * spread;
          sim.y = (parent.y ?? 0) + (Math.random() - 0.5) * spread;
          sim.z = (parent.z ?? 0) + (Math.random() - 0.5) * spread;
        }
      }
      nodes.set(data.id, sim);
    }

    const links: SimLink[] = [];
    for (const link of view.links) {
      if (hiddenEdgeKinds.has(link.kind) || !ids.has(link.source) || !ids.has(link.target)) continue;
      links.push({ source: link.source, target: link.target, data: link });
    }
    linkCount.current = links.length;
    graph.graphData({ nodes: [...nodes.values()], links } as never);
    restyle();
  };

  // ---- create the scene; recreated only when the kind of camera control changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let graph: ForceGraph3DInstance;
    try {
      graph = new ForceGraph3D(container, {
        controlType: props.controlType,
        rendererConfig: { antialias: true, alpha: false, powerPreference: "high-performance" },
      });
    } catch (err) {
      latest.current.onUnsupported(err instanceof Error ? err.message : String(err));
      return;
    }
    graphRef.current = graph;
    framed.current = false;
    touched.current = false;

    const node = (n: object) => n as SimNode;
    const link = (l: object) => l as SimLink;
    const touchesSelected = (l: SimLink) => {
      const { selectedId } = latest.current;
      return selectedId !== null && (endId(l.source) === selectedId || endId(l.target) === selectedId);
    };

    graph
      .backgroundColor(BACKGROUND)
      .showNavInfo(false)
      .width(container.clientWidth)
      .height(container.clientHeight)
      .nodeRelSize(REL_SIZE)
      .nodeResolution(14)
      .nodeOpacity(1)
      .nodeVal((n) => nodeVal(node(n).data))
      .nodeLabel((n) => {
        const d = node(n).data;
        const where = d.kind === "directory" || d.kind === "external" ? "" : ` · ${escapeHtml(d.path)}`;
        const size = d.container && !d.expanded ? ` · ${d.files > 0 ? `${d.files} files` : `${d.symbols} symbols`}` : "";
        return `<div class="tip"><strong>${escapeHtml(d.name)}</strong><span>${escapeHtml(kindName(d))}${where}${size}</span></div>`;
      })
      .nodeColor((n) => {
        const { selectedId, colorBy } = latest.current;
        const d = node(n).data;
        const base = colorOf(d, colorBy, folders.current);
        if (selectedId) {
          if (d.id === selectedId) return SELECTION;
          if (!neighbours.current.has(d.id)) return withAlpha(base, 0.16);
        }
        return d.expanded ? withAlpha(base, 0.5) : base;
      })
      .nodeThreeObjectExtend(true)
      .nodeThreeObject((n) => labelFor(node(n).data, simNodes.current.size) as unknown as THREE.Object3D)
      .linkOpacity(1)
      .linkColor((l) => {
        const data = link(l).data;
        let alpha = data.kind === "contains" ? 0.45 : data.heuristic ? 0.28 : 0.5 + Math.min(data.weight, 8) * 0.04;
        if (latest.current.selectedId) {
          const own = data.kind === "contains" ? endId(link(l).source) === latest.current.selectedId : touchesSelected(link(l));
          alpha = own ? (data.kind === "contains" ? 0.6 : 0.95) : 0.05;
        }
        return withAlpha(EDGE_COLORS[data.kind], alpha);
      })
      .linkWidth((l) => (touchesSelected(link(l)) && link(l).data.kind !== "contains" ? 0.6 : 0))
      .linkDirectionalArrowLength((l) =>
        link(l).data.kind === "contains" || linkCount.current > ARROWS_MAX_LINKS ? 0 : 2.4,
      )
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalParticles((l) => (touchesSelected(link(l)) && link(l).data.kind !== "contains" ? 2 : 0))
      .linkDirectionalParticleWidth(1.3)
      .linkDirectionalParticleSpeed(0.007)
      // Settle by a count of steps, not by the clock: a tab in the background runs slowly,
      // and a clock would stop the layout before it had spread out.
      .warmupTicks(90)
      .cooldownTicks(280)
      .cooldownTime(60_000)
      .onNodeClick((n) => {
        const current = latest.current;
        const d = node(n).data;
        if (current.selectedId === d.id && d.container) current.onToggle(d.id);
        else {
          current.onSelect(d.id);
          flyTo(d.id);
        }
      })
      .onBackgroundClick(() => latest.current.onSelect(null))
      .onEngineStop(() => {
        // The layout has come to rest. If the camera was sent to a node that kept moving,
        // this is where that node ended up; otherwise frame the first picture.
        const following = aim.current;
        if (following) {
          flyTo(following.id, false);
          stopFollowing();
          framed.current = true;
          return;
        }
        if (framed.current || touched.current) return;
        framed.current = true;
        graph.zoomToFit(reducedMotion() ? 0 : 700, 70);
      });

    // Containment pulls members tightly round their group; dependencies only tug gently,
    // so the folder structure stays readable.
    const linkForce = graph.d3Force("link") as unknown as {
      distance(fn: (l: SimLink) => number): unknown;
      strength(fn: (l: SimLink) => number): unknown;
    };
    linkForce.distance((l) => (l.data.kind === "contains" ? 22 : 70));
    linkForce.strength((l) => (l.data.kind === "contains" ? 0.9 : 0.04));
    (graph.d3Force("charge") as unknown as { strength(value: number): unknown }).strength(-70);
    // A weak pull towards the middle, so pieces with no ties to the rest do not drift out of sight.
    let pulled: SimNode[] = [];
    const gravity = Object.assign(
      (alpha: number) => {
        for (const n of pulled) {
          n.vx = (n.vx ?? 0) - (n.x ?? 0) * 0.035 * alpha;
          n.vy = (n.vy ?? 0) - (n.y ?? 0) * 0.035 * alpha;
          n.vz = (n.vz ?? 0) - (n.z ?? 0) * 0.035 * alpha;
        }
      },
      {
        initialize(nodes: SimNode[]) {
          pulled = nodes;
        },
      },
    );
    graph.d3Force("gravity", gravity as never);

    // Taking hold of the camera cancels any pending re-aim.
    const release = () => {
      touched.current = true;
      stopFollowing();
    };
    container.addEventListener("pointerdown", release);
    container.addEventListener("wheel", release, { passive: true });
    // Fly mode is steered from the keyboard too, so its keys count as taking the camera.
    const steer = (event: KeyboardEvent) => {
      if (props.controlType === "fly" && FLY_KEYS.has(event.code)) release();
    };
    // The camera controls listen on the window; keys typed into a field must not reach them.
    const shield = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", steer);
    document.addEventListener("keydown", shield);
    document.addEventListener("keyup", shield);

    const markers = new Markers(graph.scene());
    applyData();
    // The first picture is laid out before it is shown and framed at once; later changes
    // grow from where things already are.
    graph.warmupTicks(0);
    const firstFrame = requestAnimationFrame(() => graph.zoomToFit(0, 70));

    const resize = new ResizeObserver(() => {
      graph.width(container.clientWidth).height(container.clientHeight);
    });
    resize.observe(container);

    let frame = 0;
    let lastCheck = 0;
    let lastOpened = 0;
    const tick = (now: number) => {
      const current = latest.current;
      markers.update(Date.now(), simNodes.current, current.selectedId, current.trail, current.fresh);

      const waiting = pending.current;
      if (waiting) {
        const sim = simNodes.current.get(waiting.id);
        if (sim && sim.x !== undefined) flyTo(waiting.id);
        else if (now > waiting.until) pending.current = null;
      }

      if (now - lastCheck > 400) {
        lastCheck = now;
        const camera = graph.cameraPosition();
        let nearest: SimNode | null = null;
        let nearestDistance = Infinity;
        for (const sim of simNodes.current.values()) {
          const d = sim.data;
          if (!d.container || d.expanded || sim.x === undefined) continue;
          const distance = Math.hypot(camera.x - sim.x, camera.y - (sim.y ?? 0), camera.z - (sim.z ?? 0));
          const threshold = radiusOf(d) * 4.5 + 22;
          // A group closed by hand stays closed until the camera has moved well away from it.
          if (suppressed.current.has(d.id)) {
            if (distance > threshold * 2) suppressed.current.delete(d.id);
            continue;
          }
          if (distance < threshold && distance < nearestDistance) {
            nearest = sim;
            nearestDistance = distance;
          }
        }
        const idle = now > flyingUntil.current && now - lastOpened > 1500;
        // Groups open because the user flew into them, never because of where the camera started.
        const ready = framed.current || touched.current;
        if (nearest && current.autoOpen && idle && ready && simNodes.current.size <= AUTO_OPEN_MAX_NODES) {
          lastOpened = now;
          current.onToggle(nearest.id);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(firstFrame);
      stopFollowing();
      container.removeEventListener("pointerdown", release);
      container.removeEventListener("wheel", release);
      window.removeEventListener("keydown", steer);
      document.removeEventListener("keydown", shield);
      document.removeEventListener("keyup", shield);
      resize.disconnect();
      markers.dispose();
      graph._destructor();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.controlType]);

  useEffect(applyData, [props.view, props.hiddenNodeKinds, props.hiddenEdgeKinds]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(restyle, [props.selectedId, props.colorBy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (props.focus) flyTo(props.focus.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus]);

  useEffect(() => {
    if (props.fitNonce > 0) graphRef.current?.zoomToFit(reducedMotion() ? 0 : 700, 70);
  }, [props.fitNonce]);

  return <div ref={containerRef} className="canvas" aria-label="3D graph of the project" role="img" />;
}
