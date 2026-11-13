import * as THREE from "three";
import { LIGHT } from "../theme";

const VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPixelsPerUnit;
  uniform float uMinSize;
  uniform float uMaxSize;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 eye = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * eye;
    // aSize is a width in the world; this is how many pixels that is from here.
    gl_PointSize = clamp(aSize * uPixelsPerUnit / max(-eye.z, 0.001), uMinSize, uMaxSize);
    vColor = aColor;
    vAlpha = aAlpha;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uFalloff;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = pow(max(1.0 - d, 0.0), uFalloff) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

/**
 * Soft round lights, all drawn in one go: the halo round every node, and the sparks that run
 * along the lines of the selection. Filled afresh every frame with `begin`, `add` and `end`.
 */
export class LightPoints {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private capacity = 0;
  private count = 0;
  private position = new Float32Array(0);
  private color = new Float32Array(0);
  private size = new Float32Array(0);
  private alpha = new Float32Array(0);

  /**
   * `falloff`: how quickly the light dies away from the middle; higher is a tighter point.
   * `minSize`: the fewest pixels a point is drawn across, however far away it is.
   */
  constructor(scene: THREE.Scene, falloff: number, renderOrder: number, minSize = 0) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelsPerUnit: { value: 1 },
        uMinSize: { value: minSize },
        uMaxSize: { value: 512 },
        uFalloff: { value: falloff },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Light adds up on a dark ground; on a light one it has to be laid over as a tint.
      blending: LIGHT ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.object = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = renderOrder;
    // Never something to point at: the pointer goes through to the nodes.
    this.object.raycast = () => {};
    scene.add(this.object);
    this.reserve(256);
  }

  private reserve(wanted: number): void {
    if (wanted <= this.capacity) return;
    const capacity = Math.max(wanted, this.capacity * 2);
    const grow = (old: Float32Array, width: number) => {
      const next = new Float32Array(capacity * width);
      next.set(old);
      return next;
    };
    this.position = grow(this.position, 3);
    this.color = grow(this.color, 3);
    this.size = grow(this.size, 1);
    this.alpha = grow(this.alpha, 1);
    this.capacity = capacity;
    const geometry = this.object.geometry;
    geometry.dispose();
    const dynamic = (array: Float32Array, width: number) => {
      const attribute = new THREE.BufferAttribute(array, width);
      attribute.setUsage(THREE.DynamicDrawUsage);
      return attribute;
    };
    geometry.setAttribute("position", dynamic(this.position, 3));
    geometry.setAttribute("aColor", dynamic(this.color, 3));
    geometry.setAttribute("aSize", dynamic(this.size, 1));
    geometry.setAttribute("aAlpha", dynamic(this.alpha, 1));
  }

  /** Start a frame. `viewportHeight` is in drawn pixels, `fov` the camera's, in degrees. */
  begin(viewportHeight: number, fov: number, expected: number): void {
    this.reserve(expected);
    this.count = 0;
    this.material.uniforms.uPixelsPerUnit!.value = viewportHeight / (2 * Math.tan((fov * Math.PI) / 360));
    this.material.uniforms.uMaxSize!.value = Math.min(viewportHeight * 0.6, 720);
  }

  add(x: number, y: number, z: number, rgb: readonly [number, number, number], size: number, alpha: number): void {
    if (alpha <= 0.004) return;
    if (this.count >= this.capacity) this.reserve(this.count + 1);
    const i = this.count++;
    this.position[i * 3] = x;
    this.position[i * 3 + 1] = y;
    this.position[i * 3 + 2] = z;
    this.color[i * 3] = rgb[0];
    this.color[i * 3 + 1] = rgb[1];
    this.color[i * 3 + 2] = rgb[2];
    this.size[i] = size;
    this.alpha[i] = alpha;
  }

  end(): void {
    const geometry = this.object.geometry;
    geometry.setDrawRange(0, this.count);
    for (const name of ["position", "aColor", "aSize", "aAlpha"]) {
      (geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
