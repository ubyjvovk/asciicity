/**
 * Unit tests for tiled load helpers (`parseTileData`, `dueRebuild`,
 * `parseTileRadius`) in `src/data/load.ts`.
 */
import { describe, expect, it } from 'vitest';
import { dueRebuild, parseTileData, parseTileRadius } from '../src/data/load';

describe('dueRebuild', () => {
  it('the ≤ 1/s rebuild throttle (pure helper, fake clock)', () => {
    const state = { version: -1, at: Number.NEGATIVE_INFINITY };
    expect(dueRebuild(1, state, 0)).toBe(true);
    expect(state).toEqual({ version: 1, at: 0 });
    // Same version — never rebuilds.
    expect(dueRebuild(1, state, 5_000)).toBe(false);
    // Version changed but inside the 1 s window.
    expect(dueRebuild(2, state, 500)).toBe(false);
    expect(state.version).toBe(1);
    // Window elapsed — consume version 2.
    expect(dueRebuild(2, state, 1_000)).toBe(true);
    expect(state).toEqual({ version: 2, at: 1_000 });
    // Intermediate versions inside the window are skipped; the next fire
    // rebuilds to the latest.
    expect(dueRebuild(3, state, 1_400)).toBe(false);
    expect(dueRebuild(4, state, 1_400)).toBe(false);
    expect(dueRebuild(4, state, 2_000)).toBe(true);
    expect(state).toEqual({ version: 4, at: 2_000 });
  });
});

describe('parseTileRadius', () => {
  it('maps m to { loadR: m, unloadR: 1.3·m }', () => {
    expect(parseTileRadius('?tileradius=600')).toEqual({ loadR: 600, unloadR: 780 });
    expect(parseTileRadius('tileradius=500')).toEqual({ loadR: 500, unloadR: 650 });
  });

  it('returns undefined for missing / non-positive values', () => {
    expect(parseTileRadius('')).toBeUndefined();
    expect(parseTileRadius('?city=sf')).toBeUndefined();
    expect(parseTileRadius('?tileradius=0')).toBeUndefined();
    expect(parseTileRadius('?tileradius=-1')).toBeUndefined();
    expect(parseTileRadius('?tileradius=nope')).toBeUndefined();
  });
});

describe('parseTileData', () => {
  it('accepts v=1 with buildings and roads arrays', () => {
    const tile = parseTileData({ v: 1, buildings: [], roads: [] });
    expect(tile.buildings).toEqual([]);
    expect(tile.roads).toEqual([]);
  });

  it('rejects a payload without v=1 or arrays', () => {
    expect(() => parseTileData(null)).toThrow(/tile/);
    expect(() => parseTileData({ v: 2, buildings: [], roads: [] })).toThrow(/v/);
    expect(() => parseTileData({ v: 1, roads: [] })).toThrow(/buildings/);
  });
});
