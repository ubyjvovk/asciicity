/**
 * TileManager — pure sector-streaming scheduler (architecture.md §4.19).
 * No three.js, no DOM; unit-tested in node with an injected loader.
 */
import type { Building, Road, TileData, TileIndexData } from '../data/types';

/** Default load radius in metres (wanted set = 5×5 of 1000 m tiles at rest). */
const DEFAULT_LOAD_R = 2000;
/** Default unload radius in metres (hysteresis around the load square). */
const DEFAULT_UNLOAD_R = 2600;
/** Simultaneous unresolved `loadTile` calls. */
const MAX_IN_FLIGHT = 2;

/** A tile becoming resident or leaving residency. */
export type TileEvent =
  | { kind: 'add'; key: string; tile: TileData }
  | { kind: 'remove'; key: string };

/** Optional constructor radii; `?tileradius` scaling is applied by the caller. */
export interface TileManagerOpts {
  loadR?: number;
  unloadR?: number;
}

/** Concatenated buildings/roads of currently added tiles, plus a change counter. */
export interface TileSnapshot {
  buildings: Building[];
  roads: Road[];
  version: number;
}

interface TileCoord {
  i: number;
  j: number;
}

interface ReadyItem {
  key: string;
  tile: TileData;
}

/** `"i_j"` key for a tile coordinate (negative indices keep the minus sign). */
function tileKey(i: number, j: number): string {
  return `${i}_${j}`;
}

/** Parse `"i_j"` (including `"-3_2"`); `null` if the key is not a tile index. */
function parseKey(key: string): TileCoord | null {
  const m = /^(-?\d+)_(-?\d+)$/.exec(key);
  if (!m) return null;
  return { i: Number(m[1]), j: Number(m[2]) };
}

/**
 * Whether tile `(i, j)`'s half-open rect intersects the closed square
 * `[x − r, x + r] × [z − r, z + r]`. Equivalent to i, j falling in
 * `[floor((x−r)/S), floor((x+r)/S)]` (and the same for z).
 */
function inSquare(
  i: number,
  j: number,
  x: number,
  z: number,
  r: number,
  S: number,
): boolean {
  const i0 = Math.floor((x - r) / S);
  const i1 = Math.floor((x + r) / S);
  const j0 = Math.floor((z - r) / S);
  const j1 = Math.floor((z + r) / S);
  return i >= i0 && i <= i1 && j >= j0 && j <= j1;
}

/** Euclidean distance from `(x, z)` to the centre of tile `(i, j)`. */
function distToCentre(i: number, j: number, x: number, z: number, S: number): number {
  const cx = (i + 0.5) * S;
  const cz = (j + 0.5) * S;
  return Math.hypot(cx - x, cz - z);
}

/**
 * Schedules which 1000 m tiles to fetch, build, and drop around the player.
 * A tile is observable (`snapshot` / `loadedKeys`) only after its `add`
 * event has been taken; fetch completion alone changes nothing visible.
 */
export class TileManager {
  private readonly index: TileIndexData;
  private readonly loadTile: (key: string) => Promise<TileData>;
  private readonly loadR: number;
  private readonly unloadR: number;

  private x = 0;
  private z = 0;
  private primed = false;

  private readonly added = new Map<string, TileData>();
  private readonly inFlight = new Set<string>();
  private readonly ready: ReadyItem[] = [];
  private readonly readyKeys = new Set<string>();
  /** Failed twice while continuously wanted; cleared when the tile leaves wanted. */
  private readonly skipped = new Set<string>();
  /** `loadTile` attempts for a key in the current wanted stay. */
  private readonly attempts = new Map<string, number>();

  private version = 0;
  private cached: TileSnapshot | null = null;

  /**
   * `loadTile` is injected so tests can drive fetches with deferred promises.
   * `opts.loadR` / `opts.unloadR` default to 2000 / 2600.
   */
  constructor(
    index: TileIndexData,
    loadTile: (key: string) => Promise<TileData>,
    opts?: TileManagerOpts,
  ) {
    this.index = index;
    this.loadTile = loadTile;
    this.loadR = opts?.loadR ?? DEFAULT_LOAD_R;
    this.unloadR = opts?.unloadR ?? DEFAULT_UNLOAD_R;
  }

  /**
   * Recompute the wanted set around `(x, z)` and fill in-flight slots
   * nearest-first, at most two unresolved `loadTile` calls.
   */
  update(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.primed = true;
    for (const key of [...this.skipped]) {
      if (!this.isWanted(key)) this.skipped.delete(key);
    }
    for (const [key] of [...this.attempts]) {
      if (!this.isWanted(key) && !this.inFlight.has(key)) this.attempts.delete(key);
    }
    this.pumpFetches();
  }

  /**
   * Drain queued events: every pending `remove`, then at most one `add`.
   * Call once per frame so builds stay inside the §4.18 budget.
   */
  take(): TileEvent[] {
    const events: TileEvent[] = [];
    if (this.primed) {
      for (const key of [...this.added.keys()]) {
        if (!this.shouldDrop(key)) continue;
        this.added.delete(key);
        events.push({ kind: 'remove', key });
      }
    }
    for (let i = this.ready.length - 1; i >= 0; i--) {
      const item = this.ready[i]!;
      if (this.primed && this.shouldDrop(item.key)) {
        this.ready.splice(i, 1);
        this.readyKeys.delete(item.key);
      }
    }
    if (this.ready.length > 0) {
      const item = this.ready.shift()!;
      this.readyKeys.delete(item.key);
      this.added.set(item.key, item.tile);
      events.push({ kind: 'add', key: item.key, tile: item.tile });
    }
    if (events.length > 0) this.bump();
    return events;
  }

  /**
   * Buildings and roads of currently added tiles, cached until the added
   * set changes. A fetched-but-not-taken tile is not included.
   */
  snapshot(): TileSnapshot {
    if (this.cached) return this.cached;
    const buildings: Building[] = [];
    const roads: Road[] = [];
    const keys = [...this.added.keys()].sort(compareKeys);
    for (const key of keys) {
      const tile = this.added.get(key)!;
      for (const b of tile.buildings) buildings.push(b);
      for (const r of tile.roads) roads.push(r);
    }
    const snap: TileSnapshot = { buildings, roads, version: this.version };
    this.cached = snap;
    return snap;
  }

  /** Keys whose `add` event has been taken and not yet removed. */
  loadedKeys(): string[] {
    return [...this.added.keys()];
  }

  /** In-flight fetches plus fetched tiles waiting for `take()`. */
  pending(): number {
    return this.inFlight.size + this.ready.length;
  }

  private bump(): void {
    this.version += 1;
    this.cached = null;
  }

  private shouldDrop(key: string): boolean {
    if (this.isWanted(key)) return false;
    if (this.inUnload(key)) return false;
    return true;
  }

  private isWanted(key: string): boolean {
    if (!this.primed) return false;
    if (this.index.tiles[key] === undefined) return false;
    const t = parseKey(key);
    if (!t) return false;
    const S = this.index.tileSize;
    const pi = Math.floor(this.x / S);
    const pj = Math.floor(this.z / S);
    if (Math.abs(t.i - pi) <= 1 && Math.abs(t.j - pj) <= 1) return true;
    return inSquare(t.i, t.j, this.x, this.z, this.loadR, S);
  }

  private inUnload(key: string): boolean {
    if (!this.primed) return false;
    const t = parseKey(key);
    if (!t) return false;
    return inSquare(t.i, t.j, this.x, this.z, this.unloadR, this.index.tileSize);
  }

  private pumpFetches(): void {
    if (!this.primed) return;
    while (this.inFlight.size < MAX_IN_FLIGHT) {
      const key = this.pickNext();
      if (key === undefined) break;
      this.startFetch(key);
    }
  }

  private pickNext(): string | undefined {
    const S = this.index.tileSize;
    let best: string | undefined;
    let bestD = Infinity;
    this.forEachWanted((key, i, j) => {
      if (this.added.has(key)) return;
      if (this.inFlight.has(key)) return;
      if (this.readyKeys.has(key)) return;
      if (this.skipped.has(key)) return;
      const d = distToCentre(i, j, this.x, this.z, S);
      if (best === undefined || d < bestD || (d === bestD && key < best)) {
        best = key;
        bestD = d;
      }
    });
    return best;
  }

  private forEachWanted(fn: (key: string, i: number, j: number) => void): void {
    const S = this.index.tileSize;
    const x = this.x;
    const z = this.z;
    const pi = Math.floor(x / S);
    const pj = Math.floor(z / S);
    const seen = new Set<string>();
    const visit = (i: number, j: number): void => {
      const key = tileKey(i, j);
      if (seen.has(key)) return;
      if (this.index.tiles[key] === undefined) return;
      seen.add(key);
      fn(key, i, j);
    };
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) visit(pi + di, pj + dj);
    }
    const i0 = Math.floor((x - this.loadR) / S);
    const i1 = Math.floor((x + this.loadR) / S);
    const j0 = Math.floor((z - this.loadR) / S);
    const j1 = Math.floor((z + this.loadR) / S);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) visit(i, j);
    }
  }

  private startFetch(key: string): void {
    this.inFlight.add(key);
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    void Promise.resolve()
      .then(() => this.loadTile(key))
      .then(
        (tile) => this.onFetchOk(key, tile),
        (err: unknown) => this.onFetchFail(key, err),
      );
  }

  private onFetchOk(key: string, tile: TileData): void {
    this.inFlight.delete(key);
    if (this.added.has(key) || this.readyKeys.has(key)) {
      this.pumpFetches();
      return;
    }
    if (this.primed && this.shouldDrop(key)) {
      this.attempts.delete(key);
      this.pumpFetches();
      return;
    }
    this.ready.push({ key, tile });
    this.readyKeys.add(key);
    this.pumpFetches();
  }

  private onFetchFail(key: string, err: unknown): void {
    this.inFlight.delete(key);
    const n = this.attempts.get(key) ?? 0;
    if (n < 2 && this.isWanted(key)) {
      this.startFetch(key);
      this.pumpFetches();
      return;
    }
    if (n >= 2) {
      this.skipped.add(key);
      this.attempts.delete(key);
      console.warn(`TileManager: failed to load tile ${key}`, err);
    } else {
      this.attempts.delete(key);
    }
    this.pumpFetches();
  }
}

/** Numeric `(i, j)` order so `"-1_0"` sorts before `"0_0"`, not lexicographically. */
function compareKeys(a: string, b: string): number {
  const pa = parseKey(a);
  const pb = parseKey(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.i !== pb.i) return pa.i - pb.i;
  return pa.j - pb.j;
}
