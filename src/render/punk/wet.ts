/**
 * Neon-and-wet dressing for the cyberpunk style (wave 20). Browser-only.
 *
 * While the style is active, meshes tagged by the world builders
 * (`userData.surface`: `buildings`, `road`, `water`, `ground`, `terrain`)
 * get physically-based node materials from `facade.ts` (walls, roofs) and
 * `street.ts` (roads, ground, terrain, water) — ripple normals and puddle
 * masks after ektogamat/threejs-conference `createGround.js` (MIT). Every original material is kept and restored on `restore`, so
 * the WebGL styles never see a node material.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { makeFacadeMaterials } from './facade';
import { makeStreetMaterials } from './street';

type Surface = 'buildings' | 'road' | 'water' | 'ground' | 'terrain';

const SURFACES: ReadonlySet<string> = new Set(['buildings', 'road', 'water', 'ground', 'terrain']);

/** Swaps materials on tagged meshes and restores them. Materials live in facade.ts / street.ts. */
export class WetDressing {
  private readonly originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private readonly mats: Record<Surface | 'roof', THREE.MeshStandardNodeMaterial>;
  /** Running time (s), drives the ripples. */
  readonly uTime = uniform(0);
  /** Master switch for ripple strength (0 when the rain is off). */
  readonly uRain = uniform(1);

  constructor(windowTex: THREE.Texture | null) {
    const u = { uTime: this.uTime, uRain: this.uRain };
    const f = makeFacadeMaterials(windowTex, u);
    const st = makeStreetMaterials(u);
    this.mats = { buildings: f.walls, roof: f.roof, road: st.road, water: st.water, ground: st.ground, terrain: st.terrain };
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
