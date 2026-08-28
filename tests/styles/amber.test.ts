/**
 * Unit tests for the pure amber-theme helpers (docs/architecture.md §4.11
 * "`amber` (wave 8)"): `amberDensity` and `amberMix`. Runs in node; no WebGL
 * is touched. Does not import or mutate `themeMix`.
 */
import { describe, expect, it } from 'vitest';
import { amberDensity, amberMix } from '../../src/render/styles/ascii';

describe('amberDensity', () => {
  it('amberDensity(0.06, 0.45) === 0', () => {
    expect(amberDensity(0.06, 0.45)).toBe(0);
  });

  it('amberDensity(1, 0.45) === 1', () => {
    expect(amberDensity(1, 0.45)).toBe(1);
  });

  it('strictly monotone on a grid', () => {
    const gamma = 0.45;
    let prev = amberDensity(0, gamma);
    expect(prev).toBe(0);
    for (let i = 1; i <= 100; i++) {
      const v = i / 100;
      const cur = amberDensity(v, gamma);
      if (v <= 0.06) {
        expect(cur).toBe(0);
      } else {
        expect(cur).toBeGreaterThan(prev);
      }
      prev = cur;
    }
  });

  it('matches pow((v − 0.06)/0.94, 0.675) at v = 0.5', () => {
    const expected = Math.pow((0.5 - 0.06) / 0.94, 0.675);
    expect(amberDensity(0.5, 0.45)).toBeCloseTo(expected, 10);
  });
});

describe('amberMix', () => {
  it('grey rawTint [1,1,1], v 0.5, mask 1 → r > g > b (amber order)', () => {
    const [r, g, b] = amberMix([1, 1, 1], 0.5, 1, 0.45);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('green rawTint [0.3,1,0.3] → g ≥ r (olive)', () => {
    const [r, g] = amberMix([0.3, 1, 0.3], 0.5, 1, 0.45);
    expect(g).toBeGreaterThanOrEqual(r);
  });

  it('v = 1 → every channel ≥ 0.5 (bloom)', () => {
    const rgb = amberMix([1, 1, 1], 1, 1, 0.45);
    expect(rgb[0]).toBeGreaterThanOrEqual(0.5);
    expect(rgb[1]).toBeGreaterThanOrEqual(0.5);
    expect(rgb[2]).toBeGreaterThanOrEqual(0.5);
    const olive = amberMix([0.3, 1, 0.3], 1, 1, 0.45);
    expect(olive[0]).toBeGreaterThanOrEqual(0.5);
    expect(olive[1]).toBeGreaterThanOrEqual(0.5);
    expect(olive[2]).toBeGreaterThanOrEqual(0.5);
  });

  it('mask 0 → [0,0,0]', () => {
    expect(amberMix([1, 1, 1], 0.5, 0, 0.45)).toEqual([0, 0, 0]);
    expect(amberMix([0.3, 1, 0.3], 1, 0, 0.45)).toEqual([0, 0, 0]);
  });
});
