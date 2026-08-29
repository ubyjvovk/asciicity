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

/**
 * A walkable corridor (e.g. a bridge) that overrides footprints: any point
 * within `halfWidth` metres of its centre-line polyline is never blocked.
 */
export interface Corridor {
  pts: Vec2[];
  halfWidth: number;
}

interface Footprint {
  poly: Vec2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** One corridor centre-line segment with its expanded bbox for bucketing. */
interface CorridorSeg {
  a: Vec2;
  b: Vec2;
  halfWidth: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A closed water ring with its bounding box for the parity test. */
interface WaterRing {
  poly: Vec2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** One water ring edge with its bbox for the shore-margin bucketing. */
interface WaterEdge {
  a: Vec2;
  b: Vec2;
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
  private readonly corridorCells: Map<string, CorridorSeg[]> = new Map();
  private readonly waterRings: WaterRing[] = [];
  private readonly waterEdgeCells: Map<string, WaterEdge[]> = new Map();

  /**
   * Bucket footprints, corridor segments, and water ring edges into the grid.
   * Footprints with `minH >= 2.5` are skipped (elevated building parts — the
   * player walks under them; architecture.md §4.6). Water rings are kept
   * whole (with their bbox) for the odd-parity point-in-polygon test used by
   * `blocked` — a point is "on water" only when it lies inside an ODD number
   * of rings (an island ring nested inside a Bay ring is walkable land).
   * Mirrors data-format.md "Coastline water" rule 6.
   */
  constructor(
    buildings: Building[],
    cell = 25,
    corridors: Corridor[] = [],
    water: Vec2[][] = [],
  ) {
    this.cell = cell;
    for (const b of buildings) {
      // Elevated parts (minH >= 2.5 m) are walkable — architecture.md §4.6.
      if ((b.minH ?? 0) >= 2.5) continue;
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
    // Bucket corridor centre-line segments into every cell their AABB (expanded
    // by `halfWidth`) touches, mirroring the footprint bucketing.
    for (const c of corridors) {
      const pts = c.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const minX = Math.min(a[0], b[0]) - c.halfWidth;
        const maxX = Math.max(a[0], b[0]) + c.halfWidth;
        const minZ = Math.min(a[1], b[1]) - c.halfWidth;
        const maxZ = Math.max(a[1], b[1]) + c.halfWidth;
        const seg: CorridorSeg = {
          a,
          b,
          halfWidth: c.halfWidth,
          minX,
          maxX,
          minZ,
          maxZ,
        };
        const cxMin = Math.floor(minX / cell);
        const cxMax = Math.floor(maxX / cell);
        const czMin = Math.floor(minZ / cell);
        const czMax = Math.floor(maxZ / cell);
        for (let cx = cxMin; cx <= cxMax; cx++) {
          for (let cz = czMin; cz <= czMax; cz++) {
            const key = `${cx},${cz}`;
            let bucket = this.corridorCells.get(key);
            if (!bucket) {
              bucket = [];
              this.corridorCells.set(key, bucket);
            }
            bucket.push(seg);
          }
        }
      }
    }
    // Water rings: keep each ring whole with its bbox (odd-parity test) and
    // bucket every ring edge into the cells its (radius-expanded) AABB touches
    // (shore-margin test — both sides of every shore).
    for (const ring of water) {
      if (ring.length < 3) continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const v of ring) {
        if (v[0] < minX) minX = v[0];
        if (v[0] > maxX) maxX = v[0];
        if (v[1] < minZ) minZ = v[1];
        if (v[1] > maxZ) maxZ = v[1];
      }
      this.waterRings.push({ poly: ring, minX, maxX, minZ, maxZ });
      const n = ring.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = ring[j];
        const b = ring[i];
        const eMinX = Math.min(a[0], b[0]) - 1;
        const eMaxX = Math.max(a[0], b[0]) + 1;
        const eMinZ = Math.min(a[1], b[1]) - 1;
        const eMaxZ = Math.max(a[1], b[1]) + 1;
        const edge: WaterEdge = {
          a,
          b,
          minX: eMinX,
          maxX: eMaxX,
          minZ: eMinZ,
          maxZ: eMaxZ,
        };
        const cxMin = Math.floor(eMinX / cell);
        const cxMax = Math.floor(eMaxX / cell);
        const czMin = Math.floor(eMinZ / cell);
        const czMax = Math.floor(eMaxZ / cell);
        for (let cx = cxMin; cx <= cxMax; cx++) {
          for (let cz = czMin; cz <= czMax; cz++) {
            const key = `${cx},${cz}`;
            let bucket = this.waterEdgeCells.get(key);
            if (!bucket) {
              bucket = [];
              this.waterEdgeCells.set(key, bucket);
            }
            bucket.push(edge);
          }
        }
      }
    }
  }

  /**
   * True when `p` is blocked: inside any nearby footprint or within `r` of one
   * of its edges; OR on water — `p` inside an ODD number of water rings
   * (parity: an island ring inside a Bay ring is walkable land) or within `r`
   * of any bucketed ring edge (shore margin, both sides of every shore).
   * Corridors (bridge roads) override footprints and water alike, so they are
   * checked first — a point on a corridor is never blocked.
   */
  blocked(p: Vec2, r: number = 0.6): boolean {
    const cx = Math.floor(p[0] / this.cell);
    const cz = Math.floor(p[1] / this.cell);
    // Corridors override footprints (water and buildings alike): a point on a
    // corridor is never blocked, checked first over the 3×3 neighbourhood.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const cbucket = this.corridorCells.get(`${cx + dx},${cz + dz}`);
        if (!cbucket) continue;
        for (const seg of cbucket) {
          if (
            p[0] >= seg.minX &&
            p[0] <= seg.maxX &&
            p[1] >= seg.minZ &&
            p[1] <= seg.maxZ &&
            distToSegment(p, seg.a, seg.b) <= seg.halfWidth
          ) {
            return false;
          }
        }
      }
    }
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
    // Water shore margin: within `r` of any nearby ring edge is blocked
    // (covers both sides of every shore uniformly). Bucketed like footprints.
    const seenEdge = new Set<WaterEdge>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.waterEdgeCells.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const edge of bucket) {
          if (seenEdge.has(edge)) continue;
          seenEdge.add(edge);
          if (
            p[0] < edge.minX - r ||
            p[0] > edge.maxX + r ||
            p[1] < edge.minZ - r ||
            p[1] > edge.maxZ + r
          ) {
            continue;
          }
          if (distToSegment(p, edge.a, edge.b) < r) return true;
        }
      }
    }
    // Odd-parity water test: only rings whose bbox contains `p` need a raycast
    // (44 bbox checks in SF, then ≤ 2 ray casts in practice). No allocation.
    let inside = 0;
    for (const ring of this.waterRings) {
      if (p[0] < ring.minX || p[0] > ring.maxX || p[1] < ring.minZ || p[1] > ring.maxZ) {
        continue;
      }
      if (pointInPolygon(p, ring.poly)) inside++;
    }
    if ((inside & 1) === 1) return true;
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
