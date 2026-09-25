/**
 * Adaptive quality controller (wave 23 perf pass, src/render/punk/quality.ts).
 */
import { describe, it, expect } from 'vitest';
import { QualityController, QUALITY_TIERS, SETTLE_S, WINDOW_S, CEILING_S } from '../src/render/punk/quality';

/** Run `seconds` of frames at `fps`; return how many tier changes happened. */
function run(c: QualityController, fps: number, seconds: number): number {
  let changes = 0;
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) if (c.frame(dt)) changes++;
  return changes;
}

describe('QualityController', () => {
  it('tiers go from expensive to cheap', () => {
    for (let i = 1; i < QUALITY_TIERS.length; i++) {
      expect(QUALITY_TIERS[i].dpr).toBeLessThanOrEqual(QUALITY_TIERS[i - 1].dpr);
      expect(QUALITY_TIERS[i].ssrScale).toBeLessThanOrEqual(QUALITY_TIERS[i - 1].ssrScale);
    }
  });

  it('ignores the settle period, then steps down one tier per slow window', () => {
    const c = new QualityController();
    run(c, 20, SETTLE_S - 0.1);
    expect(c.tier).toBe(0);
    run(c, 20, WINDOW_S + 0.2);
    expect(c.tier).toBe(1);
  });

  it('keeps stepping down on a slow GPU until the floor', () => {
    const c = new QualityController();
    run(c, 15, 60);
    expect(c.tier).toBe(QUALITY_TIERS.length - 1);
  });

  it('steps up after sustained headroom but never back into a banned tier within CEILING_S', () => {
    const c = new QualityController();
    run(c, 30, SETTLE_S + WINDOW_S + 0.2); // fell 0 → 1
    expect(c.tier).toBe(1);
    run(c, 120, 20);
    expect(c.tier).toBe(1); // tier 0 banned for CEILING_S
    run(c, 120, CEILING_S);
    expect(c.tier).toBe(0);
  });

  it('does not oscillate at steady mid fps', () => {
    const c = new QualityController();
    expect(run(c, 60, 120)).toBe(0);
  });

  it('a fixed tier never adapts', () => {
    const c = new QualityController(0, 2);
    run(c, 10, 30);
    expect(c.tier).toBe(2);
  });
});
