/**
 * Minimap projection and cell lookup (T-0014). The canvas `Minimap` class is
 * browser-only (imports CSS) and is not exercised here.
 */
import { describe, expect, it } from 'vitest';
import { nearbyCells, worldToMinimap, type MinimapOptions } from '../src/hud/minimap';

const opts: MinimapOptions = { size: 200, radius: 100, headingUp: true };
const origin = { x: 0, z: 0, yaw: 0 };

describe('worldToMinimap', () => {
  it('player at origin yaw 0 maps world (0, −100) (north) to [100, 0]', () => {
    const [x, y] = worldToMinimap(0, -100, origin, opts);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(0);
  });

  it('yaw π/2 maps (100, 0) (east) to [100, 0]', () => {
    const [x, y] = worldToMinimap(100, 0, { x: 0, z: 0, yaw: Math.PI / 2 }, opts);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(0);
  });

  it('headingUp: false maps (100, 0) to [200, 100]', () => {
    const [x, y] = worldToMinimap(100, 0, origin, { ...opts, headingUp: false });
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(100);
  });

  it("the player's own position maps to [100, 100] for any yaw", () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3, 4]) {
      const [x, y] = worldToMinimap(10, -20, { x: 10, z: -20, yaw }, opts);
      expect(x).toBeCloseTo(100);
      expect(y).toBeCloseTo(100);
    }
  });

  it('a point at 2×radius lands outside [0, size]', () => {
    const [x, y] = worldToMinimap(0, -200, origin, opts);
    expect(x < 0 || x > opts.size || y < 0 || y > opts.size).toBe(true);
  });
});

describe('nearbyCells', () => {
  it('returns 9 keys for radius 100 / cell 100 at the origin', () => {
    const keys = nearbyCells(0, 0, 100, 100).sort();
    expect(keys).toEqual([
      '-1,-1',
      '-1,0',
      '-1,1',
      '0,-1',
      '0,0',
      '0,1',
      '1,-1',
      '1,0',
      '1,1',
    ]);
  });

  it('1 key for radius 10 inside a cell', () => {
    const keys = nearbyCells(50, 50, 10, 100);
    expect(keys).toEqual(['0,0']);
  });
});
