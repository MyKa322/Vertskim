import * as THREE from "three";
import { FRESH, LIGHT, SELECTION, TRAIL } from "../theme";
import type { SimNode } from "./shared";

type Stamp = "ring" | "dashes" | "glow";

const SIZE = 256;
/** Radius of the drawn rings, as a share of half the picture. */
const RING = 0.8;

function draw(stamp: Stamp): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const middle = SIZE / 2;
  if (stamp === "glow") {
    const fade = ctx.createRadialGradient(middle, middle, 0, middle, middle, middle);
    fade.addColorStop(0, "rgba(255, 255, 255, 0.9)");
    fade.addColorStop(0.25, "rgba(255, 255, 255, 0.35)");
    fade.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, SIZE, SIZE);
  } else {
    const radius = middle * RING;
    ctx.strokeStyle = "#ffffff";
    ctx.lineCap = "round";
    // Drawn twice: once wide and faint for a soft edge, once thin and solid.
    for (const [width, alpha] of [
      [stamp === "ring" ? 16 : 12, 0.22],
      [stamp === "ring" ? 5 : 4, 1],
    ] as const) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      if (stamp === "dashes") {
        const step = (2 * Math.PI * radius) / 24;
        ctx.setLineDash([step * 0.55, step * 0.45]);
      }
      ctx.beginPath();
      ctx.arc(middle, middle, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The marks laid over particular nodes: the reticle on the selection, the ripple where the
 * camera has just been sent, the radar pulse on what the assistant is reading, and the flash
 * on what has just appeared. Each is a flat picture that always faces the camera.
 */
export class Markers {
  private readonly group = new THREE.Group();
  private readonly sprites = new Map<string, THREE.Sprite>();
  private readonly textures: Record<Stamp, THREE.CanvasTexture> = {
    ring: draw("ring"),
    dashes: draw("dashes"),
    glow: draw("glow"),
  };
  private readonly pings: { id: string; start: number }[] = [];
  private readonly eye = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.group.renderOrder = 6;
    scene.add(this.group);
  }

  /** A ripple outwards from a node, to show where the camera has been sent. */
  ping(id: string, now: number): void {
    this.pings.push({ id, start: now });
    if (this.pings.length > 6) this.pings.shift();
  }

  private sprite(key: string, stamp: Stamp, color: string): THREE.Sprite {
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.textures[stamp],
          color,
          transparent: true,
          depthWrite: false,
          // Seen through whatever stands in front: a mark is there to be found.
          depthTest: false,
          blending: LIGHT ? THREE.NormalBlending : THREE.AdditiveBlending,
        }),
      );
      sprite.renderOrder = 6;
      sprite.raycast = () => {};
      this.sprites.set(key, sprite);
      this.group.add(sprite);
    }
    return sprite;
  }

  update(
    now: number,
    nodes: Map<string, SimNode>,
    camera: THREE.Camera,
    selectedId: string | null,
    trail: ReadonlyMap<string, number>,
    fresh: ReadonlyMap<string, number>,
    still: boolean,
  ): void {
    const wanted = new Set<string>();
    camera.getWorldPosition(this.eye);
    const place = (key: string, stamp: Stamp, color: string, id: string, size: number, opacity: number, turn = 0) => {
      const node = nodes.get(id);
      if (!node || node.x === undefined || opacity <= 0.003) return;
      wanted.add(key);
      const sprite = this.sprite(key, stamp, color);
      sprite.position.set(node.x, node.y ?? 0, node.z ?? 0);
      // Never smaller than a fixed share of the view, so a mark on a far node can still be seen.
      const least = stamp === "glow" ? 0 : this.eye.distanceTo(sprite.position) * 0.05;
      sprite.scale.setScalar(Math.max(node.look.radius * size, least));
      sprite.material.opacity = opacity;
      sprite.material.rotation = turn;
    };

    const clock = still ? 0 : now;
    const beat = 0.5 + 0.5 * Math.sin(clock / 300);
    if (selectedId) {
      place(`select:${selectedId}`, "ring", SELECTION, selectedId, 3.8, 0.95);
      place(`select-out:${selectedId}`, "dashes", SELECTION, selectedId, 4.8 + beat * 0.2, 0.55, clock / 2600);
    }
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const ping = this.pings[i]!;
      const t = (now - ping.start) / 900;
      if (t >= 1 || still) {
        this.pings.splice(i, 1);
        continue;
      }
      place(`ping:${ping.id}:${ping.start}`, "ring", SELECTION, ping.id, 4 + t * 11, (1 - t) ** 2 * 0.9);
    }
    for (const [id, until] of trail) {
      const left = Math.min(Math.max((until - now) / 3000, 0), 1); // fades over its last three seconds
      if (left <= 0) continue;
      const wave = still ? 0.4 : (now / 1500) % 1;
      place(`trail:${id}`, "glow", TRAIL, id, 9 + beat * 2, (0.5 + beat * 0.25) * left);
      place(`trail-wave:${id}`, "ring", TRAIL, id, 4 + wave * 8, (1 - wave) ** 1.5 * 0.9 * left);
    }
    for (const [id, until] of fresh) {
      const left = Math.min(Math.max((until - now) / 2000, 0), 1);
      if (left > 0) place(`fresh:${id}`, "glow", FRESH, id, 7 + beat * 3, 0.55 * left);
    }

    for (const [key, sprite] of this.sprites) {
      if (wanted.has(key)) continue;
      this.group.remove(sprite);
      sprite.material.dispose();
      this.sprites.delete(key);
    }
  }

  dispose(): void {
    for (const sprite of this.sprites.values()) sprite.material.dispose();
    this.sprites.clear();
    for (const texture of Object.values(this.textures)) texture.dispose();
    this.group.removeFromParent();
  }
}
