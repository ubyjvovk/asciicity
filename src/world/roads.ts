/**
 * Flat road ribbons: one merged mesh of un-mitred quads sitting just above
 * the ground plane (docs/architecture.md §4.5).
 */
import * as THREE from 'three';
import type { Road, RoadClass } from '../data/types';
import { MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';

/** Metres of ribbon width per OSM-style road class. */
export const ROAD_WIDTH: Record<RoadClass, number> = {
  primary: 12,
  secondary: 9,
  tertiary: 7,
  residential: 6,
  service: 4,
  pedestrian: 4,
  footway: 2,
};

const ROAD_Y = 0.05;
const ROAD_NORMAL: Vec3 = [0, 1, 0];
const ROAD_UV: UV = [0, 0];

/** Hex → linear rgb via three.js colour management. */
function linearRgb(hex: number): Vec3 {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const COLOR_MAJOR = linearRgb(0x3c3c3c);
const COLOR_MINOR = linearRgb(0x2a2a2a);

function colorForClass(cls: RoadClass): Vec3 {
  return cls === 'primary' || cls === 'secondary' ? COLOR_MAJOR : COLOR_MINOR;
}

/** Build a merged triangle soup of flat road ribbons (y = 0.05, no mitres). */
export function buildRoadsMesh(roads: Road[]): MeshData {
  const mesh = new MeshBuilder();
  for (const road of roads) {
    const half = ROAD_WIDTH[road.cls] / 2;
    const color = colorForClass(road.cls);
    const pts = road.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const dx = q[0] - p[0];
      const dz = q[1] - p[1];
      const len = Math.hypot(dx, dz);
      if (len === 0) continue;
      const dX = dx / len;
      const dZ = dz / len;
      // Left normal l = (-d.z, 0, d.x) scaled by width/2.
      const lx = -dZ * half;
      const lz = dX * half;
      const a: Vec3 = [p[0] + lx, ROAD_Y, p[1] + lz];
      const b: Vec3 = [q[0] + lx, ROAD_Y, q[1] + lz];
      const c: Vec3 = [q[0] - lx, ROAD_Y, q[1] - lz];
      const d: Vec3 = [p[0] - lx, ROAD_Y, p[1] - lz];
      mesh.quad(a, b, c, d, ROAD_NORMAL, ROAD_UV, ROAD_UV, ROAD_UV, ROAD_UV, color);
    }
  }
  return mesh.build();
}

/** Wrap `buildRoadsMesh` in a single MeshBasicMaterial mesh with vertex colours. */
export function makeRoadsObject(roads: Road[]): THREE.Mesh {
  const geom = toGeometry(buildRoadsMesh(roads));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  return new THREE.Mesh(geom, mat);
}
