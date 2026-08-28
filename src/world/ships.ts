/**
 * Bay shipping — cargo ships and sailboats on curated lanes
 * (docs/architecture.md §4.17). SF has no river centre-lines, so ships
 * walk PM-curated WGS84 polylines via `PathWalker` (`reverseAtEnds`) the
 * same way Thames boats walk OSM rivers. Hulls and unlit running-lights
 * are one `InstancedMesh` pair per class; `setNight` toggles the lights.
 */
import * as THREE from 'three';
import { mulberry32 } from '../data/synthetic';
import { FLAT_HEIGHT } from '../data/types';
import type { CityData, HeightFn, RoadClass, Vec2 } from '../data/types';
import { project } from '../geo';
import { MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';
import { buildRoadGraph, PathWalker } from './traffic';

/** Metres steamed per second by a cargo ship. */
const CARGO_SPEED_MPS = 6;

/** Metres sailed per second by a sailboat. */
const SAIL_SPEED_MPS = 3;

const UV: UV = [0, 0];

/** One curated shipping lane: a WGS84 polyline plus how many ships sail it. */
export interface ShipLane {
  /** Display name, e.g. `'Shipping channel'`. */
  name: string;
  /** Hull class — selects geometry, lights and speed. */
  kind: 'cargo' | 'sail';
  /** WGS84 vertices as `[lon, lat]` (walked in order, reversed at the ends). */
  pts: [number, number][];
  /** Number of ships instanced on this lane. */
  count: number;
}

/**
 * Per-city shipping lanes (architecture.md §4.17). Only `sf` has entries;
 * any other city id yields an inert fleet (`count 0`).
 */
export const SHIP_LANES: Readonly<Record<string, readonly ShipLane[]>> = {
  sf: [
    {
      name: 'Shipping channel',
      kind: 'cargo',
      pts: [
        [-122.4865, 37.8215],
        [-122.4786, 37.8198],
        [-122.46, 37.8235],
        [-122.43, 37.833],
        [-122.405, 37.828],
        [-122.385, 37.816],
      ],
      count: 3,
    },
    {
      name: 'Marina reach',
      kind: 'sail',
      pts: [
        [-122.47, 37.812],
        [-122.455, 37.8205],
        [-122.445, 37.813],
        [-122.433, 37.8185],
      ],
      count: 6,
    },
    {
      name: 'Alcatraz reach',
      kind: 'sail',
      pts: [
        [-122.43, 37.816],
        [-122.418, 37.8225],
        [-122.41, 37.815],
        [-122.412, 37.8125],
      ],
      count: 6,
    },
  ],
};

/** Linear rgb of `hex` via `THREE.Color` (working colour space). */
function linearRgb(hex: number): Vec3 {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const CARGO_HULL = linearRgb(0x7a2e2e);
const CONTAINER_COLORS: readonly Vec3[] = [
  linearRgb(0x2e6f9e),
  linearRgb(0x8a8a2e),
  linearRgb(0x9e4a2e),
  linearRgb(0x3d7a4a),
];
const SUPERSTRUCTURE = linearRgb(0xe6e6e6);
const FUNNEL = linearRgb(0x333333);
const LIGHT_WARM = linearRgb(0xfff2c0);
const LIGHT_BRIDGE = linearRgb(0xffe9a0);
const LIGHT_RED = linearRgb(0xff2020);
const LIGHT_GREEN = linearRgb(0x20ff40);
const LIGHT_WHITE = linearRgb(0xffffff);
const SAIL_HULL = linearRgb(0xf0f0f0);
const SAIL_CANVAS = linearRgb(0xfaf3dc);

/**
 * Axis-aligned box in the ship local frame (+z bow, y up): six faces,
 * outward normals, linear rgb vertex colours.
 */
function box(
  mesh: MeshBuilder,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  color: Vec3,
): void {
  let xa = x0;
  let xb = x1;
  let ya = y0;
  let yb = y1;
  let za = z0;
  let zb = z1;
  if (xa > xb) {
    const t = xa;
    xa = xb;
    xb = t;
  }
  if (ya > yb) {
    const t = ya;
    ya = yb;
    yb = t;
  }
  if (za > zb) {
    const t = za;
    za = zb;
    zb = t;
  }
  if (xb - xa < 1e-6 || yb - ya < 1e-6 || zb - za < 1e-6) return;
  const nx: Vec3 = [-1, 0, 0];
  const px: Vec3 = [1, 0, 0];
  const ny: Vec3 = [0, -1, 0];
  const py: Vec3 = [0, 1, 0];
  const nz: Vec3 = [0, 0, -1];
  const pz: Vec3 = [0, 0, 1];
  // −X
  mesh.quad([xa, ya, za], [xa, ya, zb], [xa, yb, zb], [xa, yb, za], nx, UV, UV, UV, UV, color);
  // +X
  mesh.quad([xb, ya, zb], [xb, ya, za], [xb, yb, za], [xb, yb, zb], px, UV, UV, UV, UV, color);
  // −Y
  mesh.quad([xa, ya, zb], [xa, ya, za], [xb, ya, za], [xb, ya, zb], ny, UV, UV, UV, UV, color);
  // +Y
  mesh.quad([xa, yb, za], [xa, yb, zb], [xb, yb, zb], [xb, yb, za], py, UV, UV, UV, UV, color);
  // −Z (stern)
  mesh.quad([xb, ya, za], [xa, ya, za], [xa, yb, za], [xb, yb, za], nz, UV, UV, UV, UV, color);
  // +Z (bow)
  mesh.quad([xa, ya, zb], [xb, ya, zb], [xb, yb, zb], [xa, yb, zb], pz, UV, UV, UV, UV, color);
}

/** Cube of side `side` centred at `(x, y, z)`. */
function cube(mesh: MeshBuilder, x: number, y: number, z: number, side: number, color: Vec3): void {
  const h = side / 2;
  box(mesh, x - h, x + h, y - h, y + h, z - h, z + h, color);
}

/** Cargo hull, containers, superstructure and funnel; waterline at local y = 0. */
function buildCargoHull(): MeshData {
  const mesh = new MeshBuilder();
  // Hull 280 long × 40 wide, y −2…+14.
  box(mesh, -20, 20, -2, 14, -140, 140, CARGO_HULL);
  // 2 across × 4 along container stacks on the forward deck (y 14…26).
  // 30 m wide boxes centred at x = ±5 stay inside the 40 m beam.
  const zCenters = [-72.5, -22.5, 27.5, 77.5];
  const xCenters = [-5, 5];
  let n = 0;
  for (const zc of zCenters) {
    for (const xc of xCenters) {
      const color = CONTAINER_COLORS[n % CONTAINER_COLORS.length]!;
      n++;
      box(mesh, xc - 15, xc + 15, 14, 26, zc - 25, zc + 25, color);
    }
  }
  // Superstructure at the stern (z −110), 30 × 25 × 22 on the deck.
  box(mesh, -15, 15, 14, 36, -122.5, -97.5, SUPERSTRUCTURE);
  // Funnel 8 × 8 × 10 on top of the superstructure.
  box(mesh, -4, 4, 36, 46, -114, -106, FUNNEL);
  return mesh.build();
}

/** Unlit cargo running lights (toggled by `setNight`). */
function buildCargoLights(): MeshData {
  const mesh = new MeshBuilder();
  // 12 warm-white 1.5 m cubes along each hull side at y 14, every 22 m.
  for (let i = 0; i < 12; i++) {
    const z = -121 + i * 22;
    cube(mesh, -20, 14, z, 1.5, LIGHT_WARM);
    cube(mesh, 20, 14, z, 1.5, LIGHT_WARM);
  }
  // Bridge windows: 20 × 3 m yellow slab on the superstructure's bow face.
  box(mesh, -10, 10, 28.5, 31.5, -97.5, -97, LIGHT_BRIDGE);
  // Nav lights at the bow; white masthead on the funnel top.
  cube(mesh, -20, 14, 140, 2, LIGHT_RED);
  cube(mesh, 20, 14, 140, 2, LIGHT_GREEN);
  cube(mesh, 0, 47, -110, 2, LIGHT_WHITE);
  return mesh.build();
}

/** Sailboat hull, mast and two-sided mainsail; waterline at local y = 0. */
function buildSailHull(): MeshData {
  const mesh = new MeshBuilder();
  box(mesh, -2, 2, -0.6, 1.4, -6, 6, SAIL_HULL);
  // Mast 0.4 × 0.4 from the deck up to y 17.
  box(mesh, -0.2, 0.2, 1.4, 17, -0.2, 0.2, SAIL_HULL);
  // Mainsail: triangle at x = 0 (y-z plane), boom pointing −z (stern), both windings.
  const top: Vec3 = [0, 17, 0];
  const boomMast: Vec3 = [0, 2, 0];
  const boomStern: Vec3 = [0, 2, -5];
  const nStarboard: Vec3 = [1, 0, 0];
  const nPort: Vec3 = [-1, 0, 0];
  mesh.triangle(top, boomMast, boomStern, nStarboard, UV, UV, UV, SAIL_CANVAS);
  mesh.triangle(top, boomStern, boomMast, nPort, UV, UV, UV, SAIL_CANVAS);
  return mesh.build();
}

/** Unlit sailboat running lights (toggled by `setNight`). */
function buildSailLights(): MeshData {
  const mesh = new MeshBuilder();
  cube(mesh, 0, 17.5, 0, 1, LIGHT_WHITE);
  cube(mesh, -2, 1.4, 6, 0.6, LIGHT_RED);
  cube(mesh, 2, 1.4, 6, 0.6, LIGHT_GREEN);
  return mesh.build();
}

/** Isolated polyline graph for one lane (same trick `BoatFleet` uses on rivers). */
function laneGraph(pts: Vec2[], id: number) {
  return buildRoadGraph(
    [{ id, cls: 'primary' as RoadClass, pts }],
    ['primary'],
  );
}

/**
 * Instanced cargo + sail fleet on a city's curated lanes. Empty / unknown
 * city → `count 0`, an empty `Group`, and a no-op `update`.
 */
export class ShipFleet {
  /** Scene object: a Group of up to four InstancedMeshes (hull + lights × class). */
  readonly object: THREE.Object3D;
  /** Total ships currently sailing (0 when the city has no lanes). */
  readonly count: number;
  private readonly heightAt: HeightFn;
  private readonly dummy: THREE.Object3D;
  private readonly cargoWalkers: PathWalker[] = [];
  private readonly sailWalkers: PathWalker[] = [];
  private cargoHull: THREE.InstancedMesh | null = null;
  private cargoLights: THREE.InstancedMesh | null = null;
  private sailHull: THREE.InstancedMesh | null = null;
  private sailLights: THREE.InstancedMesh | null = null;
  private _lightsOn = false;

  /**
   * Project `SHIP_LANES[cityId]` into local metres, spawn `count` ping-pong
   * walkers per lane (`mulberry32(seed + i)`, `reverseAtEnds`), and build
   * one hull + lights instanced pair per class. `heightAt` seats each hull
   * on the water (waterline at local y = 0).
   */
  constructor(cityId: string, city: CityData, heightAt: HeightFn = FLAT_HEIGHT, seed = 23) {
    this.heightAt = heightAt;
    this.dummy = new THREE.Object3D();
    const group = new THREE.Group();
    this.object = group;

    const lanes = SHIP_LANES[cityId] ?? [];
    let i = 0;
    for (const lane of lanes) {
      const pts: Vec2[] = lane.pts.map(([lon, lat]) => project(lon, lat, city.origin));
      const graph = laneGraph(pts, i);
      if (graph.edges.length === 0) continue;
      const dest = lane.kind === 'cargo' ? this.cargoWalkers : this.sailWalkers;
      for (let k = 0; k < lane.count; k++) {
        dest.push(new PathWalker(graph, mulberry32(seed + i), true));
        i++;
      }
    }
    this.count = this.cargoWalkers.length + this.sailWalkers.length;
    if (this.count === 0) return;

    const nCargo = this.cargoWalkers.length;
    const nSail = this.sailWalkers.length;
    if (nCargo > 0) {
      this.cargoHull = new THREE.InstancedMesh(
        toGeometry(buildCargoHull()),
        new THREE.MeshLambertMaterial({ vertexColors: true }),
        nCargo,
      );
      this.cargoLights = new THREE.InstancedMesh(
        toGeometry(buildCargoLights()),
        new THREE.MeshBasicMaterial({ vertexColors: true }),
        nCargo,
      );
      this.cargoLights.visible = false;
      group.add(this.cargoHull);
      group.add(this.cargoLights);
    }
    if (nSail > 0) {
      this.sailHull = new THREE.InstancedMesh(
        toGeometry(buildSailHull()),
        new THREE.MeshLambertMaterial({ vertexColors: true }),
        nSail,
      );
      this.sailLights = new THREE.InstancedMesh(
        toGeometry(buildSailLights()),
        new THREE.MeshBasicMaterial({ vertexColors: true }),
        nSail,
      );
      this.sailLights.visible = false;
      group.add(this.sailHull);
      group.add(this.sailLights);
    }
  }

  /** Whether the running-lights meshes are currently visible. */
  get lightsOn(): boolean {
    return this._lightsOn;
  }

  /** Show or hide both classes' unlit lights meshes. */
  setNight(on: boolean): void {
    this._lightsOn = on;
    if (this.cargoLights) this.cargoLights.visible = on;
    if (this.sailLights) this.sailLights.visible = on;
  }

  /**
   * Advance every ship by `dt · speed` metres and write the same matrix
   * into its hull and lights instances via one reused dummy — no allocation.
   * No-op when `count` is 0.
   */
  update(dt: number): void {
    if (this.count === 0) return;
    this.writeClass(this.cargoWalkers, dt * CARGO_SPEED_MPS, this.cargoHull, this.cargoLights);
    this.writeClass(this.sailWalkers, dt * SAIL_SPEED_MPS, this.sailHull, this.sailLights);
  }

  /** Advance one class's walkers and stamp hull + lights instance matrices. */
  private writeClass(
    walkers: PathWalker[],
    step: number,
    hull: THREE.InstancedMesh | null,
    lights: THREE.InstancedMesh | null,
  ): void {
    if (!hull || walkers.length === 0) return;
    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i]!;
      w.advance(step);
      this.dummy.position.set(w.x, this.heightAt(w.x, w.z), w.z);
      this.dummy.rotation.y = -w.heading;
      this.dummy.updateMatrix();
      hull.setMatrixAt(i, this.dummy.matrix);
      lights?.setMatrixAt(i, this.dummy.matrix);
    }
    hull.instanceMatrix.needsUpdate = true;
    if (lights) lights.instanceMatrix.needsUpdate = true;
  }
}
