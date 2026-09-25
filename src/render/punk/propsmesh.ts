/**
 * Cyberpunk street props geometry (wave 20b, T-0155): pure builders that
 * place sodium lamps + overhead cables along roads and turn them into
 * `MeshData`. No `three/webgpu` import — unit-testable in plain node.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Street props".
 */
import type { Building, HeightFn, Road, RoadClass, Vec2 } from '../../data/types';
import { MeshBuilder, type MeshData, type UV, type Vec3 } from '../../world/mesh';
import { ROAD_WIDTH } from '../../world/roads';

/** Side of the road / cable the lamp sits on or the cable reaches. */
type Side = 1 | -1;

/** Spatial bucket of building indices on a coarse grid (see {@link makeBuildingBucket}). */
interface BuildingBucket {
  cellSize: number;
  grid: Map<string, number[]>;
  buildings: readonly Building[];
}

/** `true` when `(x, z)` is inside the footprint ring `poly` (ray casting; winding-agnostic). */
export function pointInPolygon(x: number, z: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance from `(x, z)` to the nearest segment of the ring `poly`, metres. */
export function distToPolygon(x: number, z: number, poly: readonly Vec2[]): number {
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[i][0];
    const az = poly[i][1];
    const bx = poly[j][0];
    const bz = poly[j][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 === 0 ? 0 : ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    min = Math.min(min, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
  }
  return min;
}

/**
 * Index building footprints into a `cellSize`-metre grid (each building in every
 * cell its bounding box overlaps) so point queries stay near O(1). Deterministic.
 */
function makeBuildingBucket(buildings: readonly Building[], cellSize = 20): BuildingBucket {
  const grid = new Map<string, number[]>();
  buildings.forEach((b, idx) => {
    if (b.poly.length < 3) return;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of b.poly) {
      if (x < minX) minX = x;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (z > maxZ) maxZ = z;
    }
    const c0x = Math.floor(minX / cellSize);
    const c0z = Math.floor(minZ / cellSize);
    const c1x = Math.floor(maxX / cellSize);
    const c1z = Math.floor(maxZ / cellSize);
    for (let ci = c0x; ci <= c1x; ci++) {
      for (let cj = c0z; cj <= c1z; cj++) {
        const k = `${ci}_${cj}`;
        const arr = grid.get(k);
        if (arr) arr.push(idx);
        else grid.set(k, [idx]);
      }
    }
  });
  return { cellSize, grid, buildings };
}

/** Building indices whose bbox may be near `(x, z)` (the 3×3 cell neighbourhood). */
function bucketNear(bucket: BuildingBucket, x: number, z: number): number[] {
  const s = bucket.cellSize;
  const cx = Math.floor(x / s);
  const cz = Math.floor(z / s);
  const out: number[] = [];
  const seen = new Set<number>();
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const arr = bucket.grid.get(`${cx + di}_${cz + dj}`);
      if (arr) for (const idx of arr) if (!seen.has(idx)) {
        seen.add(idx);
        out.push(idx);
      }
    }
  }
  return out;
}

/** `true` when `(x, z)` is inside a footprint or within `margin` m of one (bucket queries). */
function blockedBy(bucket: BuildingBucket, x: number, z: number, margin: number): boolean {
  for (const idx of bucketNear(bucket, x, z)) {
    const poly = bucket.buildings[idx].poly;
    if (pointInPolygon(x, z, poly) || distToPolygon(x, z, poly) < margin) return true;
  }
  return false;
}

/**
 * First `t` where the ray from `(ox,oz)` along `(dx,dz)` crosses a footprint edge
 * (null when the ray runs parallel / misses every candidate segment).
 */
function rayCrosses(ox: number, oz: number, dx: number, dz: number, a: Vec2, b: Vec2): number | null {
  const rx = b[0] - a[0];
  const rz = b[1] - a[1];
  const denom = dx * rz - dz * rx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((a[0] - ox) * rz - (a[1] - oz) * rx) / denom;
  const u = ((a[0] - ox) * dz - (a[1] - oz) * dx) / denom;
  if (t > 0 && u >= 0 && u <= 1) return t;
  return null;
}

/**
 * Clip one cable end to the first footprint edge the ray crosses from the
 * centreline outward. Returns the clipped distance from the centreline along
 * `(dx,dz)` (≤ `half`), and `drop` when the resulting end is still > 2 m inside
 * a footprint (cables that would thread a building end-to-end are abandoned).
 */
function clipCableEnd(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  half: number,
  bucket: BuildingBucket,
): { t: number; drop: boolean } {
  let best = half;
  for (const idx of bucketNear(bucket, ox, oz)) {
    const poly = bucket.buildings[idx].poly;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const t = rayCrosses(ox, oz, dx, dz, poly[j], poly[i]);
      if (t !== null && t > 0 && t <= half && t < best) best = t;
    }
  }
  const ex = ox + dx * best;
  const ez = oz + dz * best;
  for (const idx of bucketNear(bucket, ex, ez)) {
    const poly = bucket.buildings[idx].poly;
    if (pointInPolygon(ex, ez, poly) && distToPolygon(ex, ez, poly) > 2) {
      return { t: best, drop: true };
    }
  }
  return { t: best, drop: false };
}

/** Metres of centreline between successive lamps along a lamped road. */
export const LAMP_SPACING = 32;
/** Metres of centreline between successive overhead cables. */
export const CABLE_SPACING = 25;
/** Road classes that get sodium street lamps. */
export const LAMP_CLASSES: ReadonlySet<RoadClass> = new Set([
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'pedestrian',
]);
/** Road classes that get overhead cables (service gets cables but no lamps). */
export const CABLE_CLASSES: ReadonlySet<RoadClass> = new Set(['residential', 'service', 'pedestrian']);

/** One sodium street lamp: base position and the unit direction its arm points (toward the road). */
export interface Lamp {
  x: number;
  y: number;
  z: number;
  /** Unit horizontal direction from the pole toward the road centreline. */
  dirX: number;
  dirZ: number;
}

/** One overhead cable: an 8-segment catenary of world-space points (ends first/last, equal height). */
export interface Cable {
  /** 9 catenary points (8 segments); the two end points share the same `y`. */
  pts: Vec3[];
}

/** Total polyline length of a road centreline, metres. */
function polylineLength(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  }
  return s;
}

/** Interpolate the point and unit tangent at arc-length `t` along a polyline. */
function along(pts: Vec2[], t: number): { p: Vec2; dx: number; dz: number } {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const last = i === pts.length - 2;
    if (segLen === 0) {
      if (last) return { p: [a[0], a[1]], dx: 0, dz: 0 };
      continue;
    }
    if (acc + segLen >= t || last) {
      const local = Math.min(1, Math.max(0, (t - acc) / segLen));
      const p: Vec2 = [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local];
      const dx = (b[0] - a[0]) / segLen;
      const dz = (b[1] - a[1]) / segLen;
      return { p, dx, dz };
    }
    acc += segLen;
  }
  const last = pts[pts.length - 1];
  return { p: [last[0], last[1]], dx: 0, dz: 0 };
}

/** Deterministic pseudo-random in [0, 1) for per-cable height variation. */
function hashUnit(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

const MIN_LAMP_OFFSET = 1.5; // push-out floor, metres from the centreline
const EDGE_MARGIN = 0.6; // a lamp this close to a footprint wall is blocked
const PUSH_STEP = 0.5; // push the lamp toward the centreline in these steps

/**
 * Place sodium lamps on lamped roads: every `LAMP_SPACING` m of polyline,
 * alternating sides, `ROAD_WIDTH[cls]/2 + 0.8` m from the centreline, seated
 * on `heightAt`. When `buildings` is given, a candidate base inside a footprint
 * or within {@link EDGE_MARGIN} of one is pushed toward the centreline in
 * {@link PUSH_STEP} steps down to {@link MIN_LAMP_OFFSET}; if still blocked the
 * lamp is skipped (narrow streets keep poles out of facades). Bridge-road lamps
 * closer than 10 m to an already-placed lamp are skipped.
 */
export function placeLamps(roads: Road[], heightAt: HeightFn, buildings?: readonly Building[]): Lamp[] {
  const lamps: Lamp[] = [];
  const placed: { x: number; z: number }[] = [];
  const bucket = buildings && buildings.length > 0 ? makeBuildingBucket(buildings) : null;
  for (const road of roads) {
    if (!LAMP_CLASSES.has(road.cls)) continue;
    const len = polylineLength(road.pts);
    const n = Math.floor(len / LAMP_SPACING);
    const offset = ROAD_WIDTH[road.cls] / 2 + 0.8;
    for (let i = 0; i < n; i++) {
      const { p, dx, dz } = along(road.pts, i * LAMP_SPACING);
      const s: Side = i % 2 === 0 ? 1 : -1; // alternating sides
      const nx = -dz;
      const nz = dx;
      let placedX = 0;
      let placedZ = 0;
      let accepted = false;
      for (let off = offset; off >= MIN_LAMP_OFFSET - 1e-9; off -= PUSH_STEP) {
        const x = p[0] + s * off * nx;
        const z = p[1] + s * off * nz;
        if (bucket && blockedBy(bucket, x, z, EDGE_MARGIN)) continue;
        placedX = x;
        placedZ = z;
        accepted = true;
        break;
      }
      if (!accepted) continue;
      if (road.bridge && placed.some((q) => Math.hypot(q.x - placedX, q.z - placedZ) < 10)) continue;
      placed.push({ x: placedX, z: placedZ });
      lamps.push({
        x: placedX,
        y: heightAt(placedX, placedZ),
        z: placedZ,
        dirX: -s * nx,
        dirZ: -s * nz,
      });
    }
  }
  return lamps;
}

/**
 * Place overhead cables on cable roads: every `CABLE_SPACING` m, a catenary
 * of 8 segments spanning road width + 4 m, end height 6–9 m above `heightAt`,
 * sag 1.2 m (lowest point = end height − 1.2 m). When `buildings` is given each
 * end is clipped to the first footprint edge it crosses from the centreline
 * outward (cables end on walls, not through buildings); a cable whose clipped
 * end is still > 2 m inside a footprint is dropped.
 */
export function placeCables(roads: Road[], heightAt: HeightFn, buildings?: readonly Building[]): Cable[] {
  const cables: Cable[] = [];
  const bucket = buildings && buildings.length > 0 ? makeBuildingBucket(buildings) : null;
  for (const road of roads) {
    if (!CABLE_CLASSES.has(road.cls)) continue;
    const len = polylineLength(road.pts);
    const n = Math.floor(len / CABLE_SPACING);
    const half = ROAD_WIDTH[road.cls] / 2 + 2;
    for (let i = 0; i < n; i++) {
      const { p, dx, dz } = along(road.pts, i * CABLE_SPACING);
      const nx = -dz;
      const nz = dx;
      const baseY = heightAt(p[0], p[1]);
      const endH = 6 + 3 * hashUnit(road.id, i);
      let tMinus = half;
      let tPlus = half;
      if (bucket) {
        const m = clipCableEnd(p[0], p[1], -nx, -nz, half, bucket);
        const pl = clipCableEnd(p[0], p[1], nx, nz, half, bucket);
        if (m.drop || pl.drop) continue;
        tMinus = m.t;
        tPlus = pl.t;
      }
      const pts: Vec3[] = [];
      for (let seg = 0; seg <= 8; seg++) {
        const u = seg / 8;
        const sag = 1.2 * 4 * u * (1 - u); // 0 at ends, 1.2 at the middle
        const ex = p[0] + nx * ((1 - u) * -tMinus + u * tPlus);
        const ez = p[1] + nz * ((1 - u) * -tMinus + u * tPlus);
        pts.push([ex, baseY + endH - sag, ez]);
      }
      cables.push({ pts });
    }
  }
  return cables;
}

/** Build the prism quad between two square cross-sections at `a`→`b` (solid faces, normal omitted). */
function addPrism(
  b: MeshBuilder,
  a: Vec3,
  c: Vec3,
  hw: number,
  vw: number,
  color: Vec3,
  uvA: UV,
  uvB: UV,
): void {
  const d: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  const hRaw: Vec3 = [-d[2], 0, d[0]];
  const hl = Math.hypot(hRaw[0], hRaw[2]);
  const h: Vec3 = hl < 1e-6 ? [1, 0, 0] : [hRaw[0] / hl, 0, hRaw[2] / hl];
  const u: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
  const v: Vec3 = [0, 1, 0];
  const cr = (p: Vec3, sh: number, sv: number): Vec3 => [
    p[0] + h[0] * hw * sh + v[0] * vw * sv,
    p[1] + h[1] * hw * sh + v[1] * vw * sv,
    p[2] + h[2] * hw * sh + v[2] * vw * sv,
  ];
  const c0 = cr(a, 1, 1);
  const c1 = cr(a, -1, 1);
  const c2 = cr(a, -1, -1);
  const c3 = cr(a, 1, -1);
  const c4 = cr(c, 1, 1);
  const c5 = cr(c, -1, 1);
  const c6 = cr(c, -1, -1);
  const c7 = cr(c, 1, -1);
  b.quad(c0, c4, c5, c1, u, uvA, uvB, uvB, uvA, color);
  b.quad(c1, c5, c6, c2, u, uvA, uvB, uvB, uvA, color);
  b.quad(c2, c6, c7, c3, u, uvA, uvB, uvB, uvA, color);
  b.quad(c3, c7, c4, c0, u, uvA, uvB, uvB, uvA, color);
  b.quad(c3, c2, c1, c0, u, uvA, uvA, uvA, uvA, color);
  b.quad(c4, c5, c6, c7, u, uvA, uvA, uvA, uvA, color);
}

/** Build one lamp's pole + arm into the solid builder (group 0 — dark body). */
function buildPoleArm(b: MeshBuilder, lamp: Lamp, color: Vec3): void {
  // Pole: 0.15 m square cross-section, 7 m tall, from the seated base.
  addPrism(b, [lamp.x, lamp.y, lamp.z], [lamp.x, lamp.y + 7, lamp.z], 0.075, 0.075, color, [0, 0], [0, 1]);
  // Arm: 1.8 m toward the road at pole top, 0.1 m square cross-section.
  const ex = lamp.x + lamp.dirX * 1.8;
  const ez = lamp.z + lamp.dirZ * 1.8;
  addPrism(b, [lamp.x, lamp.y + 7, lamp.z], [ex, lamp.y + 7, ez], 0.05, 0.05, color, [0, 0], [1, 0]);
}

/** Build one lamp's head into the solid builder (group 1 — emissive sodium). */
function buildHead(b: MeshBuilder, lamp: Lamp, color: Vec3): void {
  // Head: 0.6 (along arm) × 0.2 (across) × 0.3 (tall), centred on the arm end.
  const cx = lamp.x + lamp.dirX * 1.8;
  const cz = lamp.z + lamp.dirZ * 1.8;
  const ax: Vec3 = [cx - lamp.dirX * 0.3, lamp.y + 7, cz - lamp.dirZ * 0.3];
  const bx: Vec3 = [cx + lamp.dirX * 0.3, lamp.y + 7, cz + lamp.dirZ * 0.3];
  addPrism(b, ax, bx, 0.1, 0.15, color, [0, 0], [1, 0]);
}

/** Build one lamp's faux-volumetric cone into the cones builder (additive, uv.y = 0 top → 1 ground). */
function buildCone(b: MeshBuilder, lamp: Lamp): void {
  const cx = lamp.x + lamp.dirX * 1.8;
  const cz = lamp.z + lamp.dirZ * 1.8;
  const topY = lamp.y + 7;
  const groundY = lamp.y;
  const R = 3.5;
  for (let seg = 0; seg < 8; seg++) {
    const a0 = (seg / 8) * Math.PI * 2;
    const a1 = ((seg + 1) / 8) * Math.PI * 2;
    const apex: Vec3 = [cx, topY, cz];
    const r0: Vec3 = [cx + R * Math.cos(a0), groundY, cz + R * Math.sin(a0)];
    const r1: Vec3 = [cx + R * Math.cos(a1), groundY, cz + R * Math.sin(a1)];
    b.triangle(apex, r0, r1, [0, -1, 0], [0.5, 0], [0.5, 1], [0.5, 1], [1, 1, 1]);
  }
}

/** Build one lamp's ground pool into the pools builder (additive, uv.x = 0 centre → 1 edge). */
function buildPool(b: MeshBuilder, lamp: Lamp): void {
  const y = lamp.y + 0.03;
  const R = 2;
  for (let seg = 0; seg < 8; seg++) {
    const a0 = (seg / 8) * Math.PI * 2;
    const a1 = ((seg + 1) / 8) * Math.PI * 2;
    const center: Vec3 = [lamp.x, y, lamp.z];
    const r0: Vec3 = [lamp.x + R * Math.cos(a0), y, lamp.z + R * Math.sin(a0)];
    const r1: Vec3 = [lamp.x + R * Math.cos(a1), y, lamp.z + R * Math.sin(a1)];
    b.triangle(center, r0, r1, [0, 1, 0], [0, 0], [1, 0], [1, 0], [1, 1, 1]);
  }
}

/** Build one cable's dark ribbon into the solid builder (double-sided via the layer's material side). */
function buildCable(b: MeshBuilder, cable: Cable): void {
  const color: Vec3 = [0.04, 0.04, 0.04];
  for (let seg = 0; seg < cable.pts.length - 1; seg++) {
    const a = cable.pts[seg];
    const c = cable.pts[seg + 1];
    const d: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const hRaw: Vec3 = [-d[2], 0, d[0]];
    const hl = Math.hypot(hRaw[0], hRaw[2]);
    const h: Vec3 = hl < 1e-6 ? [1, 0, 0] : [hRaw[0] / hl, 0, hRaw[2] / hl];
    const hw = 0.02;
    const a0: Vec3 = [a[0] - h[0] * hw, a[1], a[2] - h[2] * hw];
    const a1: Vec3 = [a[0] + h[0] * hw, a[1], a[2] + h[2] * hw];
    const b0: Vec3 = [c[0] - h[0] * hw, c[1], c[2] - h[2] * hw];
    const b1: Vec3 = [c[0] + h[0] * hw, c[1], c[2] + h[2] * hw];
    b.quad(a0, b0, b1, a1, h, [0, 0], [0, 1], [1, 1], [1, 0], color);
  }
}

/**
 * Build all props into three `MeshData` streams: `solid` (poles, arms, heads,
 * cables — groups 0 = dark body, 1 = emissive heads), `cones` (additive
 * volumetric light cones, uv.y vertical falloff), `pools` (additive ground
 * pools, uv.x radial falloff).
 */
export function buildPropsMesh(
  lamps: Lamp[],
  cables: Cable[],
): { solid: MeshData; cones: MeshData; pools: MeshData } {
  const solid = new MeshBuilder();
  const cones = new MeshBuilder();
  const pools = new MeshBuilder();
  const dark: Vec3 = [0.12, 0.12, 0.12];
  for (const lamp of lamps) buildPoleArm(solid, lamp, dark);
  for (const cable of cables) buildCable(solid, cable);
  solid.endGroup(0);
  for (const lamp of lamps) buildHead(solid, lamp, dark);
  solid.endGroup(1);
  for (const lamp of lamps) buildCone(cones, lamp);
  for (const lamp of lamps) buildPool(pools, lamp);
  return { solid: solid.build(), cones: cones.build(), pools: pools.build() };
}
