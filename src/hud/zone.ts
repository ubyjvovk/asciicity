/**
 * Spatial index for the HUD ZONE row: nearest named road, else nearby place.
 */
import type { Place, Road } from '../data/types';

/** Metres the segment bbox is grown by when inserting into cells. */
const BBOX_PAD = 30;
/** Use the road name when the player is this close (or closer). */
const ROAD_SNAP = 25;
/** Else prefix a place name when the player is this close (or closer). */
const PLACE_NEAR = 300;

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  name: string;
}

function cellKey(c: number, r: number): string {
  return `${c},${r}`;
}

/** Euclidean distance from `(px, pz)` to the closest point on segment a→b. */
function distToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Named-road cell index plus linear place scan; `zoneLabel` picks the HUD string. */
export class ZoneIndex {
  private readonly cell: number;
  private readonly buckets = new Map<string, Segment[]>();
  private readonly places: Place[];

  constructor(roads: Road[], places: Place[], cell = 50) {
    this.cell = cell;
    this.places = places;
    for (const road of roads) {
      if (!road.name) continue;
      const pts = road.pts;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg: Segment = { ax: a[0], az: a[1], bx: b[0], bz: b[1], name: road.name };
        const minX = Math.min(seg.ax, seg.bx) - BBOX_PAD;
        const maxX = Math.max(seg.ax, seg.bx) + BBOX_PAD;
        const minZ = Math.min(seg.az, seg.bz) - BBOX_PAD;
        const maxZ = Math.max(seg.az, seg.bz) + BBOX_PAD;
        const c0 = Math.floor(minX / cell);
        const c1 = Math.floor(maxX / cell);
        const r0 = Math.floor(minZ / cell);
        const r1 = Math.floor(maxZ / cell);
        for (let c = c0; c <= c1; c++) {
          for (let r = r0; r <= r1; r++) {
            const key = cellKey(c, r);
            let bucket = this.buckets.get(key);
            if (!bucket) {
              bucket = [];
              this.buckets.set(key, bucket);
            }
            bucket.push(seg);
          }
        }
      }
    }
  }

  /** Closest named-road segment in this cell and its 8 neighbours, or `null`. */
  nearestRoad(x: number, z: number): { name: string; dist: number } | null {
    const cc = Math.floor(x / this.cell);
    const rr = Math.floor(z / this.cell);
    const seen = new Set<Segment>();
    let best: { name: string; dist: number } | null = null;
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const bucket = this.buckets.get(cellKey(cc + dc, rr + dr));
        if (!bucket) continue;
        for (const seg of bucket) {
          if (seen.has(seg)) continue;
          seen.add(seg);
          const dist = distToSegment(x, z, seg.ax, seg.az, seg.bx, seg.bz);
          if (best === null || dist < best.dist) best = { name: seg.name, dist };
        }
      }
    }
    return best;
  }

  /** Closest place by Euclidean distance, or `null` when the index has none. */
  nearestPlace(x: number, z: number): { name: string; dist: number } | null {
    let best: { name: string; dist: number } | null = null;
    for (const p of this.places) {
      const dist = Math.hypot(x - p.x, z - p.z);
      if (best === null || dist < best.dist) best = { name: p.name, dist };
    }
    return best;
  }

  /** Road name (≤ 25 m), else `"NEAR "` + place (≤ 300 m), else `"CITY"`. */
  zoneLabel(x: number, z: number): string {
    const road = this.nearestRoad(x, z);
    if (road !== null && road.dist <= ROAD_SNAP) return road.name.toUpperCase();
    const place = this.nearestPlace(x, z);
    if (place !== null && place.dist <= PLACE_NEAR) return `NEAR ${place.name.toUpperCase()}`;
    return 'CITY';
  }
}
