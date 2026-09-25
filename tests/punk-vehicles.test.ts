/**
 * Cyberpunk vehicles (wave 23c, T-0170, src/render/punk/vehiclemath.ts):
 * model pick, LODs, normalisation, light anchors and the car manifest.
 * Pure — no three/webgpu.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LIGHT_X_FRAC,
  LIGHT_Y_FRAC,
  LOD_HIDDEN,
  lightAnchors,
  lodFor,
  normalisePoint,
  normaliseTransform,
  parseManifest,
  pickModel,
  rotatedBox,
  type Box3Like,
} from '../src/render/punk/vehiclemath';

const CARS = join(__dirname, '..', 'public', 'models', 'cars');
const manifest = parseManifest(JSON.parse(readFileSync(join(CARS, 'manifest.json'), 'utf8')) as unknown);

/** The bbox of `box`'s 8 corners after normalisation. */
function normalisedBox(box: Box3Like, yaw: number, length: number): Box3Like {
  const t = normaliseTransform(box, yaw, length);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const p = normalisePoint([x, y, z], yaw, t);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
  return { min, max };
}

describe('punk vehicles', () => {
  it('1. pickModel is deterministic and matches the manifest weights within ±3 % over 20 000 cars', () => {
    const weights = manifest.models.map((m) => m.weight);
    const total = weights.reduce((a, b) => a + b, 0);
    const counts = new Array<number>(weights.length).fill(0);
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      const k = pickModel(i, weights);
      expect(pickModel(i, weights)).toBe(k);
      counts[k]++;
    }
    for (let k = 0; k < weights.length; k++) {
      const expected = weights[k] / total;
      const got = counts[k] / N;
      // ±3 % of the model's own share (relative) — stricter than ±3 points.
      expect(Math.abs(got - expected), manifest.models[k].id).toBeLessThanOrEqual(0.03 * expected);
    }
    expect(pickModel(5, [0, 0])).toBe(-1);
    expect(pickModel(5, [0, 2, 0])).toBe(1);
  });

  it('2. lodFor: < 45 m → 0, < 350 m → 1, else hidden', () => {
    expect(lodFor(0)).toBe(0);
    expect(lodFor(44.9)).toBe(0);
    expect(lodFor(45)).toBe(1);
    expect(lodFor(349.9)).toBe(1);
    expect(lodFor(350)).toBe(LOD_HIDDEN);
    expect(lodFor(5000)).toBe(LOD_HIDDEN);
  });

  it('3. normaliseTransform: tiny bbox scaled to length, bottom at 0, centred; yaw π/2 puts length along z', () => {
    const tiny: Box3Like = { min: [0.1, 0.2, -0.3], max: [0.12, 0.21, -0.26] }; // 0.02 × 0.01 × 0.04
    const b = normalisedBox(tiny, 0, 4.43);
    expect(b.max[2] - b.min[2]).toBeCloseTo(4.43, 6);
    expect(b.min[1]).toBeCloseTo(0, 6);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(0, 6);
    expect((b.min[2] + b.max[2]) / 2).toBeCloseTo(0, 6);
    expect(b.max[0] - b.min[0]).toBeCloseTo(0.02 * (4.43 / 0.04), 6);
    expect(b.max[1] - b.min[1]).toBeCloseTo(0.01 * (4.43 / 0.04), 6);

    const big: Box3Like = { min: [-99, -3, -67.5], max: [99, 46, 67.5] }; // 198 × 49 × 135
    const t = normaliseTransform(big, Math.PI / 2, 5.47);
    expect(t.scale).toBeCloseTo(5.47 / 198, 9);
    const g = normalisedBox(big, Math.PI / 2, 5.47);
    expect(g.max[2] - g.min[2]).toBeCloseTo(5.47, 6);
    expect(g.max[0] - g.min[0]).toBeCloseTo(135 * (5.47 / 198), 6);
    expect(g.min[1]).toBeCloseTo(0, 6);
    expect((g.min[0] + g.max[0]) / 2).toBeCloseTo(0, 6);
    expect((g.min[2] + g.max[2]) / 2).toBeCloseTo(0, 6);
    const r = rotatedBox(big, Math.PI / 2);
    expect(r.max[2] - r.min[2]).toBeCloseTo(198, 6);
  });

  it('4. light anchors: two front, two rear, at ±0.38·width, 0.45·height, on the bbox ends', () => {
    const box: Box3Like = { min: [-0.9, 0, -2.2], max: [0.9, 1.4, 2.2] };
    const a = lightAnchors(box);
    expect(a.front).toHaveLength(2);
    expect(a.rear).toHaveLength(2);
    expect(LIGHT_X_FRAC).toBeCloseTo(0.38, 9);
    expect(LIGHT_Y_FRAC).toBeCloseTo(0.45, 9);
    const xs = a.front.map((p) => p[0]).sort((p, q) => p - q);
    expect(xs[0]).toBeCloseTo(-0.38 * 1.8, 9);
    expect(xs[1]).toBeCloseTo(0.38 * 1.8, 9);
    for (const p of a.front) {
      expect(p[1]).toBeCloseTo(0.45 * 1.4, 9);
      expect(p[2]).toBeCloseTo(2.2, 9);
    }
    for (const p of a.rear) {
      expect(Math.abs(p[0])).toBeCloseTo(0.38 * 1.8, 9);
      expect(p[1]).toBeCloseTo(0.45 * 1.4, 9);
      expect(p[2]).toBeCloseTo(-2.2, 9);
    }
    // Fleet frame (travel along −z): the front is the min-z end.
    const f = lightAnchors(box, -1);
    for (const p of f.front) expect(p[2]).toBeCloseTo(-2.2, 9);
    for (const p of f.rear) expect(p[2]).toBeCloseTo(2.2, 9);
  });

  it('5. the manifest parses and every referenced GLB file exists (fs check)', () => {
    expect(manifest.models.length).toBeGreaterThanOrEqual(11);
    const ids = new Set<string>();
    for (const m of manifest.models) {
      expect(ids.has(m.id), m.id).toBe(false);
      ids.add(m.id);
      expect(m.length).toBeGreaterThan(3);
      expect(m.length).toBeLessThan(6.5);
      for (const f of [m.lod0, m.lod1]) {
        expect(f.endsWith('.glb'), f).toBe(true);
        expect(existsSync(join(CARS, f)), f).toBe(true);
      }
    }
    expect(() => parseManifest({ v: 1, models: [{ id: 'x' }] })).toThrow();
  });
});
