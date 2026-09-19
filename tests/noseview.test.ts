/**
 * NOSEVIEW skin pure formatters and airspeed derivative (T-0150,
 * docs/architecture.md §4.11 "retrocgi" HUD skin). The `Noseview` DOM class
 * is browser-only and is not imported here; we import only the pure
 * functions from the module (which pulls in its CSS the same way
 * `tests/hud.test.ts` imports `../src/hud/hud`).
 */
import { describe, expect, it } from 'vitest';
import { formatNvAir, formatNvAlt, nvSpeed } from '../src/hud/noseview';

describe('formatNvAlt', () => {
  it('rounds to nearest metre: 533.4 → "533", 533.5 → "534"', () => {
    expect(formatNvAlt(533.4)).toBe('533');
    expect(formatNvAlt(533.5)).toBe('534');
  });

  it('clamps negatives and zero to "0"', () => {
    expect(formatNvAlt(-3)).toBe('0');
    expect(formatNvAlt(0)).toBe('0');
  });
});

describe('formatNvAir', () => {
  it('knots conversion: 36 m/s → "70", 0 → "0"', () => {
    expect(formatNvAir(36)).toBe('70');
    expect(formatNvAir(0)).toBe('0');
  });
});

describe('nvSpeed', () => {
  it('returns 0 on the first update (prev undefined)', () => {
    expect(nvSpeed(undefined, { x: 10, z: 0, timeS: 0.5 })).toBe(0);
  });

  it('10 m along x in 0.5 s → 20; 3 m x + 4 m z in 1 s → 5', () => {
    expect(nvSpeed({ x: 0, z: 0, timeS: 0 }, { x: 10, z: 0, timeS: 0.5 })).toBe(
      20,
    );
    expect(nvSpeed({ x: 0, z: 0, timeS: 0 }, { x: 3, z: 4, timeS: 1 })).toBe(5);
  });

  it('returns 0 when dt is 0, 2, or negative', () => {
    const prev = { x: 0, z: 0, timeS: 0 };
    expect(nvSpeed(prev, { x: 10, z: 0, timeS: 0 })).toBe(0);
    expect(nvSpeed(prev, { x: 10, z: 0, timeS: 2 })).toBe(0);
    expect(nvSpeed(prev, { x: 10, z: 0, timeS: -1 })).toBe(0);
  });
});
