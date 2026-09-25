/**
 * Cyberpunk streets v2 maths (T-0153, src/render/punk/streetmath.ts): the
 * locked puddle mask's coverage and blob-ness, and the asphalt albedo band.
 * Pure node tests against the JS noise mirrors — no WebGPU.
 */
import { describe, it, expect } from 'vitest';
import { puddleAt, asphaltAlbedo, ASPHALT_MIN, ASPHALT_MAX } from '../src/render/punk/streetmath';

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
