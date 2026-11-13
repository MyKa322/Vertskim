import * as THREE from "three";

/** A small repeatable source of numbers, so the sky is the same on every visit. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Faint points far behind the graph. They do nothing but give the eye something to measure
 * the camera's movement against, which is most of what makes the scene read as deep.
 */
export function makeStars(
  scene: THREE.Scene,
  pixelRatio: number,
): { follow(camera: THREE.Camera): void; dispose(): void } {
  const count = 1100;
  const random = seeded(7);
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const tint = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // Evenly over a thick shell around the scene.
    const z = random() * 2 - 1;
    const turn = random() * Math.PI * 2;
    const flat = Math.sqrt(1 - z * z);
    const distance = 20000 + random() * 20000;
    position[i * 3] = Math.cos(turn) * flat * distance;
    position[i * 3 + 1] = z * distance;
    position[i * 3 + 2] = Math.sin(turn) * flat * distance;
    // Mostly dim, a few brighter; a shade of blue or of amber.
    const brightness = 0.1 + random() ** 3 * 0.42;
    tint.setHSL(random() < 0.7 ? 0.6 : 0.09, 0.45, brightness);
    color[i * 3] = tint.r;
    color[i * 3 + 1] = tint.g;
    color[i * 3 + 2] = tint.b;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  const material = new THREE.PointsMaterial({
    size: 1.6 * pixelRatio,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  stars.raycast = () => {};
  scene.add(stars);
  return {
    /** Keep the sky centred on the camera: it turns past, but can never be flown up to. */
    follow(camera) {
      camera.getWorldPosition(stars.position);
    },
    dispose() {
      stars.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
