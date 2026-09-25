/**
 * Cyberpunk atmosphere maths (wave 20b): the pure mirror `punk/fogmath.ts`.
 * The TSL graph in `atmosphere.ts` is GPU-verified by the e2e + PM review;
 * the analytic integral and its continuity are unit-tested here by name.
 */
import { describe, it, expect } from 'vitest';
import {
  H,
  MIST_H,
  MIST_MAX,
  RHO0_BASE,
  heightFogDensity,
  heightFogTransmittance,
  mistOpacity,
} from '../src/render/punk/fogmath';

const rho0 = RHO0_BASE * 0.8; // neonNoir fogAmount
const y0 = 0;

describe('heightFogDensity', () => {
  it('decays exponentially with height above y0', () => {
    expect(heightFogDensity(y0, rho0, H, y0)).toBeCloseTo(rho0);
    expect(heightFogDensity(y0 + H, rho0, H, y0)).toBeCloseTo(rho0 * Math.exp(-1));
  });
});

describe('heightFogTransmittance', () => {
  it('of a horizontal ray equals exp(−ρ(y)·d)', () => {
    const camY = y0 + 2;
    const dist = 100;
    const t = heightFogTransmittance(camY, camY, dist, rho0, H, y0);
    const rhoY = heightFogDensity(camY, rho0, H, y0);
    expect(t).toBeCloseTo(Math.exp(-rhoY * dist), 6);
  });

  it('is symmetric: T(camY→pY) = T(pY→camY) for the same distance', () => {
    const camY = y0 + 1.5;
    const pY = y0 + 8;
    const dist = 120;
    const a = heightFogTransmittance(camY, pY, dist, rho0, H, y0);
    const b = heightFogTransmittance(pY, camY, dist, rho0, H, y0);
    expect(a).toBeCloseTo(b, 12);
  });

  it('is monotone non-increasing in distance and in (0, 1]', () => {
    const camY = y0 + 2;
    const pY = y0 + 6;
    let prev = 1;
    for (const d of [10, 40, 80, 120, 200, 400]) {
      const t = heightFogTransmittance(camY, pY, d, rho0, H, y0);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(prev + 1e-9);
      prev = t;
    }
  });

  it('a ray climbing 100 m keeps more transmittance than the horizontal ray of the same length at y0', () => {
    const dist = 200;
    const climb = heightFogTransmittance(y0, y0 + 100, dist, rho0, H, y0);
    const flat = heightFogTransmittance(y0, y0, dist, rho0, H, y0);
    expect(climb).toBeGreaterThan(flat);
  });

  it('floor case: 300 m horizontal at y0 + 10 m with neonNoir keeps ≥ 0.35', () => {
    const camY = y0 + 10;
    const t = heightFogTransmittance(camY, camY, 300, rho0, H, y0);
    expect(t).toBeGreaterThanOrEqual(0.35);
    // PM reference: T ≈ 0.44 for this window.
    expect(t).toBeCloseTo(0.4375, 2);
  });

  it('the horizontal limit is continuous for small camY→pY deltas', () => {
    const camY = y0 + 2;
    const dist = 100;
    const exact = heightFogTransmittance(camY, camY, dist, rho0, H, y0);
    const near = heightFogTransmittance(camY, camY + 1e-4, dist, rho0, H, y0);
    expect(Math.abs(near - exact)).toBeLessThan(1e-6);
  });
});

describe('mistOpacity', () => {
  it('is 0 above y0 + MIST_H', () => {
    expect(mistOpacity(y0 + MIST_H, y0, 0.9)).toBe(0);
    expect(mistOpacity(y0 + 5, y0, 0.9)).toBe(0);
  });

  it('is ≤ 0.25 everywhere', () => {
    for (const dy of [-1, 0, 0.5, 1.2, 2.0, 2.49]) {
      for (const n of [0, 0.1, 0.5, 0.99]) {
        const o = mistOpacity(y0 + dy, y0, n);
        expect(o).toBeLessThanOrEqual(MIST_MAX);
        expect(o).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('peaks at MIST_MAX at y0 with full noise and scales with it', () => {
    expect(mistOpacity(y0, y0, 1)).toBeCloseTo(MIST_MAX);
    expect(mistOpacity(y0, y0, 0.5)).toBeCloseTo(MIST_MAX * 0.5);
    expect(mistOpacity(y0, y0, 0)).toBe(0);
  });
});
