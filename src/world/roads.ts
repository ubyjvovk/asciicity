/**
 * Road ribbons: un-mitred quads draped over terrain in 10 m sub-segments
 * (docs/architecture.md §4.5).
 */
import * as THREE from 'three';
import { FLAT_HEIGHT, type HeightFn, type Road, type RoadClass } from '../data/types';
import { MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';
import { bridgeProfile } from './terrain';

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

/** Metres the ribbon sits above the sampled ground (or bridge deck). */
export const ROAD_LIFT = 0.15;

const ROAD_NORMAL: Vec3 = [0, 1, 0];
const ROAD_UV: UV = [0, 0];

/** Hex → linear rgb via three.js colour management. */
function linearRgb(hex: number): Vec3 {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const COLOR_MAJOR = linearRgb(0x585858);
const COLOR_MINOR = linearRgb(0x404040);

function colorForClass(cls: RoadClass): Vec3 {
  return cls === 'primary' || cls === 'secondary' ? COLOR_MAJOR : COLOR_MINOR;
}

/** Linear interpolate `a` and `b` at fraction `f`. */
function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Build a merged triangle soup of draped road ribbons (no mitres). */
export function buildRoadsMesh(roads: Road[], heightAt: HeightFn = FLAT_HEIGHT): MeshData {
  const mesh = new MeshBuilder();
  for (const road of roads) {
    const half = ROAD_WIDTH[road.cls] / 2;
    const color = colorForClass(road.cls);
    const pts = road.pts;
    const deckYs = road.bridge === true ? bridgeProfile(pts, heightAt) : undefined;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      const dx = q[0] - p[0];
      const dz = q[1] - p[1];
      const len = Math.hypot(dx, dz);
      if (len === 0) continue;
      const dX = dx / len;
      const dZ = dz / len;
      // Left normal l = (-d.z, 0, d.x) scaled by width/2.
      const lx = -dZ * half;
      const lz = dX * half;
      const nSeg = Math.max(1, Math.ceil(len / 10));
      const y0Deck = deckYs ? deckYs[i]! : 0;
      const y1Deck = deckYs ? deckYs[i + 1]! : 0;
      for (let k = 0; k < nSeg; k++) {
        const f0 = k / nSeg;
        const f1 = (k + 1) / nSeg;
        const p0x = p[0] + dx * f0;
        const p0z = p[1] + dz * f0;
        const p1x = p[0] + dx * f1;
        const p1z = p[1] + dz * f1;
        const aX = p0x + lx;
        const aZ = p0z + lz;
        const bX = p1x + lx;
        const bZ = p1z + lz;
        const cX = p1x - lx;
        const cZ = p1z - lz;
        const dX2 = p0x - lx;
        const dZ2 = p0z - lz;
        let ya: number;
        let yb: number;
        let yc: number;
        let yd: number;
        if (deckYs) {
          const y0 = lerp(y0Deck, y1Deck, f0) + ROAD_LIFT;
          const y1 = lerp(y0Deck, y1Deck, f1) + ROAD_LIFT;
          ya = y0;
          yb = y1;
          yc = y1;
          yd = y0;
        } else {
          ya = heightAt(aX, aZ) + ROAD_LIFT;
          yb = heightAt(bX, bZ) + ROAD_LIFT;
          yc = heightAt(cX, cZ) + ROAD_LIFT;
          yd = heightAt(dX2, dZ2) + ROAD_LIFT;
        }
        const a: Vec3 = [aX, ya, aZ];
        const b: Vec3 = [bX, yb, bZ];
        const c: Vec3 = [cX, yc, cZ];
        const d: Vec3 = [dX2, yd, dZ2];
        mesh.quad(a, b, c, d, ROAD_NORMAL, ROAD_UV, ROAD_UV, ROAD_UV, ROAD_UV, color);
      }
    }
  }
  return mesh.build();
}

/** Wrap `buildRoadsMesh` in a single MeshBasicMaterial mesh with vertex colours. */
export function makeRoadsObject(roads: Road[], heightAt: HeightFn = FLAT_HEIGHT): THREE.Mesh {
  const geom = toGeometry(buildRoadsMesh(roads, heightAt));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  return new THREE.Mesh(geom, mat);
}
