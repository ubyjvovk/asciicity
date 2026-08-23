/**
 * Unit tests for the WGS84 → local-metre projection (`src/geo.ts`).
 */
import { describe, expect, it } from 'vitest';
import { M_PER_DEG_LAT, project, unproject } from '../src/geo';

const ORIGIN = { lat: 51.5133, lon: -0.0887 };

describe('project', () => {
  it('projects the origin to [0, 0]', () => {
    const [x, z] = project(ORIGIN.lon, ORIGIN.lat, ORIGIN);
    expect(x).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
  });

  it('maps a point 0.01 degrees north of origin to z ≈ −1105.74 and x ≈ 0', () => {
    const [x, z] = project(ORIGIN.lon, ORIGIN.lat + 0.01, ORIGIN);
    expect(z).toBeCloseTo(-0.01 * M_PER_DEG_LAT, 6);
    expect(z).toBeCloseTo(-1105.74, 2);
    expect(x).toBeCloseTo(0, 6);
  });

  it('maps a point east of the origin to x > 0', () => {
    const [x, z] = project(ORIGIN.lon + 0.01, ORIGIN.lat, ORIGIN);
    expect(x).toBeGreaterThan(0);
    expect(z).toBeCloseTo(0, 6);
  });

  it('round-trips through unproject within 1e-9 degrees', () => {
    const lon = ORIGIN.lon + 0.0213;
    const lat = ORIGIN.lat - 0.0177;
    const [x, z] = project(lon, lat, ORIGIN);
    const back = unproject(x, z, ORIGIN);
    expect(back.lon).toBeCloseTo(lon, 9);
    expect(back.lat).toBeCloseTo(lat, 9);
  });

  it('returns unrounded numbers (rounding is left to callers)', () => {
    const [x] = project(ORIGIN.lon + 0.01, ORIGIN.lat, ORIGIN);
    const expected =
      0.01 * Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320;
    expect(x).toBeCloseTo(expected, 12);
    expect(x).not.toBe(Math.round(x * 10) / 10);
  });
});
