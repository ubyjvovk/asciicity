/**
 * Unit tests for the pure parts of the ASCII post-process (docs/architecture.md
 * §4.8): `DEFAULT_RAMP`, `glyphIndex` and `buildGlyphAtlas`. Runs in node using
 * a fake canvas/context; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RAMP, buildGlyphAtlas, glyphIndex } from '../src/render/ascii';

describe('DEFAULT_RAMP', () => {
  it('starts with a space', () => {
    expect(DEFAULT_RAMP[0]).toBe(' ');
  });

  it('has at least 60 glyphs', () => {
    expect(DEFAULT_RAMP.length).toBeGreaterThanOrEqual(60);
  });
});

describe('glyphIndex', () => {
  it('returns 0 at lum = 0 for any gamma/count', () => {
    expect(glyphIndex(0, 10, 0.8)).toBe(0);
    expect(glyphIndex(0, 68, 1.0)).toBe(0);
    expect(glyphIndex(0, 4, 2.2)).toBe(0);
  });

  it('returns n-1 at lum = 1 for any gamma/count', () => {
    expect(glyphIndex(1, 10, 0.8)).toBe(9);
    expect(glyphIndex(1, 68, 1.0)).toBe(67);
    expect(glyphIndex(1, 4, 2.2)).toBe(3);
  });

  it('clamps values outside [0, 1]', () => {
    expect(glyphIndex(-0.5, 10, 0.8)).toBe(0);
    expect(glyphIndex(-1e6, 10, 1.0)).toBe(0);
    expect(glyphIndex(1.5, 10, 0.8)).toBe(9);
    expect(glyphIndex(1e6, 68, 0.8)).toBe(67);
  });

  it('is monotonic non-decreasing across 0…1 in 0.01 steps', () => {
    const count = 68;
    const gamma = 0.8;
    let prev = glyphIndex(0, count, gamma);
    for (let i = 1; i <= 100; i++) {
      const lum = i / 100;
      const cur = glyphIndex(lum, count, gamma);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it('with gamma = 1, lum = 0.5, count = 11 gives 5', () => {
    expect(glyphIndex(0.5, 11, 1)).toBe(5);
  });
});

describe('buildGlyphAtlas', () => {
  it('sets canvas width/height and records exactly ramp.length fillText calls', () => {
    const ramp = 'abc';
    const tileW = 16;
    const tileH = 32;
    const font = 'bold 24px monospace';

    const calls: { text: string; x: number; y: number }[] = [];
    const fills: { x: number; y: number; w: number; h: number }[] = [];
    const state: {
      fillStyle: string;
      font: string;
      textAlign: string;
      textBaseline: string;
    } = {
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
    };

    const fakeCtx = {
      set fillStyle(v: string) {
        state.fillStyle = v;
      },
      get fillStyle(): string {
        return state.fillStyle;
      },
      set font(v: string) {
        state.font = v;
      },
      get font(): string {
        return state.font;
      },
      set textAlign(v: string) {
        state.textAlign = v;
      },
      get textAlign(): string {
        return state.textAlign;
      },
      set textBaseline(v: string) {
        state.textBaseline = v;
      },
      get textBaseline(): string {
        return state.textBaseline;
      },
      fillRect(x: number, y: number, w: number, h: number): void {
        fills.push({ x, y, w, h });
      },
      fillText(text: string, x: number, y: number): void {
        calls.push({ text, x, y });
      },
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => fakeCtx,
    } as unknown as HTMLCanvasElement;

    const result = buildGlyphAtlas(ramp, tileW, tileH, font, fakeCanvas);

    expect(fakeCanvas.width).toBe(ramp.length * tileW);
    expect(fakeCanvas.height).toBe(tileH);
    expect(state.font).toBe(font);
    expect(state.textAlign).toBe('center');
    expect(state.textBaseline).toBe('middle');
    expect(calls).toHaveLength(ramp.length);
    for (let i = 0; i < ramp.length; i++) {
      expect(calls[i].text).toBe(ramp[i]);
      expect(calls[i].x).toBeCloseTo(i * tileW + tileW / 2);
      expect(calls[i].y).toBeCloseTo(tileH / 2);
    }
    expect(result.canvas).toBe(fakeCanvas);
    expect(result.count).toBe(ramp.length);
  });
});
