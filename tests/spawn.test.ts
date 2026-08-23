/**
 * Unit tests for spawn presets and `?at=` resolution (`src/data/spawn.ts`).
 */
import { describe, expect, it } from 'vitest';
import { parseAt, resolveSpawn, SPAWN_PRESETS } from '../src/data/spawn';
import { project } from '../src/geo';

// Bank preset doublets as the test origin (matches SPAWN_PRESETS.bank).
const ORIGIN = { lat: 51.5133, lon: -0.0887 };

describe('parseAt', () => {
  it('returns null for a null input', () => {
    expect(parseAt(null)).toBeNull();
  });

  it('returns null for an empty / whitespace input', () => {
    expect(parseAt('')).toBeNull();
    expect(parseAt('   ')).toBeNull();
  });

  it('returns the preset key for a matching name, case-insensitive and trimmed', () => {
    expect(parseAt('Gherkin ')).toEqual({ preset: 'gherkin' });
    expect(parseAt('  BANK')).toEqual({ preset: 'bank' });
  });

  it('returns the numeric coordinates for lon,lat,bearing', () => {
    expect(parseAt('-0.0984,51.5138,90')).toEqual({
      lon: -0.0984,
      lat: 51.5138,
      bearingDeg: 90,
    });
  });

  it('returns coordinates without bearing (bearing optional)', () => {
    expect(parseAt('-0.0984,51.5138')).toEqual({
      lon: -0.0984,
      lat: 51.5138,
    });
  });

  it('returns null for a bad coordinate value', () => {
    expect(parseAt('-0.0984,abc')).toBeNull();
  });

  it('returns null for an unknown name or wrong arity', () => {
    expect(parseAt('nope')).toBeNull();
    expect(parseAt('-0.0984')).toBeNull();
    expect(parseAt('1,2,3,4')).toBeNull();
  });
});

describe('resolveSpawn', () => {
  it('defaults to the bank preset at the origin with yaw −π/2', () => {
    const spawn = resolveSpawn(null, ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(0, 6);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('resolves a named preset to its projected point with the preset yaw', () => {
    const spawn = resolveSpawn('gherkin', ORIGIN, () => false);
    const [ex, ez] = project(-0.08, 51.5132, ORIGIN);
    expect(spawn.x).toBeCloseTo(ex, 6);
    expect(spawn.z).toBeCloseTo(ez, 6);
    expect(Math.hypot(spawn.x - ex, spawn.z - ez)).toBeLessThan(5);
    expect(spawn.yaw).toBeCloseTo(0, 6);
  });

  it('resolves explicit coordinates with a bearing', () => {
    const spawn = resolveSpawn('-0.0984,51.5138,90', ORIGIN, () => false);
    const [ex, ez] = project(-0.0984, 51.5138, ORIGIN);
    expect(spawn.x).toBeCloseTo(ex, 6);
    expect(spawn.z).toBeCloseTo(ez, 6);
    expect(spawn.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('walks +x when the spawn point is blocked, stopping at the first free cell', () => {
    // blocked true for x < 3 → the first free step is x = 3.
    const spawn = resolveSpawn(null, ORIGIN, (p) => p[0] < 3);
    expect(spawn.x).toBe(3);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('returns the original point when blocked for the whole 200 m search', () => {
    const spawn = resolveSpawn(null, ORIGIN, () => true);
    expect(spawn.x).toBeCloseTo(0, 6);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('exposes presets with lower-case keys and labels', () => {
    expect(Object.keys(SPAWN_PRESETS).sort()).toEqual([
      'bank',
      'barbican',
      'gherkin',
      'leadenhall',
      'liverpoolst',
      'monument',
      'stpauls',
      'tower',
    ]);
    expect(SPAWN_PRESETS.gherkin.label).toBe('St Mary Axe, facing the Gherkin');
  });
});
