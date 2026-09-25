/**
 * Distance-streamed 250 m cells for cyberpunk layers (wave 20b). PM-owned.
 *
 * Layers that generate geometry from city data (detail, props, neon) must
 * not build the whole city: `CellStreamer` buckets every resident source's
 * buildings and roads into square cells, builds cells whose centre is within
 * `buildRadius` of the camera (nearest first, at most `maxBuildsPerFrame` per
 * frame) and disposes cells beyond `disposeRadius`. The layer supplies only
 * `build(cell)` → an Object3D (or null for "nothing here").
 *
 * Bucketing is pure (`bucketSources`, unit-tested); the streamer only adds /
 * removes the returned objects under the layer's root.
 */
import type { Object3D } from 'three';
import type { Building, Road, Vec2 } from '../../data/types';
import type { PunkSource } from './layer';

/** Default cell edge in metres. */
export const CELL_SIZE = 250;

/** One bucket of city data. Buildings by first footprint vertex, roads by their middle vertex. */
export interface CellData {
  /** `"<ci>_<cj>"` with `ci = floor(x / size)`, `cj = floor(z / size)`. */
  key: string;
  ci: number;
  cj: number;
  /** Cell centre, world metres. */
  cx: number;
  cz: number;
  buildings: Building[];
  roads: Road[];
}

function cellOf(p: Vec2, size: number): [number, number] {
  return [Math.floor(p[0] / size), Math.floor(p[1] / size)];
}

/**
 * Bucket every source into cells of `size` metres. Deterministic: within a
 * cell, buildings and roads keep source iteration order, then array order.
 * Buildings with an empty footprint and roads with no points are skipped.
 */
export function bucketSources(sources: ReadonlyMap<string, PunkSource>, size = CELL_SIZE): Map<string, CellData> {
  const cells = new Map<string, CellData>();
  const get = (ci: number, cj: number): CellData => {
    const key = `${ci}_${cj}`;
    let c = cells.get(key);
    if (!c) {
      c = { key, ci, cj, cx: (ci + 0.5) * size, cz: (cj + 0.5) * size, buildings: [], roads: [] };
      cells.set(key, c);
    }
    return c;
  };
  for (const src of sources.values()) {
    for (const b of src.buildings) {
      const p = b.poly[0];
      if (!p) continue;
      const [ci, cj] = cellOf(p, size);
      get(ci, cj).buildings.push(b);
    }
    for (const r of src.roads) {
      const p = r.pts[Math.floor(r.pts.length / 2)];
      if (!p) continue;
      const [ci, cj] = cellOf(p, size);
      get(ci, cj).roads.push(r);
    }
  }
  return cells;
}

/**
 * Content signature of one cell: counts plus an id checksum. A tile arriving
 * or leaving changes only the cells it overlaps, so only those rebuild.
 */
export function cellSignature(c: CellData): string {
  let ids = 0;
  for (const b of c.buildings) ids = (ids * 31 + b.id) % 2147483647;
  let pts = 0;
  for (const r of c.roads) pts += r.pts.length;
  return `${c.buildings.length}:${c.roads.length}:${pts}:${ids}`;
}

// One bucketing per source-map change, shared by every layer's streamer (all
// layers read the same `ctx.sources` instance with the same cell size).
let bucketCache: { sources: ReadonlyMap<string, PunkSource>; sig: string; size: number; cells: Map<string, CellData> } | null = null;

function bucketShared(sources: ReadonlyMap<string, PunkSource>, sig: string, size: number): Map<string, CellData> {
  const c = bucketCache;
  if (c && c.sources === sources && c.sig === sig && c.size === size) return c.cells;
  const cells = bucketSources(sources, size);
  bucketCache = { sources, sig, size, cells };
  return cells;
}

/** A cheap signature of the source map: changes whenever a chunk is added/removed. */
export function sourcesSignature(sources: ReadonlyMap<string, PunkSource>): string {
  const parts: string[] = [];
  for (const [k, v] of sources) parts.push(`${k}:${v.buildings.length}:${v.roads.length}`);
  return parts.sort().join('|');
}

/** Streamer options. */
export interface CellStreamerOptions {
  /** Build cells whose centre is within this many metres of the camera (xz). */
  buildRadius: number;
  /** Dispose built cells whose centre is beyond this (must be > buildRadius). */
  disposeRadius: number;
  /** Cell builds per `update` call (default 1) — spreads the cost over frames. */
  maxBuildsPerFrame?: number;
  /** Cell edge (default {@link CELL_SIZE}). */
  cellSize?: number;
  /** Build the geometry for one cell; null = nothing to show. */
  build(cell: CellData): Object3D | null;
  /** Free what `build` returned (geometries/materials you own). */
  dispose(obj: Object3D): void;
}

/** Builds / disposes cells around the camera. */
export class CellStreamer {
  private readonly opts: Required<Omit<CellStreamerOptions, 'build' | 'dispose'>> &
    Pick<CellStreamerOptions, 'build' | 'dispose'>;
  private cells = new Map<string, CellData>();
  private signature = '';
  private readonly built = new Map<string, Object3D | null>();
  /** `cellSignature` of each built cell at build time. */
  private readonly builtSig = new Map<string, string>();
  private lastBuildMs = 0;
  private pendingCount = 0;

  constructor(opts: CellStreamerOptions) {
    this.opts = { maxBuildsPerFrame: 1, cellSize: CELL_SIZE, ...opts };
  }

  /** Re-bucket if the sources changed, dispose far cells, build the nearest missing ones. */
  update(sources: ReadonlyMap<string, PunkSource>, camX: number, camZ: number, root: Object3D): void {
    const sig = sourcesSignature(sources);
    if (sig !== this.signature) {
      this.signature = sig;
      this.cells = bucketShared(sources, sig, this.opts.cellSize);
      // Rebuild only the built cells whose content changed (a streamed tile
      // touches a few cells; dropping them all made every layer rebuild its
      // whole neighbourhood on each tile event — wave 24 stutter fix).
      for (const key of [...this.built.keys()]) {
        const c = this.cells.get(key);
        if (!c || cellSignature(c) !== this.builtSig.get(key)) this.drop(key, root);
      }
    }
    const d2 = (c: CellData): number => (c.cx - camX) ** 2 + (c.cz - camZ) ** 2;
    for (const key of [...this.built.keys()]) {
      const c = this.cells.get(key);
      if (!c || d2(c) > this.opts.disposeRadius ** 2) this.drop(key, root);
    }
    const want: CellData[] = [];
    for (const c of this.cells.values()) {
      if (!this.built.has(c.key) && d2(c) <= this.opts.buildRadius ** 2) want.push(c);
    }
    want.sort((a, b) => d2(a) - d2(b));
    this.pendingCount = Math.max(0, want.length - this.opts.maxBuildsPerFrame);
    for (const c of want.slice(0, this.opts.maxBuildsPerFrame)) {
      const t0 = performance.now();
      const obj = this.opts.build(c);
      this.lastBuildMs = performance.now() - t0;
      if (obj) root.add(obj);
      this.built.set(c.key, obj);
      this.builtSig.set(c.key, cellSignature(c));
    }
  }

  /** Remove and dispose every built cell (layer detach / dispose). */
  clear(root: Object3D): void {
    for (const key of [...this.built.keys()]) this.drop(key, root);
    this.signature = '';
  }

  /** Keys of built cells (incl. empty ones). */
  builtKeys(): string[] {
    return [...this.built.keys()];
  }

  /** `cells` built, `pending` in range but not built yet, `buildMs` of the last build. */
  stats(): { cells: number; pending: number; buildMs: number } {
    return { cells: this.built.size, pending: this.pendingCount, buildMs: Math.round(this.lastBuildMs * 10) / 10 };
  }

  private drop(key: string, root: Object3D): void {
    const obj = this.built.get(key);
    if (obj) {
      root.remove(obj);
      this.opts.dispose(obj);
    }
    this.built.delete(key);
    this.builtSig.delete(key);
  }
}
