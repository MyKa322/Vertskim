import * as THREE from "three";
import { BACKGROUND, LIGHT } from "../theme";
import type { ViewNode } from "../types";
import { isGroup, type Look, type SimNode } from "./shared";

export type BodyState = "base" | "hot" | "dim";

export function bodyState(look: Look): BodyState {
  return look.selected || look.hovered ? "hot" : look.dim ? "dim" : "base";
}

/** Which solid a node is. The shape says what a node is even when the colour says where it lives. */
type Shape = "sphere" | "gem" | "rock";
/** The wire shell round anything that can be opened: a fine one for a folder, a plain one for a file, a hub's once open. */
type Cage = "folder" | "file" | "hub";

function shapeOf(node: ViewNode): Shape {
  if (node.kind === "class" || node.kind === "interface" || node.kind === "type") return "gem";
  if (node.kind === "external" && !isGroup(node)) return "rock";
  return "sphere";
}

function cageOf(node: ViewNode): Cage | null {
  if (!node.container) return null;
  if (node.expanded) return "hub";
  return isGroup(node) ? "folder" : "file";
}

/**
 * The graph library disposes of the geometry and materials of every node it removes. These
 * are shared by many nodes, so the library's call is made to do nothing, and they are freed
 * here, once, when the scene goes.
 */
function shared<T extends THREE.BufferGeometry | THREE.Material>(resource: T): T {
  resource.dispose = () => {};
  return resource;
}

function free(resource: THREE.BufferGeometry | THREE.Material): void {
  if (resource instanceof THREE.BufferGeometry) THREE.BufferGeometry.prototype.dispose.call(resource);
  else THREE.Material.prototype.dispose.call(resource);
}

/**
 * The bodies of the nodes. Every body is a small group: a lit solid, and for anything that
 * can be opened, a cage of lines around it. Geometry is shared by all of them and materials
 * by colour, so a few thousand nodes cost a few dozen GPU objects.
 */
export class Bodies {
  private readonly solids: Record<Shape, THREE.BufferGeometry> = {
    sphere: shared(new THREE.SphereGeometry(1, 32, 20)),
    gem: shared(new THREE.OctahedronGeometry(1.2, 0)),
    rock: shared(new THREE.IcosahedronGeometry(1.06, 0)),
  };
  private readonly cages: Record<Cage, THREE.BufferGeometry> = {
    folder: shared(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.48, 1))),
    file: shared(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.42, 0))),
    hub: shared(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.55, 0))),
  };
  private readonly surfaces = new Map<string, THREE.MeshStandardMaterial>();
  private readonly wires = new Map<string, THREE.LineBasicMaterial>();
  private readonly ground = new THREE.Color(BACKGROUND);

  /** A body for the node, painted as its look says. */
  create(sim: SimNode): THREE.Group {
    const data = sim.data;
    const body = new THREE.Group();
    const solid = new THREE.Mesh(this.solids[shapeOf(data)]);
    solid.name = "solid";
    // An open group is a small hub at the middle of what it holds.
    if (data.expanded) solid.scale.setScalar(0.42);
    body.add(solid);
    const cage = cageOf(data);
    if (cage) {
      const wire = new THREE.LineSegments(this.cages[cage]);
      wire.name = cage;
      body.add(wire);
    }
    body.scale.setScalar(sim.look.radius * sim.look.scale);
    sim.body = body;
    this.paint(sim, bodyState(sim.look));
    return body;
  }

  paint(sim: SimNode, state: BodyState): void {
    const body = sim.body;
    if (!body) return;
    const flat = shapeOf(sim.data) !== "sphere";
    for (const child of body.children) {
      if (child.name === "solid") (child as THREE.Mesh).material = this.surface(sim.look.color, state, flat);
      else (child as THREE.LineSegments).material = this.wire(sim.look.color, state, child.name as Cage);
    }
  }

  private surface(color: string, state: BodyState, flat: boolean): THREE.MeshStandardMaterial {
    const key = `${color}|${state}|${flat ? 1 : 0}`;
    let material = this.surfaces.get(key);
    if (!material) {
      const base = new THREE.Color(color);
      // A dimmed node sinks into the ground rather than turning see-through, which sorts badly.
      const shown = state === "dim" ? base.clone().lerp(this.ground, 0.78) : base;
      // On a dark ground the bodies give off their own light, which is what the bloom picks up.
      const emissive = LIGHT ? (state === "hot" ? 0.3 : 0.1) : state === "hot" ? 0.6 : state === "dim" ? 0.06 : 0.3;
      material = shared(
        new THREE.MeshStandardMaterial({
          color: shown,
          emissive: shown,
          emissiveIntensity: emissive,
          roughness: flat ? 0.3 : 0.42,
          metalness: flat ? 0.25 : 0.05,
          flatShading: flat,
        }),
      );
      this.surfaces.set(key, material);
    }
    return material;
  }

  private wire(color: string, state: BodyState, cage: Cage): THREE.LineBasicMaterial {
    const key = `${color}|${state}|${cage}`;
    let material = this.wires.get(key);
    if (!material) {
      const rest = cage === "file" ? 0.22 : cage === "hub" ? 0.42 : 0.48;
      material = shared(
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: state === "hot" ? 0.95 : state === "dim" ? rest * 0.18 : rest,
          depthWrite: false,
        }),
      );
      this.wires.set(key, material);
    }
    return material;
  }

  dispose(): void {
    for (const geometry of [...Object.values(this.solids), ...Object.values(this.cages)]) free(geometry);
    for (const material of [...this.surfaces.values(), ...this.wires.values()]) free(material);
    this.surfaces.clear();
    this.wires.clear();
  }
}
