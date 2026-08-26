/**
 * Water polygons: triangulated rings at a constant y (flat London, or a
 * per-ring `levels[i] + 0.3` on terrain) so rivers and docks read as
 * dark-blue surfaces.
 */
import * as THREE from 'three';
import type { Vec2 } from '../data/types';
import { MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';

const WATER_Y = 0.02;
const WATER_LEVEL_LIFT = 0.3;
const AREA_EPS = 1;
const WATER_NORMAL: Vec3 = [0, 1, 0];
const WATER_UV: UV = [0, 0];
const WATER_HEX = 0x163a6b;

/** Convert a local-metre `[x, z]` ring to `Vector2`s for `ShapeUtils`. */
function asContour(poly: Vec2[]): THREE.Vector2[] {
  return poly.map(([x, z]) => new THREE.Vector2(x, z));
}

/** Signed `ShapeUtils.area` of a water ring (positive = CCW in x/z). */
function ringArea(poly: Vec2[]): number {
  return THREE.ShapeUtils.area(asContour(poly));
}

/** Copy of `poly` reversed when needed so `ShapeUtils.area` is positive. */
function normalizeRing(poly: Vec2[]): Vec2[] {
  const copy: Vec2[] = poly.map(([x, z]) => [x, z]);
  if (ringArea(copy) < 0) copy.reverse();
  return copy;
}

/** Linear rgb of `0x163a6b` via `THREE.Color` (working colour space). */
function waterColor(): Vec3 {
  const c = new THREE.Color(WATER_HEX);
  return [c.r, c.g, c.b];
}

/** Emit water triangles for a normalised ring; flip so `cross.y > 0`. */
function emitWater(mesh: MeshBuilder, ring: Vec2[], y: number, color: Vec3): void {
  const faces = THREE.ShapeUtils.triangulateShape(asContour(ring), []);
  const n = WATER_NORMAL;
  const uv = WATER_UV;
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
    if (crossY >= 0) mesh.triangle(a, b, c, n, uv, uv, uv, color);
    else mesh.triangle(a, c, b, n, uv, uv, uv, color);
  }
}

/** Merged triangle soup of water polygons (y = levels[i]+0.3, else 0.02). */
export function buildWaterMesh(rings: Vec2[][], levels?: number[]): MeshData {
  if (levels !== undefined && levels.length < rings.length) {
    throw new Error('levels is shorter than rings');
  }
  const mesh = new MeshBuilder();
  const color = waterColor();
  for (let i = 0; i < rings.length; i++) {
    const poly = rings[i]!;
    if (poly.length < 3) continue;
    const ring = normalizeRing(poly);
    if (Math.abs(ringArea(ring)) < AREA_EPS) continue;
    const y = levels !== undefined ? levels[i]! + WATER_LEVEL_LIFT : WATER_Y;
    emitWater(mesh, ring, y, color);
  }
  mesh.endGroup(0);
  return mesh.build();
}

/** Wrap `buildWaterMesh` in a single MeshBasicMaterial mesh with vertex colours. */
export function makeWaterObject(rings: Vec2[][], levels?: number[]): THREE.Mesh {
  const geom = toGeometry(buildWaterMesh(rings, levels));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  return new THREE.Mesh(geom, mat);
}
