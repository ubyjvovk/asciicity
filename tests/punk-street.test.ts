/**
 * Cyberpunk streets v2 maths (T-0153, src/render/punk/streetmath.ts): the
 * locked puddle mask's coverage and blob-ness, and the asphalt albedo band.
 * Pure node tests against the JS noise mirrors — no WebGPU.
 */
import { describe, it, expect } from 'vitest';
import {
  puddleAt,
  asphaltAlbedo,
  rippleFade,
  distanceRoughness,
  RIPPLE_FADE_NEAR,
  RIPPLE_FADE_FAR,
  ROUGH_FADE_NEAR,
  ROUGH_FADE_FAR,
  ROUGH_FLOOR,
  ASPHALT_MIN,
  ASPHALT_MAX,
} from '../src/render/punk/streetmath';

/** Fraction of a 0.5 m-step grid at `ox,oz` where `puddleAt > 0.5`. */
function puddleCoverage(ox: number, oz: number, size = 200): number {
  let n = 0;
  let p = 0;
  for (let x = ox; x < ox + size; x += 0.5) {
    for (let z = oz; z < oz + size; z += 0.5) {
      n++;
      if (puddleAt(x, z) > 0.5) p++;
    }
  }
  return p / n;
}

/** Mean length of runs of consecutive `true` samples in a 1-D boolean sequence. */
function meanRunLength(vals: boolean[]): number {
  let total = 0;
  let runs = 0;
  let cur = 0;
  for (const v of vals) {
    if (v) {
      cur++;
    } else if (cur > 0) {
      total += cur;
      runs++;
      cur = 0;
    }
  }
  if (cur > 0) {
    total += cur;
    runs++;
  }
  return runs === 0 ? 0 : total / runs;
}

describe('puddleAt — locked puddle mask', () => {
  it('is in [0, 1] and deterministic', () => {
    for (let i = 0; i < 2000; i++) {
      const x = (i * 13.37) % 500 - 250;
      const z = (i * 7.19) % 500 - 250;
      const v = puddleAt(x, z);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(puddleAt(x, z)).toBe(v); // deterministic
    }
  });

  it('covers 25–35 % of road area (mean of three windows), each within 0.20–0.40', () => {
    const c0 = puddleCoverage(0, 0);
    const c1 = puddleCoverage(1000, -700);
    const c2 = puddleCoverage(-3000, 2500);
    const mean = (c0 + c1 + c2) / 3;
    expect(mean).toBeGreaterThanOrEqual(0.25);
    expect(mean).toBeLessThanOrEqual(0.35);
    for (const c of [c0, c1, c2]) {
      expect(c).toBeGreaterThanOrEqual(0.2);
      expect(c).toBeLessThanOrEqual(0.4);
    }
  });

  it('forms blobs, not speckle: mean run length along x ≥ 6 samples (0.5 m steps)', () => {
    const runLengths: number[] = [];
    for (let zi = 0; zi < 8; zi++) {
      const z = zi * 37.3;
      const vals: boolean[] = [];
      for (let x = 0; x < 400; x += 0.5) vals.push(puddleAt(x, z) > 0.5);
      runLengths.push(meanRunLength(vals));
    }
    const overall = runLengths.reduce((a, b) => a + b, 0) / runLengths.length;
    expect(overall).toBeGreaterThanOrEqual(6);
  });
});

describe('asphaltAlbedo — dry asphalt band', () => {
  it('stays within [0.035, 0.06] everywhere sampled', () => {
    for (let i = 0; i < 5000; i++) {
      const x = (i * 29.7) % 1000 - 500;
      const z = (i * 11.3) % 1000 - 500;
      const a = asphaltAlbedo(x, z);
      expect(a).toBeGreaterThanOrEqual(ASPHALT_MIN);
      expect(a).toBeLessThanOrEqual(ASPHALT_MAX);
    }
  });

  it('varies (grain + patch) rather than being a flat grey', () => {
    const vals = new Set<number>();
    for (let i = 0; i < 500; i++) vals.add(asphaltAlbedo(i * 0.5, i * 0.5));
    expect(vals.size).toBeGreaterThan(50);
  });
});

describe('rippleFade — specular anti-aliasing distance fade', () => {
  it('is 1 at d ≤ 12 and 0 at d ≥ 45', () => {
    expect(rippleFade(0)).toBe(1);
    expect(rippleFade(RIPPLE_FADE_NEAR)).toBe(1);
    expect(rippleFade(12)).toBe(1);
    expect(rippleFade(RIPPLE_FADE_FAR)).toBe(0);
    expect(rippleFade(45)).toBe(0);
    expect(rippleFade(200)).toBe(0);
  });

  it('is monotone non-increasing and stays in [0, 1]', () => {
    let prev = rippleFade(0);
    for (let d = 0; d <= 60; d += 0.5) {
      const f = rippleFade(d);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
  });
});

describe('distanceRoughness — puddle/water roughness vs distance', () => {
  it('leaves roughness unchanged at d ≤ 20', () => {
    for (const r of [0.03, 0.1, 0.35, 0.6]) {
      expect(distanceRoughness(r, 0)).toBeCloseTo(r);
      expect(distanceRoughness(r, ROUGH_FADE_NEAR)).toBeCloseTo(r);
    }
  });

  it('reaches ≥ ROUGH_FLOOR by d ≥ 80 for mirror-smooth surfaces (r < 0.35)', () => {
    for (const r of [0.0, 0.03, 0.1, 0.2, 0.34]) {
      const out = distanceRoughness(r, ROUGH_FADE_FAR);
      expect(out).toBeGreaterThanOrEqual(ROUGH_FLOOR);
      expect(out).toBeGreaterThanOrEqual(0.35);
      // For r < 0.35 the far-end value is exactly ROUGH_FLOOR.
      expect(out).toBeCloseTo(ROUGH_FLOOR);
    }
  });

  it('never lowers roughness and converges monotonically', () => {
    for (const r of [0.03, 0.2, 0.4, 0.7]) {
      let prev = distanceRoughness(r, 0);
      for (let d = 0; d <= 120; d += 2) {
        const out = distanceRoughness(r, d);
        expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(out).toBeGreaterThanOrEqual(r - 1e-9);
        prev = out;
      }
    }
  });
});
