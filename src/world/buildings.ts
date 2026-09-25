/**
 * Building footprint → merged wall/roof mesh (docs/architecture.md §4.2).
 * Pure geometry: no DOM, no textures module (window tex is passed in).
 */
import * as THREE from 'three';
import {
  FLAT_HEIGHT,
  type Building,
  type BuildingMaterial,
  type HeightFn,
  type RoofShape,
  type Vec2,
} from '../data/types';
import { colorFor } from './palette';
import { EXTRA_NONE, MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';

const TILE_M = 24;
const AREA_EPS = 1;

/** Convert a local-metre `[x, z]` ring to `Vector2`s for `ShapeUtils`. */
function asContour(poly: Vec2[]): THREE.Vector2[] {
  return poly.map(([x, z]) => new THREE.Vector2(x, z));
}

/** Signed `ShapeUtils.area` of a footprint ring (positive = CCW in x/z). */
function ringArea(poly: Vec2[]): number {
  return THREE.ShapeUtils.area(asContour(poly));
}

/** Linear rgb of `colorFor(building)` via `THREE.Color` (working colour space). */
function vertexColor(building: Building): Vec3 {
  const c = new THREE.Color(colorFor(building));
  return [c.r, c.g, c.b];
}

/** Copy of `poly` reversed when needed so `ShapeUtils.area` is positive. */
export function normalizeRing(poly: Vec2[]): Vec2[] {
  const copy: Vec2[] = poly.map(([x, z]) => [x, z]);
  if (ringArea(copy) < 0) copy.reverse();
  return copy;
}

/** Min/max of `heightAt` over a ring's vertices (the building's terrain slab). */
export function ringHeights(ring: Vec2[], heightAt: HeightFn): { base: number; top: number } {
  let base = Infinity;
  let top = -Infinity;
  for (const p of ring) {
    const y = heightAt(p[0], p[1]);
    if (y < base) base = y;
    if (y > top) top = y;
  }
  return { base, top };
}

/** Emit the six wall vertices for edge `a → b` (outward, CCW from outside). */
function emitWall(
  mesh: MeshBuilder,
  a: Vec2,
  b: Vec2,
  base: number,
  roofY: number,
  u0: number,
  u1: number,
  color: Vec3,
): void {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len === 0) return;
  const n: Vec3 = [dz / len, 0, -dx / len];
  const v0 = 0;
  const v1 = (roofY - base) / TILE_M;
  const pa: Vec3 = [a[0], base, a[1]];
  const pb: Vec3 = [a[0], roofY, a[1]];
  const pc: Vec3 = [b[0], roofY, b[1]];
  const pd: Vec3 = [b[0], base, b[1]];
  mesh.quad(pa, pb, pc, pd, n, [u0, v0], [u0, v1], [u1, v1], [u1, v0], color);
}

/** Emit a downward-facing underside cap at `y` (visible from the street when minH > 0). */
function emitBottomCap(mesh: MeshBuilder, ring: Vec2[], y: number, color: Vec3): void {
  const faces = THREE.ShapeUtils.triangulateShape(asContour(ring), []);
  const n: Vec3 = [0, -1, 0];
  const uv: UV = [0, 0];
  for (const face of faces) {
    const ia = face[0];
    const ib = face[1];
    const ic = face[2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const ra = ring[ia];
    const rb = ring[ib];
    const rc = ring[ic];
    if (!ra || !rb || !rc) continue;
    const a: Vec3 = [ra[0], y, ra[1]];
    const b: Vec3 = [rb[0], y, rb[1]];
    const c: Vec3 = [rc[0], y, rc[1]];
    const e1x = b[0] - a[0];
    const e1z = b[2] - a[2];
    const e2x = c[0] - a[0];
    const e2z = c[2] - a[2];
    const crossY = e1z * e2x - e1x * e2z;
    // Geometric ny has the sign of crossY; we want ny < 0 so the face looks down.
    if (crossY <= 0) mesh.triangle(a, b, c, n, uv, uv, uv, color);
    else mesh.triangle(a, c, b, n, uv, uv, uv, color);
  }
}

/** Emit roof triangles for a normalised ring; flip so `cross.y > 0`. */
function emitRoof(mesh: MeshBuilder, ring: Vec2[], roofY: number, color: Vec3): void {
  const faces = THREE.ShapeUtils.triangulateShape(asContour(ring), []);
  const n: Vec3 = [0, 1, 0];
  const uv: UV = [0, 0];
  for (const face of faces) {
    const ia = face[0];
    const ib = face[1];
    const ic = face[2];
    if (ia === undefined || ib === undefined || ic === undefined) continue;
    const ra = ring[ia];
    const rb = ring[ib];
    const rc = ring[ic];
    if (!ra || !rb || !rc) continue;
    const a: Vec3 = [ra[0], roofY, ra[1]];
    const b: Vec3 = [rb[0], roofY, rb[1]];
    const c: Vec3 = [rc[0], roofY, rc[1]];
    const e1x = b[0] - a[0];
    const e1z = b[2] - a[2];
    const e2x = c[0] - a[0];
    const e2z = c[2] - a[2];
    const crossY = e1z * e2x - e1x * e2z;
    if (crossY >= 0) mesh.triangle(a, b, c, n, uv, uv, uv, color);
    else mesh.triangle(a, c, b, n, uv, uv, uv, color);
  }
}

/** Unit geometric normal of triangle a→b→c (cross product b−a, c−a, normalised). */
function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return [0, 1, 0];
  return [nx / len, ny / len, nz / len];
}

/**
 * Emit triangle a→b→c whose stored normal points away from `ref`; if the
 * natural winding faces inward, the last two vertices are swapped so the
 * rendered face (front culling) and its normal agree (architecture §4.13).
 */
function emitTri(
  mesh: MeshBuilder,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  ref: Vec3,
  color: Vec3,
): void {
  const uv: UV = [0, 0];
  const n = triNormal(a, b, c);
  const midX = (a[0] + b[0] + c[0]) / 3;
  const midY = (a[1] + b[1] + c[1]) / 3;
  const midZ = (a[2] + b[2] + c[2]) / 3;
  const away = n[0] * (midX - ref[0]) + n[1] * (midY - ref[1]) + n[2] * (midZ - ref[2]);
  if (away < 0) {
    // triNormal(a, c, b) = −n → outward; winding now matches the normal.
    mesh.triangle(a, c, b, [-n[0], -n[1], -n[2]], uv, uv, uv, color);
  } else {
    mesh.triangle(a, b, c, n, uv, uv, uv, color);
  }
}

/** Two triangles of the quad a→b→c→d, normals oriented away from `ref`. */
function emitQuad(
  mesh: MeshBuilder,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  ref: Vec3,
  color: Vec3,
): void {
  emitTri(mesh, a, b, c, ref, color);
  emitTri(mesh, a, c, d, ref, color);
}

/**
 * Hemisphere cup of radius `r` above `roofY` — 8 segments × 4 rings, UV
 * `(0,0)`, normals outward (architecture §4.13). The top band ends at a ring
 * of 8 coincident apex vertices, so its second triangle is degenerate.
 */
function emitDome(
  mesh: MeshBuilder,
  cx: number,
  cz: number,
  roofY: number,
  r: number,
  color: Vec3,
): void {
  const S = 8;
  const R = 4;
  const center: Vec3 = [cx, roofY, cz];
  const apex: Vec3 = [cx, roofY + r, cz];
  const rings: Vec3[][] = [];
  for (let k = 0; k < R; k++) {
    const theta = (k / R) * (Math.PI / 2);
    const rr = r * Math.cos(theta);
    const y = roofY + r * Math.sin(theta);
    const ring: Vec3[] = [];
    for (let s = 0; s < S; s++) {
      const azim = (s / S) * Math.PI * 2;
      ring.push([cx + rr * Math.cos(azim), y, cz + rr * Math.sin(azim)]);
    }
    rings.push(ring);
  }
  for (let k = 0; k < R; k++) {
    const ring = rings[k]!;
    for (let s = 0; s < S; s++) {
      const a = ring[s]!;
      const b = ring[(s + 1) % S]!;
      if (k === R - 1) {
        // Top band squashes onto the single apex point (S degenerate copies).
        emitQuad(mesh, a, b, apex, apex, center, color);
      } else {
        const next = rings[k + 1]!;
        const c = next[(s + 1) % S]!;
        const d = next[s]!;
        emitQuad(mesh, a, b, c, d, center, color);
      }
    }
  }
}

/**
 * Conical spire of base radius `r` and height `apexH` above `roofY` —
 * 8 side triangles (base omitted: it is coplanar with the roof, architecture
 * §4.13), normals outward.
 */
function emitSpire(
  mesh: MeshBuilder,
  cx: number,
  cz: number,
  roofY: number,
  r: number,
  apexH: number,
  color: Vec3,
): void {
  const S = 8;
  const center: Vec3 = [cx, roofY, cz];
  const apex: Vec3 = [cx, roofY + apexH, cz];
  const base: Vec3[] = [];
  for (let s = 0; s < S; s++) {
    const azim = (s / S) * Math.PI * 2;
    base.push([cx + r * Math.cos(azim), roofY, cz + r * Math.sin(azim)]);
  }
  for (let s = 0; s < S; s++) {
    emitTri(mesh, apex, base[s]!, base[(s + 1) % S]!, center, color);
  }
}

/**
 * Second box of half the footprint (`bboxW`/2 × `bboxD`/2) and `0.5·h` extra
 * height above `roofY` (architecture §4.13). 4 sides + top, normals outward.
 */
function emitTower(
  mesh: MeshBuilder,
  cx: number,
  cz: number,
  roofY: number,
  bboxW: number,
  bboxD: number,
  h: number,
  color: Vec3,
): void {
  const boxW = bboxW / 2;
  const boxD = bboxD / 2;
  const x0 = cx - boxW / 2;
  const x1 = cx + boxW / 2;
  const z0 = cz - boxD / 2;
  const z1 = cz + boxD / 2;
  const y0 = roofY;
  const y1 = roofY + 0.5 * h;
  const center: Vec3 = [cx, roofY + 0.25 * h, cz];
  emitQuad(mesh, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], center, color); // +x
  emitQuad(mesh, [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], center, color); // −x
  emitQuad(mesh, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], center, color); // +z
  emitQuad(mesh, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], center, color); // −z
  emitQuad(mesh, [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], center, color); // +y top
}

/**
 * Emit a building's landmark cap above the roof, into the open group 0
 * (walls material, same colour). Buildings without `shape` add nothing.
 */
function emitCap(
  mesh: MeshBuilder,
  ring: Vec2[],
  building: Building,
  roofY: number,
  color: Vec3,
): void {
  const shape = building.shape;
  if (shape === undefined) return;
  let cx = 0;
  let cz = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    cx += p[0];
    cz += p[1];
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  cx /= ring.length;
  cz /= ring.length;
  const s = Math.min(maxX - minX, maxZ - minZ);
  if (shape === 'dome') emitDome(mesh, cx, cz, roofY, 0.4 * s, color);
  else if (shape === 'spire') emitSpire(mesh, cx, cz, roofY, 0.3 * s, 0.6 * building.h, color);
  else if (shape === 'tower') emitTower(mesh, cx, cz, roofY, maxX - minX, maxZ - minZ, building.h, color);
}

/** `building:material` → the `extra.w` code (architecture §4.2 "Roofs + OSM facade data"). */
export const MATERIAL_CODE: Readonly<Record<BuildingMaterial, number>> = {
  brick: 1,
  stone: 2,
  concrete: 3,
  glass: 4,
  metal: 5,
  wood: 6,
  plaster: 7,
};

type Extra = readonly [number, number, number, number];

/** sRGB channel in [0, 1] → linear. */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** `extra` vec4 for a 24-bit sRGB colour (−1 rgb when absent) and a material code. */
function extraOf(hex: number | undefined, code: number): Extra {
  if (hex === undefined) return [-1, -1, -1, code];
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
    code,
  ];
}

/** Wall / roof `extra` of a building, or `null` when it has no OSM facade data. */
function buildingExtras(b: Building): { wall: Extra; roof: Extra } | null {
  if (b.osmColor === undefined && b.roofColor === undefined && b.material === undefined) return null;
  const code = b.material === undefined ? 0 : MATERIAL_CODE[b.material];
  return { wall: extraOf(b.osmColor, code), roof: extraOf(b.roofColor, code) };
}

/** Roof shapes rendered as a height field over the footprint (the rest are lathes). */
type FieldShape = 'gabled' | 'hipped' | 'pyramidal' | 'skillion' | 'round';

/** Height-field shapes (crease-split footprint + crease-cut triangulation). */
function isFieldShape(shape: RoofShape): shape is FieldShape {
  return shape !== 'dome' && shape !== 'onion';
}

/** Roof frame: axis `a`, `b` = a rotated +90°, footprint centre (ac, bc) and half-extents L, W. */
interface RoofFrame {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ac: number;
  bc: number;
  L: number;
  W: number;
}

/** Frame of a normalised ring: `a` from bearing `dir` (x = sin, z = −cos) or the longest edge. */
function roofFrame(ring: Vec2[], dir: number | undefined): RoofFrame {
  let ax: number;
  let az: number;
  if (dir !== undefined) {
    const r = (dir * Math.PI) / 180;
    ax = Math.sin(r);
    az = -Math.cos(r);
  } else {
    let best = -1;
    ax = 1;
    az = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const dx = q[0] - p[0];
      const dz = q[1] - p[1];
      const len = Math.hypot(dx, dz);
      if (len > best) {
        best = len;
        ax = dx / len;
        az = dz / len;
      }
    }
  }
  const bx = -az;
  const bz = ax;
  let sMin = Infinity;
  let sMax = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const [x, z] of ring) {
    const s = x * ax + z * az;
    const t = x * bx + z * bz;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  return {
    ax,
    az,
    bx,
    bz,
    ac: (sMin + sMax) / 2,
    bc: (tMin + tMax) / 2,
    L: (sMax - sMin) / 2,
    W: (tMax - tMin) / 2,
  };
}

/** Height field f(s, t) ∈ [0, 1] of a roof shape (architecture §4.2). */
function roofField(shape: FieldShape, s: number, t: number, L: number, W: number): number {
  if (W <= 0) return 0;
  switch (shape) {
    case 'gabled':
      return Math.max(0, 1 - Math.abs(t) / W);
    case 'hipped':
      return Math.min(1, Math.max(0, Math.min(1 - Math.abs(t) / W, (L - Math.abs(s)) / W)));
    case 'pyramidal':
      return L <= 0 ? 0 : Math.min(1, Math.max(0, 1 - Math.max(Math.abs(s) / L, Math.abs(t) / W)));
    case 'skillion':
      return Math.min(1, Math.max(0, (t + W) / (2 * W)));
    case 'round':
      return Math.sqrt(Math.max(0, 1 - (t / W) ** 2));
  }
}

/** f at world point (x, z) in `frame`. */
function fieldAt(shape: FieldShape, frame: RoofFrame, x: number, z: number): number {
  const s = x * frame.ax + z * frame.az - frame.ac;
  const t = x * frame.bx + z * frame.bz - frame.bc;
  return roofField(shape, s, t, frame.L, frame.W);
}

/**
 * Crease lines of a height field in the roof frame, as unit-normal
 * `(α, β, γ)` with `α·s + β·t = γ` — f is linear between them (every
 * shape but `round` is the min of ≤ 4 planes; `round` gets facet lines at
 * t = W·cos(kπ/8), an 8-facet barrel). Lines that can never be a crease
 * for the given L, W are dropped; the rest are cut only where they are an
 * actual kink of f (`creaseActive`).
 */
function creases(shape: FieldShape, L: number, W: number): Crease[] {
  const lines: Crease[] = [];
  const add = (al: number, be: number, ga: number, always = false): void => {
    const k = Math.hypot(al, be);
    if (k > 0) lines.push({ al: al / k, be: be / k, ga: ga / k, always });
  };
  switch (shape) {
    case 'gabled':
      add(0, 1, 0);
      break;
    case 'hipped':
      if (L >= W) add(0, 1, 0);
      else add(1, 0, 0);
      add(1, 1, L - W);
      add(1, -1, L - W);
      add(-1, 1, L - W);
      add(-1, -1, L - W);
      break;
    case 'pyramidal':
      add(W, -L, 0);
      add(W, L, 0);
      break;
    case 'skillion':
      break;
    case 'round':
      for (let k = 1; k < ROUND_FACETS; k++) add(0, 1, W * Math.cos((k * Math.PI) / ROUND_FACETS), true);
      break;
  }
  return lines;
}

/** Line `al·s + be·t = ga` (unit normal) in the roof frame; `always` = facet line, not a kink of f. */
interface Crease {
  al: number;
  be: number;
  ga: number;
  always: boolean;
}

/** Facets across a `round` roof. */
const ROUND_FACETS = 8;
/** Distance (m) below which a point counts as on a crease line. */
const CREASE_EPS = 1e-6;
/** Probe offset (m) and threshold of the kink test in `creaseActive`. */
const KINK_PROBE = 1e-3;
const KINK_EPS = 1e-9;
const LATHE_SEGMENTS = 12;
const DOME_RINGS = 8;
/** Onion lathe profile: (y / roof.h, r / R) (architecture §4.2). */
const ONION_PROFILE: readonly (readonly [number, number])[] = [
  [0, 1.0],
  [0.15, 1.18],
  [0.3, 1.25],
  [0.45, 1.15],
  [0.6, 0.9],
  [0.75, 0.55],
  [0.88, 0.25],
  [1, 0],
];

/** Signed distance of world point p from crease line `ln` in `frame`. */
function lineDist(ln: Crease, frame: RoofFrame, p: Vec2): number {
  const s = p[0] * frame.ax + p[1] * frame.az - frame.ac;
  const t = p[0] * frame.bx + p[1] * frame.bz - frame.bc;
  const d = ln.al * s + ln.be * t - ln.ga;
  return Math.abs(d) < CREASE_EPS ? 0 : d;
}

/**
 * Whether crease line `ln` must be cut at point `c`: facet lines always;
 * otherwise only where f actually kinks across the line there (f is a
 * min of planes, so a crease is concave: f(c) > mean of f(c ± δ·n)). Hip
 * lines are creases only between the ridge end and the eaves.
 */
function creaseActive(ln: Crease, shape: FieldShape, frame: RoofFrame, c: Vec2): boolean {
  if (ln.always) return true;
  const nx = (ln.al * frame.ax + ln.be * frame.bx) * KINK_PROBE;
  const nz = (ln.al * frame.az + ln.be * frame.bz) * KINK_PROBE;
  const f0 = fieldAt(shape, frame, c[0], c[1]);
  const f1 = fieldAt(shape, frame, c[0] + nx, c[1] + nz);
  const f2 = fieldAt(shape, frame, c[0] - nx, c[1] - nz);
  return f0 - (f1 + f2) / 2 > KINK_EPS;
}

/** Point on segment p → q where the signed distances `dp`, `dq` (opposite signs) cross zero. */
function crossing(p: Vec2, q: Vec2, dp: number, dq: number): Vec2 {
  const u = dp / (dp - dq);
  return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
}

/** Normalised ring with a vertex inserted wherever an edge crosses an active crease line. */
function splitRing(ring: Vec2[], shape: FieldShape, lines: Crease[], frame: RoofFrame): Vec2[] {
  const out: Vec2[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    out.push([a[0], a[1]]);
    const cuts: Vec2[] = [];
    for (const ln of lines) {
      const da = lineDist(ln, frame, a);
      const db = lineDist(ln, frame, b);
      if (!((da < 0 && db > 0) || (da > 0 && db < 0))) continue;
      const c = crossing(a, b, da, db);
      if (creaseActive(ln, shape, frame, c)) cuts.push(c);
    }
    const ax = b[0] - a[0];
    const az = b[1] - a[1];
    cuts.sort((p, q) => (p[0] - a[0]) * ax + (p[1] - a[1]) * az - ((q[0] - a[0]) * ax + (q[1] - a[1]) * az));
    for (const c of cuts) {
      const last = out[out.length - 1]!;
      if (Math.hypot(c[0] - last[0], c[1] - last[1]) > CREASE_EPS) out.push(c);
    }
  }
  return out;
}

/**
 * Conforming roof triangulation of a crease-split ring: `ShapeUtils`
 * faces (the same triangulator as `emitRoof`), ring vertices it dropped
 * as collinear fanned back in, then triangles cut along each crease line
 * wherever an edge crosses it at an active point (`creaseActive`; the
 * decision and the crossing vertex are cached per undirected edge, so
 * neighbours agree — no T-junctions). Boundary edges were already split at
 * active crossings (`splitRing`) and are never split here, so walls share
 * every boundary vertex. Returns the vertex list (ring first) and index
 * triples; away from crease END points every triangle lies on one plane of f.
 */
function cutRoof(
  ring: Vec2[],
  shape: FieldShape,
  lines: Crease[],
  frame: RoofFrame,
): { verts: Vec2[]; tris: number[][] } {
  const n = ring.length;
  const verts: Vec2[] = ring.map(([x, z]) => [x, z]);
  const faces = THREE.ShapeUtils.triangulateShape(asContour(ring), []);
  const used = new Uint8Array(n);
  for (const f of faces) for (const i of f) used[i] = 1;
  /** Dropped ring vertices strictly between p and q along the ring (p → q order), or null. */
  const gap = (p: number, q: number): number[] | null => {
    const fwd: number[] = [];
    let k = (p + 1) % n;
    while (k !== q && used[k] === 0) {
      fwd.push(k);
      k = (k + 1) % n;
    }
    if (k === q) return fwd;
    const back: number[] = [];
    k = (q + 1) % n;
    while (k !== p && used[k] === 0) {
      back.push(k);
      k = (k + 1) % n;
    }
    if (k === p) return back.reverse();
    return null;
  };
  let tris: number[][] = [];
  for (const f of faces) {
    const c = [f[0]!, f[1]!, f[2]!];
    const gaps = c.map((p, e) => gap(p, c[(e + 1) % 3]!) ?? []);
    const filled = gaps.filter((g) => g.length > 0).length;
    if (filled === 0) {
      tris.push(c);
    } else if (filled === 1) {
      const e = gaps.findIndex((g) => g.length > 0);
      const chain = [c[e]!, ...gaps[e]!, c[(e + 1) % 3]!];
      const apex = c[(e + 2) % 3]!;
      for (let k = 0; k + 1 < chain.length; k++) tris.push([chain[k]!, chain[k + 1]!, apex]);
    } else {
      const cycle: number[] = [];
      for (let e = 0; e < 3; e++) cycle.push(c[e]!, ...gaps[e]!);
      const mid = verts.length;
      verts.push([
        (verts[c[0]!]![0] + verts[c[1]!]![0] + verts[c[2]!]![0]) / 3,
        (verts[c[0]!]![1] + verts[c[1]!]![1] + verts[c[2]!]![1]) / 3,
      ]);
      for (let k = 0; k < cycle.length; k++) tris.push([cycle[k]!, cycle[(k + 1) % cycle.length]!, mid]);
    }
  }
  const boundary = (i: number, j: number): boolean =>
    i < n && j < n && ((i + 1) % n === j || (j + 1) % n === i);
  for (const ln of lines) {
    const d = verts.map((p) => lineDist(ln, frame, p));
    const cache = new Map<number, number>();
    /** Crossing vertex of edge i–j (cached per undirected edge), or −1 when the crease is inactive there. */
    const cut = (i: number, j: number): number => {
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const key = lo * 1048576 + hi;
      let m = cache.get(key);
      if (m === undefined) {
        m = -1;
        if (!boundary(lo, hi)) {
          const c = crossing(verts[lo]!, verts[hi]!, d[lo]!, d[hi]!);
          if (creaseActive(ln, shape, frame, c)) {
            m = verts.length;
            verts.push(c);
            d.push(0);
          }
        }
        cache.set(key, m);
      }
      return m;
    };
    const next: number[][] = [];
    for (const t of tris) {
      const sg = t.map((i) => Math.sign(d[i]!));
      if (!sg.includes(1) || !sg.includes(-1)) {
        next.push(t);
        continue;
      }
      const z = sg.indexOf(0);
      if (z >= 0) {
        // Line through vertex z and across the opposite edge.
        const v0 = t[z]!;
        const v1 = t[(z + 1) % 3]!;
        const v2 = t[(z + 2) % 3]!;
        const m = cut(v1, v2);
        if (m < 0) next.push(t);
        else next.push([v0, v1, m], [v0, m, v2]);
        continue;
      }
      // Rotate so vertex 0 is alone on its side.
      const e = sg[0] === sg[1] ? 2 : sg[0] === sg[2] ? 1 : 0;
      const v0 = t[e]!;
      const v1 = t[(e + 1) % 3]!;
      const v2 = t[(e + 2) % 3]!;
      const m01 = cut(v0, v1);
      const m02 = cut(v0, v2);
      if (m01 >= 0 && m02 >= 0) next.push([v0, m01, m02], [m01, v1, v2], [m01, v2, m02]);
      else if (m01 >= 0) next.push([v0, m01, v2], [m01, v1, v2]);
      else if (m02 >= 0) next.push([v0, v1, m02], [m02, v1, v2]);
      else next.push(t);
    }
    tris = next;
  }
  return { verts, tris };
}

/** Walls of a roofed building: one trapezoid per ring edge from `base` up to `tops[i]` / `tops[i+1]`. */
function emitRoofedWalls(mesh: MeshBuilder, ring: Vec2[], tops: number[], base: number, color: Vec3): void {
  let dist = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    const ya = tops[i]!;
    const yb = tops[(i + 1) % n]!;
    const nrm: Vec3 = [dz / len, 0, -dx / len];
    const u0 = dist / TILE_M;
    const u1 = (dist + len) / TILE_M;
    mesh.quad(
      [a[0], base, a[1]],
      [a[0], ya, a[1]],
      [b[0], yb, b[1]],
      [b[0], base, b[1]],
      nrm,
      [u0, 0],
      [u0, (ya - base) / TILE_M],
      [u1, (yb - base) / TILE_M],
      [u1, 0],
      color,
    );
    dist += len;
  }
}

/** Upward-facing flat-shaded triangle (winding flipped when needed so normal.y > 0). */
function emitUpTri(mesh: MeshBuilder, a: Vec3, b: Vec3, c: Vec3, color: Vec3): void {
  const uv: UV = [0, 0];
  const nrm = triNormal(a, b, c);
  if (nrm[1] >= 0) mesh.triangle(a, b, c, nrm, uv, uv, uv, color);
  else mesh.triangle(a, c, b, [-nrm[0], -nrm[1], -nrm[2]], uv, uv, uv, color);
}

/** Area centroid of a ring (falls back to the vertex mean for a degenerate ring). */
function ringCentroid(ring: Vec2[]): Vec2 {
  let a2 = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const cr = p[0] * q[1] - q[0] * p[1];
    a2 += cr;
    cx += (p[0] + q[0]) * cr;
    cz += (p[1] + q[1]) * cr;
  }
  if (Math.abs(a2) < 1e-9) {
    let mx = 0;
    let mz = 0;
    for (const p of ring) {
      mx += p[0];
      mz += p[1];
    }
    return [mx / ring.length, mz / ring.length];
  }
  return [cx / (3 * a2), cz / (3 * a2)];
}

/**
 * 12-segment lathe about (cx, cz) from `y0`: `profile` holds (y / height,
 * r / R) pairs bottom → apex (r = 0). Outward flat-shaded faces.
 */
function emitLathe(
  mesh: MeshBuilder,
  cx: number,
  cz: number,
  y0: number,
  height: number,
  R: number,
  profile: readonly (readonly [number, number])[],
  color: Vec3,
): void {
  const S = LATHE_SEGMENTS;
  const uv: UV = [0, 0];
  const ring = (k: number, s: number): Vec3 => {
    const [fy, fr] = profile[k]!;
    const azim = (s / S) * Math.PI * 2;
    return [cx + R * fr * Math.cos(azim), y0 + height * fy, cz + R * fr * Math.sin(azim)];
  };
  for (let k = 0; k + 1 < profile.length; k++) {
    const apex = profile[k + 1]![1] === 0;
    for (let s = 0; s < S; s++) {
      const a = ring(k, s);
      const b = ring(k, s + 1);
      const c = ring(k + 1, s + 1);
      const d = ring(k + 1, s);
      // (a, d, c) winds outward: up × azimuth-tangent points away from the axis.
      if (apex) {
        mesh.triangle(a, d, b, triNormal(a, d, b), uv, uv, uv, color);
      } else {
        mesh.triangle(a, d, c, triNormal(a, d, c), uv, uv, uv, color);
        mesh.triangle(a, c, b, triNormal(a, c, b), uv, uv, uv, color);
      }
    }
  }
}

/** Dome lathe profile: quarter circle with `DOME_RINGS` bands. */
function domeProfile(): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= DOME_RINGS; k++) {
    const th = (k / DOME_RINGS) * (Math.PI / 2);
    out.push([Math.sin(th), k === DOME_RINGS ? 0 : Math.cos(th)]);
  }
  return out;
}

/**
 * Build wall/roof mesh data: walls run from `minH` (default 0) to `h` above
 * terrain; a downward-facing bottom cap is emitted when `minH > 0`.
 */
export function buildBuildingsMesh(
  buildings: Building[],
  heightAt: HeightFn = FLAT_HEIGHT,
): MeshData {
  const mesh = new MeshBuilder();
  const usable: {
    ring: Vec2[];
    building: Building;
    base: number;
    roofY: number;
    minH: number;
    extras: { wall: Extra; roof: Extra } | null;
    /** Roofed (OSM `roof`, no curated `shape`) buildings only. */
    roof: {
      shape: RoofShape;
      wallTop: number;
      frame: RoofFrame;
      /** Crease-split ring + per-vertex roof heights (height-field shapes only). */
      dense: Vec2[] | null;
      tops: number[];
    } | null;
  }[] = [];
  for (const building of buildings) {
    const ring = normalizeRing(building.poly);
    if (Math.abs(ringArea(ring)) < AREA_EPS) continue;
    const { base, top } = ringHeights(ring, heightAt);
    const roofY = top + building.h;
    let roof: (typeof usable)[number]['roof'] = null;
    const r = building.roof;
    if (r !== undefined && building.shape === undefined) {
      const wallTop = roofY - r.h;
      const frame = roofFrame(ring, r.dir);
      if (isFieldShape(r.shape)) {
        const shape = r.shape;
        const dense = splitRing(ring, shape, creases(shape, frame.L, frame.W), frame);
        const tops = dense.map(([x, z]) => wallTop + r.h * fieldAt(shape, frame, x, z));
        roof = { shape, wallTop, frame, dense, tops };
      } else {
        roof = { shape: r.shape, wallTop, frame, dense: null, tops: [] };
      }
    }
    usable.push({
      ring,
      building,
      base,
      roofY,
      minH: building.minH ?? 0,
      extras: buildingExtras(building),
      roof,
    });
  }

  // `setExtra` only once some building carries OSM facade data (no attribute otherwise).
  let extraOn = false;
  const useExtra = (e: Extra | undefined): void => {
    if (e !== undefined) {
      mesh.setExtra(e);
      extraOn = true;
    } else if (extraOn) {
      mesh.setExtra(EXTRA_NONE);
    }
  };

  for (const { ring, building, base, roofY, minH, extras, roof } of usable) {
    const color = vertexColor(building);
    const wallBase = base + minH;
    useExtra(extras?.wall);
    if (roof !== null && roof.dense !== null) {
      emitRoofedWalls(mesh, roof.dense, roof.tops, wallBase, color);
      continue;
    }
    const wallTop = roof === null ? roofY : roof.wallTop;
    let dist = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const edge = Math.hypot(b[0] - a[0], b[1] - a[1]);
      emitWall(mesh, a, b, wallBase, wallTop, dist / TILE_M, (dist + edge) / TILE_M, color);
      dist += edge;
    }
    emitCap(mesh, ring, building, roofY, color);
  }
  mesh.endGroup(0);

  for (const { ring, building, roofY, minH, base, extras, roof } of usable) {
    const color = vertexColor(building);
    useExtra(extras?.roof);
    if (roof === null) {
      emitRoof(mesh, ring, roofY, color);
    } else if (roof.dense !== null) {
      const shape = roof.shape;
      if (!isFieldShape(shape)) continue;
      const { verts, tris } = cutRoof(roof.dense, shape, creases(shape, roof.frame.L, roof.frame.W), roof.frame);
      const rh = roofY - roof.wallTop;
      const ys = verts.map(([x, z], i) =>
        i < roof.tops.length ? roof.tops[i]! : roof.wallTop + rh * fieldAt(shape, roof.frame, x, z),
      );
      for (const t of tris) {
        const [ia, ib, ic] = [t[0]!, t[1]!, t[2]!];
        const pa = verts[ia]!;
        const pb = verts[ib]!;
        const pc = verts[ic]!;
        emitUpTri(mesh, [pa[0], ys[ia]!, pa[1]], [pb[0], ys[ib]!, pb[1]], [pc[0], ys[ic]!, pc[1]], color);
      }
    } else {
      emitRoof(mesh, ring, roof.wallTop, color);
      const [cx, cz] = ringCentroid(ring);
      const R = Math.min(roof.frame.L, roof.frame.W);
      const profile = roof.shape === 'onion' ? ONION_PROFILE : domeProfile();
      emitLathe(mesh, cx, cz, roof.wallTop, roofY - roof.wallTop, R, profile, color);
    }
    if (minH > 0) emitBottomCap(mesh, ring, base + minH, color);
  }
  mesh.endGroup(1);

  return mesh.build();
}

/** One city-wide mesh: Lambert walls (vertex colour × window map) + grey roofs. */
export function makeBuildingsObject(
  buildings: Building[],
  windowTex: THREE.Texture,
  heightAt: HeightFn = FLAT_HEIGHT,
): THREE.Mesh {
  const geom = toGeometry(buildBuildingsMesh(buildings, heightAt));
  const wallMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: windowTex });
  const roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x606060 });
  const mesh = new THREE.Mesh(geom, [wallMat, roofMat]);
  mesh.userData.surface = 'buildings';
  return mesh;
}
