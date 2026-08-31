/**
 * Unit tests for src/world/tiles.ts (T-0094). Every case listed in the
 * ticket's acceptance criteria is covered here by name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Building, Road, TileData, TileIndexData, TileStat } from '../src/data/types';
import { TileManager, type TileEvent } from '../src/world/tiles';

const TILE_STAT: TileStat = { buildings: 1, roads: 1, trees: 0, bytes: 10 };

function makeIndex(
  i0: number,
  i1: number,
  j0: number,
  j1: number,
  extra: string[] = [],
): TileIndexData {
  const tiles: Record<string, TileStat> = {};
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      tiles[`${i}_${j}`] = TILE_STAT;
    }
  }
  for (const k of extra) tiles[k] = { buildings: 0, roads: 0, trees: 0, bytes: 1 };
  return {
    v: 1,
    tiled: true,
    origin: { lat: 0, lon: 0 },
    bbox: [0, 0, 1, 1],
    tileSize: 1000,
    bridgeRoads: [],
    landmarks: [],
    places: [],
    tiles,
  };
}

function parseKey(key: string): { i: number; j: number } {
  const [i, j] = key.split('_').map(Number);
  return { i, j };
}

function makeTile(key: string): TileData {
  const { i, j } = parseKey(key);
  const building: Building = {
    id: i * 10_000 + j,
    h: 10,
    name: key,
    poly: [
      [i * 1000 + 10, j * 1000 + 10],
      [i * 1000 + 20, j * 1000 + 10],
      [i * 1000 + 20, j * 1000 + 20],
      [i * 1000 + 10, j * 1000 + 20],
    ],
  };
  const road: Road = {
    id: i * 10_000 + j,
    cls: 'residential',
    pts: [
      [i * 1000, j * 1000],
      [i * 1000 + 50, j * 1000 + 50],
    ],
  };
  return { v: 1, buildings: [building], roads: [road] };
}

function gridKeys(i0: number, i1: number, j0: number, j1: number): string[] {
  const keys: string[] = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) keys.push(`${i}_${j}`);
  }
  return keys;
}

function sortedKeys(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => {
    const pa = parseKey(a);
    const pb = parseKey(b);
    return pa.i - pb.i || pa.j - pb.j;
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function microtasks(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Drive fetches + take() until idle. No timers — only microtask flushing. */
async function drain(mgr: TileManager, x: number, z: number): Promise<void> {
  mgr.update(x, z);
  for (let i = 0; i < 5000; i++) {
    await Promise.resolve();
    const ev = mgr.take();
    if (mgr.pending() === 0) {
      mgr.update(x, z);
      await Promise.resolve();
      const ev2 = mgr.take();
      if (mgr.pending() === 0 && ev.length === 0 && ev2.length === 0) return;
    } else {
      mgr.update(x, z);
    }
  }
  throw new Error(`drain: still pending ${mgr.pending()}`);
}

const INDEX = makeIndex(-6, 6, -6, 6, ['50_50']);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TileManager', () => {
  it('at rest with default radii the wanted set is the 5×5 around the player\'s tile', async () => {
    const requested: string[] = [];
    const loadTile = (key: string): Promise<TileData> => {
      requested.push(key);
      return Promise.resolve(makeTile(key));
    };
    const mgr = new TileManager(INDEX, loadTile);
    await drain(mgr, 500, 500);
    expect(sortedKeys(mgr.loadedKeys())).toEqual(sortedKeys(gridKeys(-2, 2, -2, 2)));
    expect(sortedKeys(requested)).toEqual(sortedKeys(gridKeys(-2, 2, -2, 2)));
    expect(requested).not.toContain('50_50');
    expect(requested).not.toContain('3_0');
    expect(requested).not.toContain('-3_0');
  });

  it('walking to just past a tile boundary and back does NOT unload anything (hysteresis)', async () => {
    const loadTile = (key: string): Promise<TileData> => Promise.resolve(makeTile(key));
    const mgr = new TileManager(INDEX, loadTile);
    await drain(mgr, 500, 500);
    const original = new Set(mgr.loadedKeys());
    expect(original.size).toBe(25);

    mgr.update(1001, 500);
    const crossed = mgr.take();
    expect(crossed.filter((e) => e.kind === 'remove')).toEqual([]);
    for (const k of original) expect(mgr.loadedKeys()).toContain(k);

    mgr.update(500, 500);
    const back = mgr.take();
    expect(back.filter((e) => e.kind === 'remove')).toEqual([]);
    for (const k of original) expect(mgr.loadedKeys()).toContain(k);
  });

  it('the player tile + 8 neighbours survive even with { loadR: 1, unloadR: 2 }', async () => {
    const requested: string[] = [];
    const loadTile = (key: string): Promise<TileData> => {
      requested.push(key);
      return Promise.resolve(makeTile(key));
    };
    const mgr = new TileManager(INDEX, loadTile, { loadR: 1, unloadR: 2 });
    await drain(mgr, 500, 500);
    expect(sortedKeys(mgr.loadedKeys())).toEqual(sortedKeys(gridKeys(-1, 1, -1, 1)));
    expect(sortedKeys(requested)).toEqual(sortedKeys(gridKeys(-1, 1, -1, 1)));
    expect(requested).not.toContain('2_0');
    expect(requested).not.toContain('-2_0');

    mgr.update(501, 500);
    const ev = mgr.take();
    expect(ev.filter((e) => e.kind === 'remove')).toEqual([]);
    expect(sortedKeys(mgr.loadedKeys())).toEqual(sortedKeys(gridKeys(-1, 1, -1, 1)));
  });

  it('fetches are issued nearest-first with never more than 2 unresolved loadTile calls', async () => {
    const unresolved = new Set<string>();
    const order: string[] = [];
    const pending = new Map<string, Deferred<TileData>>();
    const loadTile = (key: string): Promise<TileData> => {
      expect(unresolved.size).toBeLessThan(2);
      unresolved.add(key);
      expect(unresolved.size).toBeLessThanOrEqual(2);
      order.push(key);
      const d = deferred<TileData>();
      pending.set(key, d);
      return d.promise.finally(() => {
        unresolved.delete(key);
      });
    };
    const mgr = new TileManager(INDEX, loadTile);
    mgr.update(500, 500);
    await microtasks();
    expect(order).toHaveLength(2);
    expect(unresolved.size).toBe(2);
    expect(order[0]).toBe('0_0');

    const dist = (key: string): number => {
      const { i, j } = parseKey(key);
      return Math.hypot((i + 0.5) * 1000 - 500, (j + 0.5) * 1000 - 500);
    };
    const wanted = gridKeys(-2, 2, -2, 2);
    const expected = [...wanted].sort((a, b) => dist(a) - dist(b) || (a < b ? -1 : a > b ? 1 : 0));

    while (order.length < 25) {
      const snapshot = [...pending.entries()];
      expect(snapshot.length).toBeGreaterThan(0);
      expect(snapshot.length).toBeLessThanOrEqual(2);
      for (const [key, d] of snapshot) {
        pending.delete(key);
        d.resolve(makeTile(key));
      }
      await microtasks();
      mgr.update(500, 500);
      await microtasks();
    }
    expect(order).toEqual(expected);
    expect(order[1]).toBe('-1_0');
    for (const d of pending.values()) d.resolve(makeTile('unused'));
  });

  it('take() returns at most one add per call while queued builds exist, and removes flush immediately', async () => {
    const pending = new Map<string, Deferred<TileData>>();
    const loadTile = (key: string): Promise<TileData> => {
      const d = deferred<TileData>();
      pending.set(key, d);
      return d.promise;
    };
    const mgr = new TileManager(INDEX, loadTile);
    mgr.update(500, 500);
    await microtasks();
    expect(pending.size).toBe(2);
    for (const [key, d] of pending) {
      pending.delete(key);
      d.resolve(makeTile(key));
    }
    await microtasks();
    // Two fetched, sitting in the ready queue; pump started two more in flight.
    const first = mgr.take();
    expect(first.filter((e) => e.kind === 'add')).toHaveLength(1);
    const second = mgr.take();
    expect(second.filter((e) => e.kind === 'add')).toHaveLength(1);
    const third = mgr.take();
    expect(third.filter((e) => e.kind === 'add')).toHaveLength(0);

    // Two added. Teleport far away: both must drop in a single take(), no drip.
    mgr.update(200_000, 0);
    const flushed = mgr.take();
    const removes = flushed.filter((e): e is TileEvent & { kind: 'remove' } => e.kind === 'remove');
    const adds = flushed.filter((e) => e.kind === 'add');
    expect(removes).toHaveLength(2);
    expect(adds.length).toBeLessThanOrEqual(1);
    expect(sortedKeys(removes.map((e) => e.key))).toEqual(
      sortedKeys([first[0]!.kind === 'add' ? first[0].key : '', second[0]!.kind === 'add' ? second[0].key : '']),
    );
    expect(mgr.loadedKeys()).toHaveLength(adds.length);
  });

  it('a tile is in snapshot()/loadedKeys() only after its add was taken', async () => {
    const d = deferred<TileData>();
    const tile = makeTile('0_0');
    const loadTile = (key: string): Promise<TileData> => {
      expect(key).toBe('0_0');
      return d.promise;
    };
    const one = makeIndex(0, 0, 0, 0);
    const mgr = new TileManager(one, loadTile);
    mgr.update(500, 500);
    await microtasks();
    expect(mgr.loadedKeys()).toEqual([]);
    expect(mgr.snapshot().buildings).toEqual([]);
    expect(mgr.snapshot().roads).toEqual([]);
    expect(mgr.pending()).toBe(1);

    d.resolve(tile);
    await microtasks();
    expect(mgr.loadedKeys()).toEqual([]);
    expect(mgr.snapshot().buildings).toEqual([]);
    expect(mgr.pending()).toBe(1);

    const ev = mgr.take();
    expect(ev).toEqual([{ kind: 'add', key: '0_0', tile }]);
    expect(mgr.loadedKeys()).toEqual(['0_0']);
    expect(mgr.snapshot().buildings).toEqual(tile.buildings);
    expect(mgr.snapshot().roads).toEqual(tile.roads);
    expect(mgr.pending()).toBe(0);
  });

  it('version increments exactly once per added-set change and snapshot() is reference-stable between changes', async () => {
    const pending = new Map<string, Deferred<TileData>>();
    const loadTile = (key: string): Promise<TileData> => {
      const d = deferred<TileData>();
      pending.set(key, d);
      return d.promise;
    };
    const mgr = new TileManager(INDEX, loadTile);
    const s0 = mgr.snapshot();
    expect(s0.version).toBe(0);
    expect(mgr.snapshot()).toBe(s0);

    mgr.update(500, 500);
    await microtasks();
    expect(mgr.snapshot()).toBe(s0);
    expect(mgr.snapshot().version).toBe(0);

    for (const [key, d] of [...pending]) {
      pending.delete(key);
      d.resolve(makeTile(key));
    }
    await microtasks();
    expect(mgr.snapshot()).toBe(s0);

    mgr.take();
    const s1 = mgr.snapshot();
    expect(s1.version).toBe(1);
    expect(s1).not.toBe(s0);
    expect(mgr.snapshot()).toBe(s1);

    mgr.take();
    const s2 = mgr.snapshot();
    expect(s2.version).toBe(2);
    expect(s2).not.toBe(s1);
    expect(mgr.snapshot()).toBe(s2);
  });

  it('a rejected loadTile is retried once, then skipped with a console.warn, pending() returns to 0, and it is not re-requested until it leaves and re-enters the wanted set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const loadTile = (_key: string): Promise<TileData> => {
      n += 1;
      return Promise.reject(new Error('net'));
    };
    const one = makeIndex(0, 0, 0, 0);
    const mgr = new TileManager(one, loadTile);
    mgr.update(500, 500);
    await microtasks(12);
    expect(n).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('0_0');
    expect(mgr.pending()).toBe(0);
    expect(mgr.loadedKeys()).toEqual([]);

    mgr.update(500, 500);
    await microtasks(12);
    expect(n).toBe(2);

    mgr.update(200_000, 0);
    await microtasks();
    mgr.update(500, 500);
    await microtasks(12);
    expect(n).toBe(4);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(mgr.pending()).toBe(0);
  });

  it('keys with negative indices ("-1_0") round-trip through the whole flow', async () => {
    const seen: string[] = [];
    const loadTile = (key: string): Promise<TileData> => {
      seen.push(key);
      return Promise.resolve(makeTile(key));
    };
    const mgr = new TileManager(INDEX, loadTile);
    await drain(mgr, -500, 500);
    expect(seen).toContain('-1_0');
    expect(mgr.loadedKeys()).toContain('-1_0');
    const snap = mgr.snapshot();
    expect(snap.buildings.some((b) => b.name === '-1_0')).toBe(true);
    expect(snap.roads.some((r) => r.id === -1 * 10_000 + 0)).toBe(true);

    const add = mgr.take();
    expect(add.filter((e) => e.kind === 'add' && e.key === '-1_0')).toEqual([]);

    mgr.update(200_000, 0);
    const ev = mgr.take();
    expect(ev.some((e) => e.kind === 'remove' && e.key === '-1_0')).toBe(true);
    expect(mgr.loadedKeys()).not.toContain('-1_0');
    expect(mgr.snapshot().buildings.some((b) => b.name === '-1_0')).toBe(false);
  });

  it('tiles listed in the index but absent from the wanted circle are never fetched', async () => {
    const requested: string[] = [];
    const loadTile = (key: string): Promise<TileData> => {
      requested.push(key);
      return Promise.resolve(makeTile(key));
    };
    const mgr = new TileManager(INDEX, loadTile);
    await drain(mgr, 500, 500);
    expect(requested).not.toContain('50_50');
    expect(requested).not.toContain('6_6');
    expect(requested).not.toContain('-6_-6');
    expect(requested.every((k) => {
      const { i, j } = parseKey(k);
      return Math.abs(i) <= 2 && Math.abs(j) <= 2;
    })).toBe(true);
  });

  it('20 alternating update() calls 1 m either side of a tile boundary produce ≤ 2 version changes (hysteresis)', async () => {
    // Single index row `i_0` (1000 m tiles); the x = 1000 boundary between
    // tile 0 and tile 1 is straddled at x = 999 / 1001. Narrow load square +
    // wide unload band mirror the real 1.3 hysteresis ratio (loadR/unloadR).
    const row = makeIndex(0, 4, 0, 0);
    const loadTile = (key: string): Promise<TileData> => Promise.resolve(makeTile(key));
    const mgr = new TileManager(row, loadTile, { loadR: 100, unloadR: 1500 });

    // Drain on the west side: only tiles 0_0 and 1_0 are wanted/loaded.
    await drain(mgr, 999, 500);
    expect(sortedKeys(mgr.loadedKeys())).toEqual(sortedKeys(['0_0', '1_0']));

    const v0 = mgr.snapshot().version;
    let changes = 0;
    let droppedHysteresis = 0;
    for (let k = 0; k < 20; k++) {
      // 1 m either side of the x = 1000 tile boundary.
      const x = k % 2 === 0 ? 1001 : 999;
      mgr.update(x, 500);
      await microtasks(6);
      const events = mgr.take();
      if (events.length > 0) changes += 1;
      // `2_0` becomes wanted only on the east side; on the west side it is
      // kept solely by the hysteresis band — it must never be dropped and
      // re-fetched while we oscillate across the boundary.
      if (events.some((e) => e.kind === 'remove' && e.key === '2_0')) droppedHysteresis += 1;
    }
    // Without the hysteresis band this would re-add / re-drop `2_0` on every
    // toggle (≫ 2 version bumps). With it, the east neighbour loads once and
    // stays resident: at most one add's worth of version movement.
    expect(changes).toBeLessThanOrEqual(2);
    expect(droppedHysteresis).toBe(0);
    expect(mgr.loadedKeys()).toContain('2_0');
    expect(mgr.snapshot().version - v0).toBeLessThanOrEqual(2);
  });

  it('fetch-storm: never-resolving loadTile while crossing many tiles keeps unresolved calls ≤ 2 and take() well-behaved', async () => {
    // Every fetch hangs forever — simulates a stuck/slow tile request while
    // the player keeps moving so the wanted set keeps changing.
    const unresolved = new Set<string>();
    const loadTile = (key: string): Promise<TileData> => {
      unresolved.add(key);
      return new Promise<TileData>(() => {});
    };
    // A long single-row index so the wanted set changes as x sweeps east.
    const row = makeIndex(0, 40, 0, 0);
    const mgr = new TileManager(row, loadTile, { loadR: 50, unloadR: 60 });

    let maxUnresolved = 0;
    let addsSeen = 0;
    // Cross ~6.4 km (~6 tile widths) in 100 m steps; nothing ever resolves.
    for (let step = 0; step < 64; step++) {
      const x = 500 + step * 100;
      mgr.update(x, 500);
      await microtasks(6);
      const events = mgr.take();
      // take() stays well-behaved: no adds (nothing resolved), no removes
      // (nothing was ever added), and it never throws under the storm.
      expect(events.filter((e) => e.kind === 'add')).toHaveLength(0);
      addsSeen += events.filter((e) => e.kind === 'add').length;
      maxUnresolved = Math.max(maxUnresolved, unresolved.size);
      expect(unresolved.size).toBeLessThanOrEqual(2);
      expect(mgr.pending()).toBeLessThanOrEqual(2);
    }
    // The storm actually started (fetches were issued) and the scheduler kept
    // the unresolved call count glued to MAX_IN_FLIGHT = 2 for the whole crossing.
    expect(maxUnresolved).toBe(2);
    expect(unresolved.size).toBeLessThanOrEqual(2);
    expect(mgr.pending()).toBeLessThanOrEqual(2);
    expect(addsSeen).toBe(0);
  });
});
