/**
 * Cyberpunk layer `props` (wave 20b, T-0155): sodium street lamps with
 * faux-volumetric light cones and warm ground pools, overhead cables, and
 * ≤ 4 nearest-lamp point lights. Geometry from the pure `propsmesh.ts`;
 * this layer streams it in cells and owns the shared node materials.
 * Contract: `layer.ts` and docs/architecture.md §4.11 "cyberpunk v2".
 */
import * as THREE from 'three/webgpu';
import { float, uv, vec3, vertexColor } from 'three/tsl';
import type { PunkLayer, PunkLayerContext } from './layer';
import { CellStreamer, type CellData } from './cells';
import { buildPropsMesh, placeCables, placeLamps, type Cable, type Lamp } from './propsmesh';
import { toGeometry } from '../../world/mesh';

/** Sodium head emissive colour (linear-ish). */
const SODIUM = vec3(1.0, 0.55, 0.2);

/** Cell streaming radii for props (contract: 450 / 600 m). */
const BUILD_RADIUS = 450;
const DISPOSE_RADIUS = 600;
/** Number of real point lights on the nearest lamps. */
const LIGHT_COUNT = 4;
/** Reassign point lights this often, seconds. */
const LIGHT_INTERVAL = 0.5;

/** The `props` layer implementation. */
export class PropsLayer implements PunkLayer {
  readonly id = 'props';
  readonly rainPassThrough = true;

  private root: THREE.Group | null = null;
  private streamer: CellStreamer | null = null;
  private solidBody: THREE.MeshStandardNodeMaterial | null = null;
  private solidHead: THREE.MeshStandardNodeMaterial | null = null;
  private coneMat: THREE.MeshBasicNodeMaterial | null = null;
  private poolMat: THREE.MeshBasicNodeMaterial | null = null;
  private readonly lights: THREE.PointLight[] = [];
  /** Built-cell lamp positions, keyed by cell key (for point-light targeting). */
  private readonly lamps = new Map<string, Lamp[]>();
  private readonly cellTris = new Map<string, number>();
  private triangles = 0;
  private lampCount = 0;
  private cableCount = 0;
  private lightTimer = 0;

  /** Create the `props` layer. */
  constructor() {
    for (let i = 0; i < LIGHT_COUNT; i++) {
      const l = new THREE.PointLight(0xffb24d, 30, 18, 2);
      l.visible = false;
      this.lights.push(l);
    }
  }

  /** Create materials, point lights and the cell streamer; seed the first cells. */
  attach(ctx: PunkLayerContext, root: THREE.Group): void {
    this.root = root;

    const solidBody = new THREE.MeshStandardNodeMaterial();
    solidBody.colorNode = vertexColor();
    solidBody.roughness = 0.5;
    solidBody.metalness = 0.3;
    solidBody.side = THREE.DoubleSide;
    solidBody.fog = true;
    this.solidBody = solidBody;

    const solidHead = new THREE.MeshStandardNodeMaterial();
    solidHead.colorNode = vertexColor();
    solidHead.emissiveNode = SODIUM.mul(3);
    solidHead.roughness = 0.4;
    solidHead.metalness = 0.2;
    solidHead.fog = true;
    this.solidHead = solidHead;

    const coneMat = new THREE.MeshBasicNodeMaterial();
    coneMat.transparent = true;
    coneMat.depthWrite = false;
    coneMat.blending = THREE.AdditiveBlending;
    coneMat.opacityNode = float(0.06).mul(float(1).sub(uv().y));
    coneMat.fog = true;
    this.coneMat = coneMat;

    const poolMat = new THREE.MeshBasicNodeMaterial();
    poolMat.transparent = true;
    poolMat.depthWrite = false;
    poolMat.blending = THREE.AdditiveBlending;
    poolMat.opacityNode = float(0.22).mul(float(1).sub(uv().x));
    poolMat.fog = true;
    this.poolMat = poolMat;

    for (const l of this.lights) root.add(l);

    this.streamer = new CellStreamer({
      buildRadius: BUILD_RADIUS,
      disposeRadius: DISPOSE_RADIUS,
      maxBuildsPerFrame: 1,
      build: (cell) => this.buildCell(ctx, cell),
      dispose: (obj) => this.disposeCell(obj),
    });
    const cam = ctx.camera.position;
    this.streamer.update(ctx.sources, cam.x, cam.z, root);
  }

  /** Stream cells each frame and re-target the point lights every 0.5 s. */
  update(ctx: PunkLayerContext, timeS: number, dtS: number): void {
    if (!this.streamer || !this.root) return;
    const cam = ctx.camera.position;
    this.streamer.update(ctx.sources, cam.x, cam.z, this.root);
    this.lightTimer += dtS;
    if (this.lightTimer >= LIGHT_INTERVAL) {
      this.lightTimer = 0;
      this.reassignLights(ctx);
    }
  }

  /** Remove streamed cells and point lights from the scene. */
  detach(_ctx: PunkLayerContext): void {
    if (this.streamer && this.root) this.streamer.clear(this.root);
    if (this.root) for (const l of this.lights) this.root.remove(l);
    this.root = null;
    this.lamps.clear();
    this.cellTris.clear();
    this.lampCount = 0;
    this.cableCount = 0;
    this.triangles = 0;
  }

  /** Free shared materials and point lights. */
  dispose(): void {
    this.solidBody?.dispose();
    this.solidHead?.dispose();
    this.coneMat?.dispose();
    this.poolMat?.dispose();
    this.solidBody = this.solidHead = this.coneMat = this.poolMat = null;
    for (const l of this.lights) l.dispose();
  }

  /** Flat debug stats: lamps, cables, lights, triangles, streamer. */
  stats(): Record<string, number> {
    const s = this.streamer?.stats() ?? { cells: 0, pending: 0, buildMs: 0 };
    let active = 0;
    for (const l of this.lights) if (l.visible) active++;
    return {
      lamps: this.lampCount,
      cables: this.cableCount,
      lights: active,
      triangles: this.triangles,
      cells: s.cells,
      pending: s.pending,
      buildMs: s.buildMs,
    };
  }

  /** Build the three meshes for one streamed cell. */
  private buildCell(ctx: PunkLayerContext, cell: CellData): THREE.Group {
    const lamps = placeLamps(cell.roads, ctx.groundAt, cell.buildings);
    const cables = placeCables(cell.roads, ctx.groundAt, cell.buildings);
    const { solid, cones, pools } = buildPropsMesh(lamps, cables);
    const group = new THREE.Group();
    group.name = cell.key;

    const solidMesh = new THREE.Mesh(
      toGeometry(solid),
      [this.solidBody as THREE.MeshStandardNodeMaterial, this.solidHead as THREE.MeshStandardNodeMaterial],
    );
    const coneMesh = new THREE.Mesh(toGeometry(cones), this.coneMat as THREE.MeshBasicNodeMaterial);
    const poolMesh = new THREE.Mesh(toGeometry(pools), this.poolMat as THREE.MeshBasicNodeMaterial);
    group.add(solidMesh, coneMesh, poolMesh);

    const tri = Math.floor((solid.positions.length + cones.positions.length + pools.positions.length) / 9);
    group.userData = { key: cell.key, tri };
    this.lamps.set(cell.key, lamps);
    this.cellTris.set(cell.key, tri);
    this.triangles += tri;
    this.lampCount += lamps.length;
    this.cableCount += cables.length;
    return group;
  }

  /** Free one cell's geometry and its accounting. */
  private disposeCell(obj: THREE.Object3D): void {
    const key = obj.userData.key as string | undefined;
    if (key) {
      this.lamps.delete(key);
      const tri = this.cellTris.get(key) ?? 0;
      this.triangles -= tri;
      this.cellTris.delete(key);
    }
    obj.traverse((o) => {
      if ((o as { isMesh?: boolean }).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
  }

  /** Re-point the ≤ 4 lights at the nearest lamps within 60° of the view direction. */
  private reassignLights(ctx: PunkLayerContext): void {
    const cam = ctx.camera.position;
    const fwd = ctx.camera.getWorldDirection(new THREE.Vector3());
    const cos60 = 0.5;
    const cand: { lamp: Lamp; d: number }[] = [];
    for (const arr of this.lamps.values()) {
      for (const lamp of arr) {
        const dx = lamp.x - cam.x;
        const dy = lamp.y - cam.y;
        const dz = lamp.z - cam.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) continue;
        const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d;
        if (dot >= cos60) cand.push({ lamp, d });
      }
    }
    cand.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      if (i < cand.length) {
        const lamp = cand[i].lamp;
        l.position.set(lamp.x + lamp.dirX * 1.8, lamp.y + 7, lamp.z + lamp.dirZ * 1.8);
        l.visible = true;
      } else {
        l.visible = false;
      }
    }
  }
}

/** Create the `props` layer. */
export function createPropsLayer(): PunkLayer {
  return new PropsLayer();
}
