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

/** Walls (group 0) then roofs (group 1) for every building with `|area| >= 1`. */
export function buildBuildingsMesh(
  buildings: Building[],
  heightAt: HeightFn = FLAT_HEIGHT,
): MeshData {
  const mesh = new MeshBuilder();
  const usable: { ring: Vec2[]; building: Building; base: number; roofY: number }[] = [];
  for (const building of buildings) {
    const ring = normalizeRing(building.poly);
    if (Math.abs(ringArea(ring)) < AREA_EPS) continue;
    const { base, top } = ringHeights(ring, heightAt);
    usable.push({ ring, building, base, roofY: top + building.h });
  }

  for (const { ring, building, base, roofY } of usable) {
    const color = vertexColor(building);
    let dist = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % n]!;
      const edge = Math.hypot(b[0] - a[0], b[1] - a[1]);
      emitWall(mesh, a, b, base, roofY, dist / TILE_M, (dist + edge) / TILE_M, color);
      dist += edge;
    }
  }
  mesh.endGroup(0);

  for (const { ring, building, roofY } of usable) {
    emitRoof(mesh, ring, roofY, vertexColor(building));
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
