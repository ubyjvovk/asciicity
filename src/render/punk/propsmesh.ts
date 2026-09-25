/**
 * Cyberpunk street props geometry (wave 20b, T-0155): pure builders that
 * place sodium lamps + overhead cables along roads and turn them into
 * `MeshData`. No `three/webgpu` import — unit-testable in plain node.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Street props".
 */
import type { HeightFn, Road, RoadClass, Vec2 } from '../../data/types';
import { MeshBuilder, type MeshData, type UV, type Vec3 } from '../../world/mesh';
import { ROAD_WIDTH } from '../../world/roads';

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

/**
 * Place sodium lamps on lamped roads: every `LAMP_SPACING` m of polyline,
 * alternating sides, `ROAD_WIDTH[cls]/2 + 0.8` m from the centreline, seated
 * on `heightAt`. Bridge-road lamps closer than 10 m to an already-placed lamp
 * are skipped (their endpoints overlap the connected street lamps).
 */
export function placeLamps(roads: Road[], heightAt: HeightFn): Lamp[] {
  const lamps: Lamp[] = [];
  const placed: { x: number; z: number }[] = [];
  for (const road of roads) {
    if (!LAMP_CLASSES.has(road.cls)) continue;
    const len = polylineLength(road.pts);
    const n = Math.floor(len / LAMP_SPACING);
    const offset = ROAD_WIDTH[road.cls] / 2 + 0.8;
    for (let i = 0; i < n; i++) {
      const { p, dx, dz } = along(road.pts, i * LAMP_SPACING);
      const s = i % 2 === 0 ? 1 : -1; // alternating sides
      const nx = -dz;
      const nz = dx;
      const x = p[0] + s * offset * nx;
      const z = p[1] + s * offset * nz;
      if (road.bridge && placed.some((q) => Math.hypot(q.x - x, q.z - z) < 10)) continue;
      placed.push({ x, z });
      lamps.push({ x, y: heightAt(x, z), z, dirX: -s * nx, dirZ: -s * nz });
    }
  }
  return lamps;
}

/**
 * Place overhead cables on cable roads: every `CABLE_SPACING` m, a catenary
 * of 8 segments spanning road width + 4 m, end height 6–9 m above `heightAt`,
 * sag 1.2 m (lowest point = end height − 1.2 m).
 */
export function placeCables(roads: Road[], heightAt: HeightFn): Cable[] {
  const cables: Cable[] = [];
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
      const pts: Vec3[] = [];
      for (let seg = 0; seg <= 8; seg++) {
        const u = seg / 8;
        const sag = 1.2 * 4 * u * (1 - u); // 0 at ends, 1.2 at the middle
        pts.push([p[0] + nx * (2 * u - 1) * half, baseY + endH - sag, p[1] + nz * (2 * u - 1) * half]);
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
