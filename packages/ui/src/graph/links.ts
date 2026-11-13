import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { EDGE_COLORS, LIGHT } from "../theme";
import type { EdgeKind } from "../types";
import type { SimLink, SimNode } from "./shared";

const VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute float aAlong;
  attribute float aLength;
  attribute float aSeed;
  attribute float aFlow;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDistance;
  varying float vLength;
  varying float vSeed;
  varying float vFlow;

  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
    vAlpha = aAlpha;
    vDistance = aAlong * aLength;
    vLength = aLength;
    vSeed = aSeed;
    vFlow = aFlow;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSpacing;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vDistance;
  varying float vLength;
  varying float vSeed;
  varying float vFlow;

  void main() {
    // A pulse of light runs down each line from its source to its target, which is how the
    // direction of a relationship reads without an arrowhead on every line.
    float phase = fract(vDistance / uSpacing - uTime * 0.32 - vSeed);
    float pulse = pow(phase, 5.0) * (1.0 - smoothstep(0.93, 1.0, phase));
    // Faded where it meets a node: the lines then seem to leave its surface, and the many that
    // meet at a busy hub do not add up to a white blot at its middle.
    float ends = smoothstep(1.5, 9.0, vDistance) * smoothstep(1.5, 9.0, vLength - vDistance);
    float a = vAlpha * (0.62 + vFlow * pulse * 2.6) * mix(0.12, 1.0, ends);
    gl_FragColor = vec4(vColor, min(a, 1.0));
  }
`;

/** One line as drawn: where it runs, and how strongly it is to show. */
export interface DrawnLink {
  link: SimLink;
  source: SimNode;
  target: SimNode;
  rgb: [number, number, number];
  alpha: number;
  alphaTo: number;
  /** Drawn thick, with sparks: a relationship of the selected node. */
  strong: boolean;
}

const edgeRgb = new Map<EdgeKind, [number, number, number]>();

/** An edge kind's colour as linear red, green and blue. */
export function rgbOfEdge(kind: EdgeKind): [number, number, number] {
  let rgb = edgeRgb.get(kind);
  if (!rgb) {
    const color = new THREE.Color(EDGE_COLORS[kind]);
    rgb = [color.r, color.g, color.b];
    edgeRgb.set(kind, rgb);
  }
  return rgb;
}

/**
 * Every line of the graph in a single draw: thin, tinted by its kind, with light flowing
 * along the ones that have a direction. The graph library's own lines are switched off.
 */
export class LinkField {
  readonly object: THREE.LineSegments;
  private readonly material: THREE.ShaderMaterial;
  private capacity = 0;
  private position = new Float32Array(0);
  private color = new Float32Array(0);
  private alpha = new Float32Array(0);
  private length = new Float32Array(0);
  private fixed: { along: Float32Array; seed: Float32Array; flow: Float32Array } | null = null;

  constructor(scene: THREE.Scene) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSpacing: { value: 64 } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Laid over rather than added: where many lines meet they keep their colour instead of burning white.
      blending: THREE.NormalBlending,
    });
    this.object = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
    this.object.raycast = () => {};
    scene.add(this.object);
  }

  /** Take a new set of lines. What does not change from frame to frame is written here, once. */
  setLinks(links: DrawnLink[]): void {
    const count = links.length;
    if (count > this.capacity || this.fixed === null) {
      this.capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 64);
      const vertices = this.capacity * 2;
      this.position = new Float32Array(vertices * 3);
      this.color = new Float32Array(vertices * 3);
      this.alpha = new Float32Array(vertices);
      this.length = new Float32Array(vertices);
      this.fixed = {
        along: new Float32Array(vertices),
        seed: new Float32Array(vertices),
        flow: new Float32Array(vertices),
      };
      const geometry = this.object.geometry;
      geometry.dispose();
      const attribute = (array: Float32Array, width: number, dynamic: boolean) => {
        const made = new THREE.BufferAttribute(array, width);
        if (dynamic) made.setUsage(THREE.DynamicDrawUsage);
        return made;
      };
      geometry.setAttribute("position", attribute(this.position, 3, true));
      geometry.setAttribute("aColor", attribute(this.color, 3, false));
      geometry.setAttribute("aAlpha", attribute(this.alpha, 1, true));
      geometry.setAttribute("aLength", attribute(this.length, 1, true));
      geometry.setAttribute("aAlong", attribute(this.fixed.along, 1, false));
      geometry.setAttribute("aSeed", attribute(this.fixed.seed, 1, false));
      geometry.setAttribute("aFlow", attribute(this.fixed.flow, 1, false));
    }
    const { along, seed, flow } = this.fixed;
    links.forEach((drawn, i) => {
      const a = i * 2;
      const b = a + 1;
      this.color.set(drawn.rgb, a * 3);
      this.color.set(drawn.rgb, b * 3);
      along[a] = 0;
      along[b] = 1;
      // Each line keeps its own beat, so the pulses do not march in step.
      seed[a] = seed[b] = (i * 0.61803398875) % 1;
      // Containment has no direction worth showing: those lines only hold the picture together.
      flow[a] = flow[b] = drawn.link.data.kind === "contains" ? 0 : 1;
    });
    const geometry = this.object.geometry;
    geometry.setDrawRange(0, count * 2);
    for (const name of ["aColor", "aAlong", "aSeed", "aFlow"]) {
      (geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Move every line to where its two nodes are now, easing its strength towards what was asked. */
  update(links: DrawnLink[], seconds: number, ease: number, flowing: boolean): void {
    if (this.fixed === null) return;
    this.material.uniforms.uTime!.value = flowing ? seconds : 0.4;
    const { position, alpha, length } = this;
    for (let i = 0; i < links.length; i++) {
      const drawn = links[i]!;
      const s = drawn.source;
      const t = drawn.target;
      const sx = s.x ?? 0;
      const sy = s.y ?? 0;
      const sz = s.z ?? 0;
      const tx = t.x ?? 0;
      const ty = t.y ?? 0;
      const tz = t.z ?? 0;
      const p = i * 6;
      position[p] = sx;
      position[p + 1] = sy;
      position[p + 2] = sz;
      position[p + 3] = tx;
      position[p + 4] = ty;
      position[p + 5] = tz;
      drawn.alpha += (drawn.alphaTo - drawn.alpha) * ease;
      alpha[i * 2] = alpha[i * 2 + 1] = drawn.alpha;
      length[i * 2] = length[i * 2 + 1] = Math.hypot(tx - sx, ty - sy, tz - sz);
    }
    const geometry = this.object.geometry;
    for (const name of ["position", "aAlpha", "aLength"]) {
      (geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * The relationships of the selected node, drawn again as thick lines of a steady width on
 * screen, so that they stand out at any distance.
 */
export class StrongLinks {
  readonly object: LineSegments2;
  private readonly material: LineMaterial;
  private capacity = 0;

  constructor(scene: THREE.Scene) {
    this.material = new LineMaterial({
      linewidth: 2.4,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      opacity: LIGHT ? 0.9 : 0.85,
      blending: LIGHT ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.object = new LineSegments2(new LineSegmentsGeometry(), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    this.object.visible = false;
    this.object.raycast = () => {};
    scene.add(this.object);
  }

  update(links: DrawnLink[]): void {
    let count = 0;
    for (const drawn of links) if (drawn.strong) count++;
    this.object.visible = count > 0;
    if (count === 0) return;

    const geometry = this.object.geometry;
    if (count > this.capacity) {
      this.capacity = Math.max(count, this.capacity * 2, 32);
      geometry.setPositions(new Float32Array(this.capacity * 6));
      geometry.setColors(new Float32Array(this.capacity * 6));
    }
    const places = (geometry.getAttribute("instanceStart") as THREE.InterleavedBufferAttribute).data;
    const colors = (geometry.getAttribute("instanceColorStart") as THREE.InterleavedBufferAttribute).data;
    const position = places.array as Float32Array;
    const color = colors.array as Float32Array;
    let i = 0;
    for (const drawn of links) {
      if (!drawn.strong) continue;
      const p = i * 6;
      position[p] = drawn.source.x ?? 0;
      position[p + 1] = drawn.source.y ?? 0;
      position[p + 2] = drawn.source.z ?? 0;
      position[p + 3] = drawn.target.x ?? 0;
      position[p + 4] = drawn.target.y ?? 0;
      position[p + 5] = drawn.target.z ?? 0;
      color.set(drawn.rgb, p);
      color.set(drawn.rgb, p + 3);
      i++;
    }
    places.needsUpdate = true;
    colors.needsUpdate = true;
    geometry.instanceCount = count;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
