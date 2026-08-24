/**
 * Unit tests for spawn presets and `?at=` resolution (`src/data/spawn.ts`).
 */
import { describe, expect, it } from 'vitest';
import { parseAt, resolveSpawn, SPAWN_PRESETS } from '../src/data/spawn';
import { project } from '../src/geo';

// Bank preset doublets as the test origin (matches SPAWN_PRESETS.bank).
const ORIGIN = { lat: 51.5133, lon: -0.0887 };

/** Wrap `a` into `(−π, π]` to compare against the resolver's yaw output. */
function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

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

  it('parses each Westminster preset key', () => {
    expect(parseAt('bigben')).toEqual({ preset: 'bigben' });
    expect(parseAt('parliament')).toEqual({ preset: 'parliament' });
    expect(parseAt('trafalgar')).toEqual({ preset: 'trafalgar' });
    expect(parseAt('embankment')).toEqual({ preset: 'embankment' });
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
  it('defaults to the bigben preset on Westminster Bridge with yaw 268°', () => {
    const [ex, ez] = project(-0.12235, 51.50085, ORIGIN);
    const spawn = resolveSpawn(null, ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(ex, 6);
    expect(spawn.z).toBeCloseTo(ez, 6);
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((268 * Math.PI) / 180), 6);
  });

  it('defaults to bigben for an empty or unknown param', () => {
    const [ex, ez] = project(-0.12235, 51.50085, ORIGIN);
    for (const param of ['', 'nowhere']) {
      const spawn = resolveSpawn(param, ORIGIN, () => false);
      expect(spawn.x).toBeCloseTo(ex, 6);
      expect(spawn.z).toBeCloseTo(ez, 6);
      expect(spawn.yaw).toBeCloseTo(
        normalizeAngle((268 * Math.PI) / 180),
        6,
      );
    }
  });

  it('resolves the bigben preset to its projected point with the preset yaw', () => {
    const spawn = resolveSpawn('bigben', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.12235, 51.50085, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.12235, 51.50085, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((268 * Math.PI) / 180), 6);
  });

  it('resolves the parliament preset to its projected point with yaw 90°', () => {
    const spawn = resolveSpawn('parliament', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.12655, 51.5006, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.12655, 51.5006, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(Math.PI / 2, 6);
  });

  it('resolves the trafalgar preset to its projected point with yaw 180°', () => {
    const spawn = resolveSpawn('trafalgar', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.128, 51.5079, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.128, 51.5079, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(Math.PI, 6);
  });

  it('resolves the embankment preset to its projected point with yaw 120°', () => {
    const spawn = resolveSpawn('embankment', ORIGIN, () => false);
    expect(spawn.x).toBeCloseTo(
      project(-0.122, 51.5074, ORIGIN)[0],
      6,
    );
    expect(spawn.z).toBeCloseTo(
      project(-0.122, 51.5074, ORIGIN)[1],
      6,
    );
    expect(spawn.yaw).toBeCloseTo(normalizeAngle((120 * Math.PI) / 180), 6);
  });

  it('still resolves the bank preset to the origin with yaw −π/2', () => {
    const spawn = resolveSpawn('bank', ORIGIN, () => false);
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
    // Uses `bank` so the search starts at x0 = 0; blocked true for x < 3 →
    // the first free step is x = 3.
    const spawn = resolveSpawn('bank', ORIGIN, (p) => p[0] < 3);
    expect(spawn.x).toBe(3);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('returns the original point when blocked for the whole 200 m search', () => {
    const spawn = resolveSpawn('bank', ORIGIN, () => true);
    expect(spawn.x).toBeCloseTo(0, 6);
    expect(spawn.z).toBeCloseTo(0, 6);
    expect(spawn.yaw).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('exposes presets with lower-case keys and labels', () => {
    expect(Object.keys(SPAWN_PRESETS).sort()).toEqual([
      'bank',
      'barbican',
      'bigben',
      'embankment',
      'gherkin',
      'leadenhall',
      'liverpoolst',
      'monument',
      'parliament',
      'stpauls',
      'tower',
      'trafalgar',
    ]);
    expect(SPAWN_PRESETS.gherkin.label).toBe('St Mary Axe, facing the Gherkin');
  });
});
