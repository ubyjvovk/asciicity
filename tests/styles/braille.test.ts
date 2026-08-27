/**
 * Unit tests for the pure parts of the braille render style
 * (docs/architecture.md §4.11): `BRAILLE_THRESHOLDS`, `brailleBits`,
 * `brailleDots` and the procedural atlas builder. Runs in node using a fake
 * canvas/context; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  BRAILLE_THRESHOLDS,
  brailleBits,
  brailleDots,
  buildBrailleAtlas,
} from '../../src/render/styles/braille';

/** Number of set bits in an 8-bit value. */
function popcount(bits: number): number {
  let n = 0;
  for (let b = 0; b < 8; b++) if (bits & (1 << b)) n++;
  return n;
}

describe('BRAILLE_THRESHOLDS', () => {
  it('equals §4.11 exactly', () => {
    expect(BRAILLE_THRESHOLDS).toEqual([
      [1 / 9, 5 / 9],
      [7 / 9, 3 / 9],
      [2 / 9, 6 / 9],
      [8 / 9, 4 / 9],
    ]);
  });
});

describe('brailleBits', () => {
  it('all-zero → 0', () => {
    expect(brailleBits([0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
  });

  it('all-one → 255', () => {
    expect(brailleBits([1, 1, 1, 1, 1, 1, 1, 1])).toBe(255);
  });

  it('only top-left dot → 1', () => {
    const lums = [0, 0, 0, 0, 0, 0, 0, 0];
    lums[0 * 2 + 0] = 1; // lums[r*2+c]
    expect(brailleBits(lums)).toBe(1);
  });

  it('only bottom-right → 128', () => {
    const lums = [0, 0, 0, 0, 0, 0, 0, 0];
    lums[3 * 2 + 1] = 1;
    expect(brailleBits(lums)).toBe(128);
  });

  it('left column rows 0–2 → 7', () => {
    const lums = [0, 0, 0, 0, 0, 0, 0, 0];
    lums[0 * 2 + 0] = 1; // r0 c0 -> bit 0
    lums[1 * 2 + 0] = 1; // r1 c0 -> bit 1
    lums[2 * 2 + 0] = 1; // r2 c0 -> bit 2
    expect(brailleBits(lums)).toBe(7);
  });

  it('a gradient across the 8 samples lights more dots as it brightens (monotone count)', () => {
    let prev = 0;
    for (let t = 0; t <= 200; t++) {
      const v = t / 200;
      const count = popcount(brailleBits([v, v, v, v, v, v, v, v]));
      expect(count).toBeGreaterThanOrEqual(prev);
      prev = count;
    }
    expect(prev).toBe(8);
  });
});

describe('brailleDots', () => {
  it('inverse of brailleBits for 20 random bit patterns', () => {
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 20; i++) {
      const lums = Array.from({ length: 8 }, () => rand());
      const bits = brailleBits(lums);
      const dots = brailleDots(bits);
      // Rebuild a lums array marking exactly the returned dots -> same bits.
      const rebuilt = [0, 0, 0, 0, 0, 0, 0, 0];
      for (const [c, r] of dots) rebuilt[r * 2 + c] = 1;
      expect(brailleBits(rebuilt)).toBe(bits);
      // Every returned dot is distinct and only set bits appear.
      expect(dots).toHaveLength(popcount(bits));
      for (const [c, r] of dots) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('buildBrailleAtlas', () => {
  it('builds 256 tiles and draws 1024 white dots on black', () => {
    const arcs: { x: number; y: number; r: number }[] = [];
    const fills: { x: number; y: number; w: number; h: number }[] = [];
    const state: { fillStyle: string } = { fillStyle: '' };

    const fakeCtx = {
      set fillStyle(v: string) {
        state.fillStyle = v;
      },
      get fillStyle(): string {
        return state.fillStyle;
      },
      fillRect(x: number, y: number, w: number, h: number): void {
        fills.push({ x, y, w, h });
      },
      beginPath(): void {},
      arc(x: number, y: number, r: number): void {
        arcs.push({ x, y, r });
      },
      fill(): void {},
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => fakeCtx,
    } as unknown as HTMLCanvasElement;

    buildBrailleAtlas(fakeCanvas);

    expect(fakeCanvas.width).toBe(256 * 16);
    expect(fakeCanvas.height).toBe(32);
    // Black background fill first.
    expect(fills[0]).toEqual({ x: 0, y: 0, w: 256 * 16, h: 32 });
    // One dot per set bit across all 256 masks: 8 bits × 128 = 1024 arcs.
    expect(arcs).toHaveLength(1024);
    expect(state.fillStyle).toBe('#fff');
    for (const a of arcs) {
      expect(a.r).toBeCloseTo(2.5);
    }
  });
});
