/**
 * Building-footprint collision: point-in-polygon, edge distance, and a
 * spatial-hash `CollisionGrid` used by the player controller to stay out of
 * buildings. Pure module — no three.js or DOM. Contract:
 * docs/architecture.md §4.6, algorithm details in docs/collision.md.
 */
import type { Building, Vec2 } from '../data/types';

/** Ray-casting point-in-polygon test; correct for either winding. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  const px = p[0];
  const py = p[1];
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const straddles = (yi > py) !== (yj > py);
    if (straddles && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest Euclidean distance from `p` to the segment `a→b`. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ax = a[0];
  const ay = a[1];
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = p[0] - cx;
  const ey = p[1] - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

interface Footprint {
  poly: Vec2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Spatial hash bucketing building footprints for near-constant-time
 * `blocked`/`resolve` queries (docs/architecture.md §4.6).
 */
export class CollisionGrid {
  private readonly cell: number;
  private readonly cells: Map<string, Footprint[]> = new Map();

  /** Bucket each footprint into every cell its (radius-expanded) AABB touches. */
  constructor(buildings: Building[], cell = 25) {
    this.cell = cell;
    for (const b of buildings) {
      if (b.poly.length < 3) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const v of b.poly) {
        if (v[0] < minX) minX = v[0];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] < minZ) minZ = v[1];
        if (v[1] > maxZ) maxZ = v[1];
      }
      const fp: Footprint = { poly: b.poly, minX, maxX, minZ, maxZ };
      const cxMin = Math.floor((minX - 1) / cell);
      const cxMax = Math.floor((maxX + 1) / cell);
      const czMin = Math.floor((minZ - 1) / cell);
      const czMax = Math.floor((maxZ + 1) / cell);
      for (let cx = cxMin; cx <= cxMax; cx++) {
        for (let cz = czMin; cz <= czMax; cz++) {
          const key = `${cx},${cz}`;
          let bucket = this.cells.get(key);
          if (!bucket) {
            bucket = [];
            this.cells.set(key, bucket);
          }
          bucket.push(fp);
        }
      }
    }
  }

  /** True when `p` is inside any nearby footprint or within `r` of one of its edges. */
  blocked(p: Vec2, r: number = 0.6): boolean {
    const cx = Math.floor(p[0] / this.cell);
    const cz = Math.floor(p[1] / this.cell);
    const seen = new Set<Footprint>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.cells.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const fp of bucket) {
          if (seen.has(fp)) continue;
          seen.add(fp);
          if (
            p[0] < fp.minX - r ||
            p[0] > fp.maxX + r ||
            p[1] < fp.minZ - r ||
            p[1] > fp.maxZ + r
          ) {
            continue;
          }
          if (pointInPolygon(p, fp.poly)) return true;
          const poly = fp.poly;
          const n = poly.length;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            if (distToSegment(p, poly[j], poly[i]) < r) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Return the furthest legal position along `from → to`: `to` when free, else
   * slide along `x` (`[to.x, from.z]`) or `z` (`[from.x, to.z]`), else `from`.
   */
  resolve(from: Vec2, to: Vec2, r: number = 0.6): Vec2 {
    if (!this.blocked(to, r)) return to;
    const slideX: Vec2 = [to[0], from[1]];
    if (!this.blocked(slideX, r)) return slideX;
    const slideZ: Vec2 = [from[0], to[1]];
    if (!this.blocked(slideZ, r)) return slideZ;
    return from;
  }
}
