import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { hover } from "../hover";
import { anchorOf } from "../ids";
import { BACKGROUND, colorOf, folderColors, LIGHT } from "../theme";
import type { ColorBy, ControlType, GraphView, ViewNode } from "../types";
import { makeStars } from "./backdrop";
import { Bodies, bodyState } from "./bodies";
import { Labels } from "./labels";
import { type DrawnLink, LinkField, rgbOfEdge, StrongLinks } from "./links";
import { Markers } from "./markers";
import { LightPoints } from "./points";
import { type Look, nodeVal, radiusOf, REL_SIZE, reducedMotion, type SimLink, type SimNode } from "./shared";

export interface GraphCanvasProps {
  view: GraphView;
  hiddenNodeKinds: ReadonlySet<string>;
  hiddenEdgeKinds: ReadonlySet<string>;
  colorBy: ColorBy;
  controlType: ControlType;
  /** Open collapsed groups when the camera gets close to them. */
  autoOpen: boolean;
  /** Bloom around whatever is bright. Costs the graphics card some work. */
  glow: boolean;
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

const AUTO_OPEN_MAX_NODES = 1200;
/** On a dense screen a line one pixel wide is half as wide to the eye; it is drawn a little stronger to make up. */
const HAIRLINE = typeof window !== "undefined" && window.devicePixelRatio > 1.5 ? 1.3 : 1;
const WHITE: [number, number, number] = [1, 1, 1];

/** The pieces of the scene that this component draws itself, beside the graph library's. */
interface Layers {
  bodies: Bodies;
  halos: LightPoints;
  sparks: LightPoints;
  lines: LinkField;
  strong: StrongLinks;
  labels: Labels;
  markers: Markers;
  bloom: UnrealBloomPass;
}

function linear(hex: string): [number, number, number] {
  const color = new THREE.Color(hex);
  return [color.r, color.g, color.b];
}

function makeLook(data: ViewNode, color: string): Look {
  return {
    color,
    rgb: linear(color),
    radius: radiusOf(data),
    scale: 1,
    scaleTo: 1,
    glow: 0,
    glowTo: 0.36,
    selected: false,
    hovered: false,
    near: false,
    dim: false,
  };
}

/** The keys that move or turn the camera in fly mode. */
const FLY_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyR",
  "KeyF",
  "KeyQ",
  "KeyE",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/**
 * The 3D scene. The graph library lays the nodes out, moves the camera and answers what is
 * under the pointer; what is seen is drawn here: the nodes' bodies, their halos, the lines
 * between them, the names and the marks. The library is imperative, so this component owns
 * one instance of it and pushes prop changes in; nothing in here re-renders.
 */
export function GraphCanvas(props: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const layersRef = useRef<Layers | null>(null);
  const simNodes = useRef(new Map<string, SimNode>());
  const drawnLinks = useRef<DrawnLink[]>([]);
  /** For each node, the lines that end on it. */
  const adjacency = useRef(new Map<string, DrawnLink[]>());
  const folders = useRef(new Map<string, string>());
  /** The drawn node standing in for whatever the pointer is on, in the scene or in a panel. */
  const hoveredId = useRef<string | null>(null);
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
      layersRef.current?.markers.ping(id, Date.now());
    } else if (aim.current) {
      Object.assign(aim.current, target);
    }
    const camera = graph.cameraPosition();
    const dx = camera.x - target.x;
    const dy = camera.y - target.y;
    const dz = camera.z - target.z;
    const distance = Math.hypot(dx, dy, dz) || 1;
    // Stop far enough back that the node and the marks round it take about a third of the narrower
    // side of the view, so a group is seen whole, does not open by itself, and fits a narrow scene too.
    const lens = graph.camera() as THREE.PerspectiveCamera;
    const half = Math.tan((lens.fov * Math.PI) / 360);
    const wanted = Math.max(70, (radiusOf(node.data) * 6.6) / Math.min(half, half * lens.aspect));
    const k = wanted / distance;
    const duration = reducedMotion() ? 0 : 900;
    flyingUntil.current = performance.now() + duration + 400;
    graph.cameraPosition({ x: target.x + dx * k, y: target.y + dy * k, z: target.z + dz * k }, target, duration);
  };

  /**
   * Frame every node, keeping the direction the camera looks from. Measured from where the layout
   * has put the nodes rather than from the drawn shapes, which only move when a frame is drawn:
   * a page that has not drawn yet would otherwise frame a dot at the origin. A sphere round the
   * nodes, not a box, so the framing still holds once the scene is turned. False when no node
   * has a place yet.
   */
  const fitAll = (duration: number): boolean => {
    const graph = graphRef.current;
    if (!graph) return false;
    const placed = [...simNodes.current.values()].filter((n) => n.x !== undefined);
    if (placed.length === 0) return false;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const n of placed) {
      cx += n.x!;
      cy += n.y ?? 0;
      cz += n.z ?? 0;
    }
    cx /= placed.length;
    cy /= placed.length;
    cz /= placed.length;
    let reach = 1;
    for (const n of placed) {
      reach = Math.max(reach, Math.hypot(n.x! - cx, (n.y ?? 0) - cy, (n.z ?? 0) - cz) + n.look.radius * 1.5);
    }
    const camera = graph.camera() as THREE.PerspectiveCamera;
    const half = (camera.fov * Math.PI) / 360;
    const across = Math.atan(Math.tan(half) * camera.aspect);
    // Far enough that the sphere fits the narrower of the two directions, with a little room round it.
    const distance = (reach / Math.sin(Math.min(half, across))) * 1.06;
    const eye = graph.cameraPosition();
    let dx = eye.x - cx;
    let dy = eye.y - cy;
    let dz = eye.z - cz;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) [dx, dy, dz] = [0, 0, 1];
    const k = distance / (length < 1e-6 ? 1 : length);
    graph.cameraPosition({ x: cx + dx * k, y: cy + dy * k, z: cz + dz * k }, { x: cx, y: cy, z: cz }, duration);
    return true;
  };

  /** Work out again how every node and line should look, after the selection, the pointer or the colours changed. */
  const restyle = () => {
    const layers = layersRef.current;
    if (!layers) return;
    const { selectedId, colorBy } = latest.current;
    const hovered = hoveredId.current;

    // What the selected and the pointed-at node are tied to stays lit; an open group lights what it holds.
    const near = new Set<string>();
    for (const centre of [selectedId, hovered]) {
      if (!centre) continue;
      for (const drawn of adjacency.current.get(centre) ?? []) {
        if (drawn.link.data.kind !== "contains")
          near.add(drawn.source.id === centre ? drawn.target.id : drawn.source.id);
        else if (drawn.source.id === centre) near.add(drawn.target.id);
      }
    }

    for (const sim of simNodes.current.values()) {
      const look = sim.look;
      const color = colorOf(sim.data, colorBy, folders.current);
      if (color !== look.color) {
        look.color = color;
        look.rgb = linear(color);
      }
      look.selected = sim.id === selectedId;
      look.hovered = sim.id === hovered;
      look.near = near.has(sim.id);
      look.dim = selectedId !== null && !look.selected && !look.hovered && !look.near;
      layers.bodies.paint(sim, bodyState(look));
      look.scaleTo = look.hovered ? 1.24 : look.selected ? 1.1 : 1;
      look.glowTo =
        look.selected || look.hovered ? 1 : look.dim ? 0.04 : look.near ? 0.55 : sim.data.expanded ? 0.1 : 0.18;
    }

    for (const drawn of drawnLinks.current) {
      const data = drawn.link.data;
      const contains = data.kind === "contains";
      const from = drawn.source.id;
      const to = drawn.target.id;
      // A containment line belongs to the group it hangs from; any other, to both its ends.
      const ofSelected = selectedId !== null && (from === selectedId || (!contains && to === selectedId));
      const ofHovered = hovered !== null && (from === hovered || (!contains && to === hovered));
      let alpha = contains ? 0.16 : data.heuristic ? 0.14 : 0.22 + Math.min(data.weight, 8) * 0.03;
      if (selectedId !== null) alpha = ofSelected ? (contains ? 0.5 : 0.9) : 0.03;
      if (ofHovered) alpha = Math.max(alpha, contains ? 0.6 : 1);
      drawn.alphaTo = Math.min(alpha * HAIRLINE, 1);
      drawn.strong = ofSelected && !contains;
    }
    layers.labels.invalidate();
  };

  /** Hand the current view to the graph, keeping every surviving node where it is. */
  const applyData = () => {
    const graph = graphRef.current;
    const layers = layersRef.current;
    if (!graph || !layers) return;
    const { view, hiddenNodeKinds, hiddenEdgeKinds, colorBy } = latest.current;
    const nodes = simNodes.current;
    const shown = view.nodes.filter((n) => !hiddenNodeKinds.has(n.kind));
    const ids = new Set(shown.map((n) => n.id));
    folders.current = folderColors(view.nodes);

    for (const id of [...nodes.keys()]) if (!ids.has(id)) nodes.delete(id);
    for (const data of shown) {
      const existing = nodes.get(data.id);
      if (existing && existing.data.expanded === data.expanded) {
        existing.data = data;
        existing.look.radius = radiusOf(data);
        continue;
      }
      // A new object makes the library ask for a new body: needed when the node first
      // appears and when it turns from a group into a hub or back.
      const sim: SimNode = { id: data.id, data, look: makeLook(data, colorOf(data, colorBy, folders.current)) };
      if (existing) {
        Object.assign(sim, { x: existing.x, y: existing.y, z: existing.z, vx: 0, vy: 0, vz: 0 });
        sim.look.glow = existing.look.glow;
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
    const drawn: DrawnLink[] = [];
    const lines = new Map<string, DrawnLink[]>();
    const key = (source: string, target: string, kind: string) => `${source}>${target}>${kind}`;
    const before = new Map(drawnLinks.current.map((d) => [key(d.source.id, d.target.id, d.link.data.kind), d.alpha]));
    for (const link of view.links) {
      const source = nodes.get(link.source);
      const target = nodes.get(link.target);
      if (hiddenEdgeKinds.has(link.kind) || !source || !target) continue;
      const sim: SimLink = { source: link.source, target: link.target, data: link };
      links.push(sim);
      const entry: DrawnLink = {
        link: sim,
        source,
        target,
        rgb: rgbOfEdge(link.kind),
        // A line that was already there keeps its strength; a new one fades in.
        alpha: before.get(key(link.source, link.target, link.kind)) ?? 0,
        alphaTo: 0,
        strong: false,
      };
      drawn.push(entry);
      for (const end of [link.source, link.target]) {
        const list = lines.get(end);
        if (list) list.push(entry);
        else lines.set(end, [entry]);
      }
    }
    drawnLinks.current = drawn;
    adjacency.current = lines;
    layers.lines.setLinks(drawn);
    graph.graphData({ nodes: [...nodes.values()], links } as never);
    // What the pointer is on may have just gone, or just been unfolded into view.
    const pointed = hover.get();
    hoveredId.current = pointed ? anchorOf(pointed, nodes) : null;
    restyle();
  };

  // ---- create the scene; recreated only when the kind of camera control changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: the handlers read live values from refs; rebuilding the scene on every render would lose it
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let graph: ForceGraph3DInstance;
    try {
      graph = new ForceGraph3D(container, {
        controlType: props.controlType,
        // The scene is drawn into an off-screen buffer that smooths its own edges; the canvas needs none.
        rendererConfig: { antialias: false, alpha: false, powerPreference: "high-performance" },
      });
    } catch (err) {
      latest.current.onUnsupported(err instanceof Error ? err.message : String(err));
      return;
    }
    graphRef.current = graph;
    framed.current = false;
    touched.current = false;

    const scene = graph.scene();
    const camera = graph.camera() as THREE.PerspectiveCamera;
    const renderer = graph.renderer() as THREE.WebGLRenderer;
    const node = (n: object) => n as SimNode;
    /** True while the pointer is over the scene rather than over a panel. */
    let inside = false;

    // ---- light: a soft fill from the sky and the ground, and a lamp that travels with the camera,
    // so that a node is lit from over the viewer's shoulder whichever way the scene is turned.
    const fill = new THREE.HemisphereLight(0xdfe8ff, 0x20232c, LIGHT ? 2.2 : 1.4);
    const lamp = new THREE.DirectionalLight(0xffffff, LIGHT ? 1.7 : 2.4);
    lamp.position.set(-0.7, 0.9, 1);
    lamp.target.position.set(0, 0, -1);
    camera.add(lamp, lamp.target);
    scene.add(camera);
    graph.lights([fill]);

    // ---- what is drawn
    const stars = LIGHT ? null : makeStars(scene, renderer.getPixelRatio());
    const layers: Layers = {
      bodies: new Bodies(),
      halos: new LightPoints(scene, 3, 0),
      sparks: new LightPoints(scene, 1.5, 4, 3 * renderer.getPixelRatio()),
      lines: new LinkField(scene),
      strong: new StrongLinks(scene),
      labels: new Labels(container),
      markers: new Markers(scene),
      bloom: new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.48, 0.38, 0.62),
    };
    layersRef.current = layers;

    // ---- the finish: smooth edges, bloom round what is bright, and the screen's own colours at the end
    const composer = graph.postProcessingComposer();
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
      target.samples = 4;
      target.dispose(); // made again, with the samples, the first time it is drawn into
    }
    // Keeps the hue of what is brightest rather than burning it to white, so a glowing node is still its colour.
    if (!LIGHT) renderer.toneMapping = THREE.NeutralToneMapping;
    // Bloom is light added to light; on a light ground there is nothing for it to stand out against.
    layers.bloom.enabled = latest.current.glow && !LIGHT;
    composer.addPass(layers.bloom);
    composer.addPass(new OutputPass());

    graph
      .backgroundColor(BACKGROUND)
      .showNavInfo(false)
      .width(container.clientWidth)
      .height(container.clientHeight)
      .nodeRelSize(REL_SIZE)
      .nodeVal((n) => nodeVal(node(n).data))
      // The name card under the pointer is one of the scene's own labels, not the library's tooltip.
      .nodeLabel(() => "")
      .nodeThreeObject((n) => layers.bodies.create(node(n)))
      // The lines are drawn here, all at once; the library only uses them to lay the nodes out.
      .linkVisibility(false)
      .showPointerCursor((target) => target !== undefined && target !== null)
      // Settle by a count of steps, not by the clock: a tab in the background runs slowly,
      // and a clock would stop the layout before it had spread out.
      .warmupTicks(90)
      .cooldownTicks(280)
      .cooldownTime(60_000)
      .onNodeHover((n) => {
        if (inside) hover.set(n ? node(n).id : null);
      })
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
        fitAll(reducedMotion() ? 0 : 700);
      });

    // Turning carries on for a moment after the hand lets go and eases to a stop; the wheel zooms
    // towards what the pointer is on, which is how a large graph is got around.
    const controls = graph.controls() as {
      enableDamping?: boolean;
      dampingFactor?: number;
      rotateSpeed?: number;
      zoomToCursor?: boolean;
    };
    if (props.controlType === "orbit") {
      controls.zoomToCursor = true;
      controls.rotateSpeed = 0.85;
      if (!reducedMotion()) {
        controls.enableDamping = true;
        controls.dampingFactor = 0.14;
      }
    }

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
    // The library goes on believing the pointer is where it last saw it. Once the pointer has
    // left, nothing in the scene is under it, and a row of a panel may be saying what is.
    const enter = () => {
      inside = true;
    };
    const leave = (event: PointerEvent) => {
      inside = false;
      hover.set(null);
      if (event.buttons === 0) {
        // Move the library's idea of the pointer far away, so that coming back over the same node counts.
        renderer.domElement.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, clientX: -1e5, clientY: -1e5, pointerType: "mouse" }),
        );
      }
    };
    // Any movement over the scene counts as being in it: the pointer may already be there when the page loads.
    container.addEventListener("pointerenter", enter);
    container.addEventListener("pointermove", enter, { passive: true });
    container.addEventListener("pointerleave", leave);
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

    // What the pointer is on, here or on a row of a panel, lights up; a row may name something
    // that is folded away, and then the group it is folded into lights up for it.
    const followHover = () => {
      const pointed = hover.get();
      const anchor = pointed ? anchorOf(pointed, simNodes.current) : null;
      if (anchor === hoveredId.current) return;
      hoveredId.current = anchor;
      restyle();
    };
    const unsubscribe = hover.subscribe(followHover);

    applyData();
    // The first picture is laid out before it is shown and framed at once; later changes grow
    // from where things already are. The library takes in new data a moment after it is handed
    // over, so the warm-up is switched off only once the first data has been laid out with it.
    let firstFrame = 0;
    const frameFirst = (tries: number) => {
      firstFrame = window.setTimeout(() => {
        const placed = [...simNodes.current.values()].some((n) => n.x !== undefined);
        if (!placed && tries > 0) {
          frameFirst(tries - 1);
          return;
        }
        graph.warmupTicks(0);
        if (!touched.current) fitAll(0);
      }, 60);
    };
    frameFirst(50);

    const resize = new ResizeObserver(() => {
      // A scene with no area cannot be drawn into; it keeps its size until it has one again.
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      graph.width(container.clientWidth).height(container.clientHeight);
    });
    resize.observe(container);

    // ---- every frame, drawn from inside the library's own render: after it has moved the nodes and
    // the camera, and before the picture is made, so lines, halos and names never lag behind.
    const drawingSize = new THREE.Vector2();
    let previous = performance.now();
    let lastCheck = 0;
    let lastOpened = 0;
    const drawFrame = () => {
      const now = performance.now();
      const current = latest.current;
      const still = reducedMotion();
      const elapsed = Math.min(now - previous, 100);
      previous = now;
      // How far towards its target a value moves this frame: the same pace at any frame rate.
      const ease = still ? 1 : 1 - Math.exp(-elapsed / 110);
      renderer.getDrawingBufferSize(drawingSize);

      // ---- bodies and their halos
      layers.halos.begin(drawingSize.y, camera.fov, simNodes.current.size);
      for (const sim of simNodes.current.values()) {
        if (sim.x === undefined) continue;
        const look = sim.look;
        look.scale += (look.scaleTo - look.scale) * ease;
        look.glow += (look.glowTo - look.glow) * ease;
        sim.body?.scale.setScalar(look.radius * look.scale);
        const reach = look.radius * (3.4 + look.glow * 3);
        layers.halos.add(sim.x, sim.y ?? 0, sim.z ?? 0, look.rgb, reach, look.glow * (LIGHT ? 0.26 : 0.34));
      }
      layers.halos.end();

      // ---- lines, and sparks running along the selection's
      const links = drawnLinks.current;
      layers.lines.update(links, now / 1000, ease, !still);
      layers.strong.update(links);
      layers.sparks.begin(drawingSize.y, camera.fov, 64);
      if (!still) {
        for (let i = 0; i < links.length; i++) {
          const drawn = links[i]!;
          if (!drawn.strong) continue;
          const s = drawn.source;
          const t = drawn.target;
          const dx = (t.x ?? 0) - (s.x ?? 0);
          const dy = (t.y ?? 0) - (s.y ?? 0);
          const dz = (t.z ?? 0) - (s.z ?? 0);
          const count = Math.min(Math.max(Math.round(Math.hypot(dx, dy, dz) / 55), 1), 4);
          for (let k = 0; k < count; k++) {
            const along = (now / 1900 + k / count + i * 0.37) % 1;
            // Bright in the middle of its run, fading in at one end and out at the other.
            const shine = Math.sin(along * Math.PI);
            layers.sparks.add(
              (s.x ?? 0) + dx * along,
              (s.y ?? 0) + dy * along,
              (s.z ?? 0) + dz * along,
              LIGHT ? drawn.rgb : WHITE,
              4.2,
              shine * (LIGHT ? 0.9 : 0.8),
            );
          }
        }
      }
      layers.sparks.end();

      layers.markers.update(
        Date.now(),
        simNodes.current,
        camera,
        current.selectedId,
        current.trail,
        current.fresh,
        still,
      );
      layers.labels.update(now, simNodes.current.values(), camera, container.clientWidth, container.clientHeight);
      stars?.follow(camera);

      const waiting = pending.current;
      if (waiting) {
        const sim = simNodes.current.get(waiting.id);
        if (sim && sim.x !== undefined) flyTo(waiting.id);
        else if (now > waiting.until) pending.current = null;
      }

      if (now - lastCheck > 400) {
        lastCheck = now;
        let nearest: SimNode | null = null;
        let nearestDistance = Infinity;
        for (const sim of simNodes.current.values()) {
          const d = sim.data;
          if (!d.container || d.expanded || sim.x === undefined) continue;
          const eye = camera.position;
          const distance = Math.hypot(eye.x - sim.x, eye.y - (sim.y ?? 0), eye.z - (sim.z ?? 0));
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
    };
    scene.onBeforeRender = drawFrame;

    return () => {
      scene.onBeforeRender = () => {};
      window.clearTimeout(firstFrame);
      stopFollowing();
      unsubscribe();
      hover.set(null);
      container.removeEventListener("pointerdown", release);
      container.removeEventListener("wheel", release);
      container.removeEventListener("pointerenter", enter);
      container.removeEventListener("pointermove", enter);
      container.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", steer);
      document.removeEventListener("keydown", shield);
      document.removeEventListener("keyup", shield);
      resize.disconnect();
      layersRef.current = null;
      layers.labels.dispose();
      layers.markers.dispose();
      layers.halos.dispose();
      layers.sparks.dispose();
      layers.lines.dispose();
      layers.strong.dispose();
      layers.bloom.dispose();
      stars?.dispose();
      // The nodes keep their places for the next scene, which builds bodies of its own for them.
      for (const sim of simNodes.current.values()) sim.body = undefined;
      drawnLinks.current = [];
      adjacency.current = new Map();
      graph._destructor();
      layers.bodies.dispose();
      graphRef.current = null;
    };
  }, [props.controlType]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyData reads these props; it must run again when they change
  useEffect(applyData, [props.view, props.hiddenNodeKinds, props.hiddenEdgeKinds]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restyle reads these props; it must run again when they change
  useEffect(restyle, [props.selectedId, props.colorBy]);

  useEffect(() => {
    const layers = layersRef.current;
    if (layers) layers.bloom.enabled = props.glow && !LIGHT;
  }, [props.glow]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fly only when a new focus is asked for, not on every render
  useEffect(() => {
    if (props.focus) flyTo(props.focus.id);
  }, [props.focus]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fit only when asked to, not on every render
  useEffect(() => {
    if (props.fitNonce > 0) fitAll(reducedMotion() ? 0 : 700);
  }, [props.fitNonce]);

  return <div ref={containerRef} className="canvas" aria-label="3D graph of the project" role="img" />;
}
