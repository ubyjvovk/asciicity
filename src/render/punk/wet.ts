/**
 * Neon-and-wet dressing for the cyberpunk style (wave 20). Browser-only.
 *
 * While the style is active, meshes tagged by the world builders
 * (`userData.surface`: `buildings`, `road`, `water`, `ground`, `terrain`)
 * get physically-based node materials: facades with lit windows in a neon
 * palette (emissive → bloom), and rain-soaked streets, roofs, hills and
 * water — low roughness puddles with animated ripple normals (ported from
 * ektogamat/threejs-conference `createGround.js`, MIT) that the SSR pass
 * reflects. Every original material is kept and restored on `restore`, so
 * the WebGL styles never see a node material.
 */
import * as THREE from 'three/webgpu';
import {
  cameraViewMatrix,
  float,
  floor,
  fract,
  hash,
  mix,
  mx_noise_float,
  normalWorld,
  normalize,
  positionWorld,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { rainRipples } from './ripples';

type Surface = 'buildings' | 'road' | 'water' | 'ground' | 'terrain';

const SURFACES: ReadonlySet<string> = new Set(['buildings', 'road', 'water', 'ground', 'terrain']);

/** Window light palette (linear RGB): sodium, cool white, cyan, magenta. */
const WARM = vec3(1.0, 0.55, 0.22);
const COOL = vec3(0.62, 0.72, 1.0);
const CYAN = vec3(0.1, 0.85, 1.0);
const MAGENTA = vec3(1.0, 0.12, 0.62);

/** Swaps materials on tagged meshes and restores them. */
export class WetDressing {
  private readonly originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private readonly mats: Record<Surface | 'roof', THREE.MeshStandardNodeMaterial>;
  /** Running time (s), drives the ripples. */
  readonly uTime = uniform(0);
  /** Master switch for ripple strength (0 when the rain is off). */
  readonly uRain = uniform(1);

  constructor(windowTex: THREE.Texture | null) {
    const ripple = (scale: number, strength: Node<'float'>) => {
      const r = rainRipples(positionWorld.xz.mul(scale), this.uTime.mul(3));
      const up = smoothstep(0.6, 0.9, normalWorld.y);
      const n = normalize(normalWorld.add(vec3(r.x, 0, r.y).mul(strength).mul(up).mul(this.uRain)));
      return normalize(cameraViewMatrix.mul(vec4(n, 0)).xyz);
    };
    // Puddle mask: 0 = damp asphalt, 1 = standing water (world-space noise).
    const puddle = smoothstep(0.05, 0.35, mx_noise_float(positionWorld.xz.mul(0.09)));

    const road = new THREE.MeshStandardNodeMaterial();
    road.colorNode = vertexColor().rgb.mul(mix(float(0.16), float(0.05), puddle));
    road.roughnessNode = mix(float(0.42), float(0.04), puddle);
    road.metalnessNode = mix(float(0.25), float(0.85), puddle);
    road.normalNode = ripple(4.8, mix(float(0.15), float(1.1), puddle));

    const ground = new THREE.MeshStandardNodeMaterial();
    ground.colorNode = vec3(0.022, 0.022, 0.03);
    ground.roughnessNode = mix(float(0.55), float(0.08), puddle);
    ground.metalnessNode = mix(float(0.15), float(0.75), puddle);
    ground.normalNode = ripple(4.8, mix(float(0.1), float(0.9), puddle));

    const terrain = new THREE.MeshStandardNodeMaterial();
    terrain.colorNode = vertexColor().rgb.mul(0.05);
    terrain.roughnessNode = mix(float(0.6), float(0.15), puddle);
    terrain.metalnessNode = mix(float(0.1), float(0.6), puddle);
    terrain.normalNode = ripple(4.8, mix(float(0.1), float(0.8), puddle));

    const water = new THREE.MeshStandardNodeMaterial();
    water.colorNode = vec3(0.006, 0.01, 0.02);
    water.roughnessNode = float(0.03);
    water.metalnessNode = float(0.95);
    water.normalNode = ripple(2.2, float(1.4));

    const roof = new THREE.MeshStandardNodeMaterial();
    roof.colorNode = vertexColor().rgb.mul(0.07);
    roof.roughnessNode = mix(float(0.4), float(0.1), puddle);
    roof.metalnessNode = mix(float(0.2), float(0.7), puddle);
    roof.normalNode = ripple(4.8, float(0.7));

    const walls = new THREE.MeshStandardNodeMaterial();
    if (windowTex) {
      const tex = texture(windowTex);
      walls.colorNode = tex.rgb.mul(vertexColor().rgb).mul(0.22);
      // Window cell (8×8 per texture repeat) → stable per-window random.
      const cell = floor(uv().mul(8));
      const id = cell.x.add(cell.y.mul(131.0)).add(floor(positionWorld.x.div(9)).mul(7.3)).add(floor(positionWorld.z.div(9)).mul(3.1));
      const h1 = hash(id);
      const h2 = hash(id.add(17.0));
      const lit = step(0.9, tex.r).mul(step(h2, 0.42));
      const tint = select(
        h1.lessThan(0.5),
        WARM,
        select(h1.lessThan(0.72), COOL, select(h1.lessThan(0.87), CYAN, MAGENTA)),
      );
      // Slow flicker on a few percent of the neon windows.
      const flick = select(h2.lessThan(0.03), fract(this.uTime.mul(h1.add(0.5)).mul(3)).step(0.15).oneMinus(), float(1));
      walls.emissiveNode = tint.mul(lit).mul(flick).mul(h2.mul(1.6).add(0.35));
    } else {
      walls.colorNode = vertexColor().rgb.mul(0.2);
    }
    walls.roughnessNode = float(0.5);
    walls.metalnessNode = float(0.1);

    this.mats = { buildings: walls, roof, road, water, ground, terrain };
  }

  /** Dress every tagged mesh under `root` that is not dressed yet. Cheap to call repeatedly. */
  apply(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const surface = o.userData.surface;
      if (typeof surface !== 'string' || !SURFACES.has(surface)) return;
      if (this.originals.has(o)) return;
      this.originals.set(o, o.material);
      o.material =
        surface === 'buildings'
          ? [this.mats.buildings, this.mats.roof]
          : this.mats[surface as Surface];
    });
  }

  /** Put every original material back. */
  restore(): void {
    for (const [mesh, mat] of this.originals) mesh.material = mat;
    this.originals.clear();
  }

  /** Restore the originals under `root` (a tile about to be disposed) and forget them. */
  release(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mat = this.originals.get(o);
      if (mat === undefined) return;
      o.material = mat;
      this.originals.delete(o);
    });
  }

  /** Free the shared node materials. */
  dispose(): void {
    this.restore();
    for (const m of Object.values(this.mats)) m.dispose();
  }
}
