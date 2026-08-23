/**
 * Heading-up minimap: nearby building footprints, roads, player arrow, north
 * marker. Pure projection + cell lookup run in node; the class draws on a
 * canvas and has no top-level DOM access. Contract: docs/minimap.md.
 */
import './minimap.css';
import type { Building, CityData, Vec2 } from '../data/types';

/** Uniform cell size used to bucket footprints and road segments (metres). */
const CELL = 100;

/** Canvas size, world radius, and heading-up vs north-up. */
export interface MinimapOptions {
  /** Canvas px (width = height). Default 180. */
  size: number;
  /** Metres from centre to the canvas edge. Default 160. */
  radius: number;
  /** Rotate so the player's forward vector maps straight up. Default true. */
  headingUp: boolean;
}

const DEFAULTS: MinimapOptions = {
  size: 180,
  radius: 160,
  headingUp: true,
};

interface StoredBuilding {
  poly: Vec2[];
  named: boolean;
}

interface StoredSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

interface CellBucket {
  buildings: StoredBuilding[];
  segs: StoredSeg[];
}

function cellKey(c: number, r: number): string {
  return `${c},${r}`;
}

/**
 * Project a world point `(px, pz)` into canvas pixels relative to `player`.
 * When `headingUp`, the player's forward vector maps straight up the canvas.
 */
export function worldToMinimap(
  px: number,
  pz: number,
  player: { x: number; z: number; yaw: number },
  opts: MinimapOptions,
): [number, number] {
  const dx = px - player.x;
  const dz = pz - player.z;
  let rx: number;
  let rz: number;
  if (opts.headingUp) {
    const cy = Math.cos(player.yaw);
    const sy = Math.sin(player.yaw);
    rx = dx * cy + dz * sy;
    rz = -dx * sy + dz * cy;
  } else {
    rx = dx;
    rz = dz;
  }
  const k = opts.size / 2 / opts.radius;
  return [opts.size / 2 + rx * k, opts.size / 2 + rz * k];
}

/**
 * Keys of cells whose square intersects the circle's axis-aligned bounding box
 * around `(x, z)` (`"c,r"` with `c = floor(x / cell)`).
 */
export function nearbyCells(x: number, z: number, radius: number, cell: number): string[] {
  const c0 = Math.floor((x - radius) / cell);
  const c1 = Math.floor((x + radius) / cell);
  const r0 = Math.floor((z - radius) / cell);
  const r1 = Math.floor((z + radius) / cell);
  const keys: string[] = [];
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      keys.push(cellKey(c, r));
    }
  }
  return keys;
}

/** Top-down canvas of nearby buildings and roads around the player. */
export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly opts: MinimapOptions;
  private readonly buckets = new Map<string, CellBucket>();

  constructor(canvas: HTMLCanvasElement, city: CityData, opts?: Partial<MinimapOptions>) {
    this.opts = { ...DEFAULTS, ...opts };
    this.canvas = canvas;
    canvas.width = this.opts.size;
    canvas.height = this.opts.size;
    canvas.classList.add('minimap');
    this.ctx = canvas.getContext('2d');
    this.bucket(city);
  }

  /** Redraw nearby roads, buildings, the player arrow, and the north letter. */
  update(player: { x: number; z: number; yaw: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const opts = this.opts;
    const { size } = opts;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);

    const keys = nearbyCells(player.x, player.z, opts.radius, CELL);
    const seenSegs = new Set<StoredSeg>();
    const seenBuildings = new Set<StoredBuilding>();

    ctx.strokeStyle = '#2a8040';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      for (const seg of bucket.segs) {
        if (seenSegs.has(seg)) continue;
        seenSegs.add(seg);
        const [x0, y0] = worldToMinimap(seg.ax, seg.az, player, opts);
        const [x1, y1] = worldToMinimap(seg.bx, seg.bz, player, opts);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
    }
    ctx.stroke();

    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      for (const b of bucket.buildings) {
        if (seenBuildings.has(b)) continue;
        seenBuildings.add(b);
        const poly = b.poly;
        if (poly.length < 3) continue;
        ctx.beginPath();
        const first = poly[0];
        const [x0, y0] = worldToMinimap(first[0], first[1], player, opts);
        ctx.moveTo(x0, y0);
        for (let i = 1; i < poly.length; i++) {
          const p = poly[i];
          const [x, y] = worldToMinimap(p[0], p[1], player, opts);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = b.named ? '#48e06a' : '#1f5a2a';
        ctx.fill();
      }
    }

    ctx.save();
    ctx.translate(size / 2, size / 2);
    if (!opts.headingUp) ctx.rotate(player.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4, 4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fillStyle = '#8aff9e';
    ctx.fill();
    ctx.restore();

    const [nx, ny] = northMarker(player, opts);
    ctx.fillStyle = '#8aff9e';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);
  }

  /** Bucket every footprint and road segment into the 100 m cell grid once. */
  private bucket(city: CityData): void {
    for (const b of city.buildings) {
      insertBuilding(this.buckets, b);
    }
    for (const road of city.roads) {
      const pts = road.pts;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        insertSeg(this.buckets, { ax: a[0], az: a[1], bx: b[0], bz: b[1] });
      }
    }
  }
}

function insertBuilding(buckets: Map<string, CellBucket>, b: Building): void {
  const poly = b.poly;
  if (poly.length < 3) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const stored: StoredBuilding = { poly, named: Boolean(b.name) };
  forEachCell(minX, maxX, minZ, maxZ, (bucket) => {
    bucket.buildings.push(stored);
  }, buckets);
}

function insertSeg(buckets: Map<string, CellBucket>, seg: StoredSeg): void {
  const minX = Math.min(seg.ax, seg.bx);
  const maxX = Math.max(seg.ax, seg.bx);
  const minZ = Math.min(seg.az, seg.bz);
  const maxZ = Math.max(seg.az, seg.bz);
  forEachCell(minX, maxX, minZ, maxZ, (bucket) => {
    bucket.segs.push(seg);
  }, buckets);
}

function forEachCell(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  fn: (bucket: CellBucket) => void,
  buckets: Map<string, CellBucket>,
): void {
  const c0 = Math.floor(minX / CELL);
  const c1 = Math.floor(maxX / CELL);
  const r0 = Math.floor(minZ / CELL);
  const r1 = Math.floor(maxZ / CELL);
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      const key = cellKey(c, r);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { buildings: [], segs: [] };
        buckets.set(key, bucket);
      }
      fn(bucket);
    }
  }
}

/** Canvas position of the letter N, 8 px inside the edge toward world north. */
function northMarker(
  player: { x: number; z: number; yaw: number },
  opts: MinimapOptions,
): [number, number] {
  const [qx, qy] = worldToMinimap(player.x, player.z - 1, player, opts);
  const cx = opts.size / 2;
  const cy = opts.size / 2;
  let dx = qx - cx;
  let dy = qy - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [cx, 8];
  dx /= len;
  dy /= len;
  const t = cx / Math.max(Math.abs(dx), Math.abs(dy));
  const dist = Math.max(0, t - 8);
  return [cx + dx * dist, cy + dy * dist];
}
