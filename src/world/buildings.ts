/**
 * Building footprint → merged wall/roof mesh (docs/architecture.md §4.2).
 * Pure geometry: no DOM, no textures module (window tex is passed in).
 */
import * as THREE from 'three';
import { FLAT_HEIGHT, type Building, type HeightFn, type Vec2 } from '../data/types';
import { colorFor } from './palette';
import { MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';

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
function ringHeights(ring: Vec2[], heightAt: HeightFn): { base: number; top: number } {
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
  }[] = [];
  for (const building of buildings) {
    const ring = normalizeRing(building.poly);
    if (Math.abs(ringArea(ring)) < AREA_EPS) continue;
    const { base, top } = ringHeights(ring, heightAt);
    usable.push({
      ring,
      building,
      base,
      roofY: top + building.h,
      minH: building.minH ?? 0,
    });
  }

  for (const { ring, building, base, roofY, minH } of usable) {
    const color = vertexColor(building);
    const wallBase = base + minH;
    let dist = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const edge = Math.hypot(b[0] - a[0], b[1] - a[1]);
      emitWall(mesh, a, b, wallBase, roofY, dist / TILE_M, (dist + edge) / TILE_M, color);
      dist += edge;
    }
    emitCap(mesh, ring, building, roofY, color);
  }
  mesh.endGroup(0);

  for (const { ring, building, roofY, minH, base } of usable) {
    const color = vertexColor(building);
    emitRoof(mesh, ring, roofY, color);
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
  return new THREE.Mesh(geom, [wallMat, roofMat]);
}
