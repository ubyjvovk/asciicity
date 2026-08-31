/**
 * Unit tests for the matrix katakana atlas (docs/architecture.md §4.20):
 * hex decode, 8×16 shape, ink-coverage order, horizontal mirroring, glyph
 * count. Runs in node with a fake canvas/context; no WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import {
  GLYPHS,
  MATRIX_GLYPH_COUNT,
  STYLES,
  buildMatrixAtlas,
  decodeGlyph,
  inkCount,
  mirrorGlyph,
  orderedGlyphs,
} from '../src/render/styles/matrix';

/** U+FF66 ｦ — first half-width katakana, from GNU Unifont 17.0.05. */
const FF66_HEX = '00007E0202027E020202040408106000';

/** Exact 8-bit rows of U+FF66 (MSB = left). */
const FF66_ROWS = [
  '00000000',
  '00000000',
  '01111110',
  '00000010',
  '00000010',
  '00000010',
  '01111110',
  '00000010',
  '00000010',
  '00000010',
  '00000100',
  '00000100',
  '00001000',
  '00010000',
  '01100000',
  '00000000',
] as const;

/** U+0031 digit `1` — asymmetric flag on the left, used for the mirror test. */
const DIGIT_ONE_HEX = '000000000818280808080808083E0000';

function rowBits(row: boolean[]): string {
  return row.map((b) => (b ? '1' : '0')).join('');
}

function bitsToRow(bits: string): boolean[] {
  return [...bits].map((ch) => ch === '1');
}

describe('decodeGlyph', () => {
  it('hex decode of a known glyph', () => {
    expect(GLYPHS[0xff66]).toBe(FF66_HEX);
    const rows = decodeGlyph(GLYPHS[0xff66]);
    expect(rows.map(rowBits)).toEqual([...FF66_ROWS]);
  });
});

describe('charset', () => {
  it('66 glyphs decoded, all 8×16', () => {
    const cps: number[] = [];
    for (let cp = 0xff66; cp <= 0xff9d; cp++) cps.push(cp);
    for (let cp = 0x0030; cp <= 0x0039; cp++) cps.push(cp);
    expect(cps).toHaveLength(66);
    expect(Object.keys(GLYPHS)).toHaveLength(66);
    expect(MATRIX_GLYPH_COUNT).toBe(66);

    for (const cp of cps) {
      const hex = GLYPHS[cp];
      expect(hex, `missing U+${cp.toString(16)}`).toBeTypeOf('string');
      expect(hex).toHaveLength(32);
      const rows = decodeGlyph(hex);
      expect(rows).toHaveLength(16);
      for (const row of rows) expect(row).toHaveLength(8);
    }
  });
});

describe('ink order', () => {
  it('ink ordering is ascending and deterministic', () => {
    const a = orderedGlyphs();
    const b = orderedGlyphs();
    expect(a).toHaveLength(66);
    expect(a).toBe(b);

    for (let i = 0; i < a.length; i++) {
      expect(a[i].ink).toBe(inkCount(a[i].bitmap));
      if (i > 0) {
        expect(a[i].ink).toBeGreaterThanOrEqual(a[i - 1].ink);
        if (a[i].ink === a[i - 1].ink) {
          expect(a[i].codepoint).toBeGreaterThan(a[i - 1].codepoint);
        }
      }
    }

    const resorted = [...a].sort((x, y) => x.ink - y.ink || x.codepoint - y.codepoint);
    expect(resorted.map((g) => g.codepoint)).toEqual(a.map((g) => g.codepoint));
  });
});

describe('mirrorGlyph', () => {
  it("mirroring flips a known asymmetric glyph's rows as expected", () => {
    const rows = decodeGlyph(DIGIT_ONE_HEX);
    const mirrored = mirrorGlyph(rows);
    expect(mirrored.map(rowBits)).toEqual([
      '00000000',
      '00000000',
      '00000000',
      '00000000',
      '00010000',
      '00011000',
      '00010100',
      '00010000',
      '00010000',
      '00010000',
      '00010000',
      '00010000',
      '00010000',
      '01111100',
      '00000000',
      '00000000',
    ]);
    // Original is unchanged (no mutate) and not equal to the flip.
    expect(rows.map(rowBits)).not.toEqual(mirrored.map(rowBits));
    expect(rowBits(rows[6])).toBe('00101000');
    expect(rowBits(mirrored[6])).toBe('00010100');
    // Mirror of mirror is identity.
    expect(mirrorGlyph(mirrored).map(rowBits)).toEqual(rows.map(rowBits));
  });
});

type Fill = { x: number; y: number; w: number; h: number; style: string };

function fakeCanvas(): {
  canvas: HTMLCanvasElement;
  fills: Fill[];
  fontSets: string[];
} {
  const fills: Fill[] = [];
  const fontSets: string[] = [];
  const state = { fillStyle: '' };
  const fakeCtx = {
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get fillStyle(): string {
      return state.fillStyle;
    },
    set font(v: string) {
      fontSets.push(v);
    },
    get font(): string {
      return '';
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      fills.push({ x, y, w, h, style: state.fillStyle });
    },
    fillText(): void {
      throw new Error('matrix atlas must not call fillText');
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => fakeCtx,
  } as unknown as HTMLCanvasElement;
  return { canvas, fills, fontSets };
}

describe('buildMatrixAtlas', () => {
  it('glyph-count uniform equals 66', () => {
    const { canvas, fontSets } = fakeCanvas();
    const built = buildMatrixAtlas(canvas);
    expect(built.count).toBe(66);
    expect(MATRIX_GLYPH_COUNT).toBe(66);
    expect(canvas.width).toBe(66 * 16);
    expect(canvas.height).toBe(32);
    expect(fontSets).toHaveLength(0);

    const u = STYLES[0].makeUniforms({
      cols: 1,
      rows: 1,
      makeCanvas: () => canvas,
    });
    expect(u.glyphCount.value).toBe(66);
  });

  it('blits a known glyph horizontally mirrored, nearest-neighbour, no font', () => {
    const { canvas, fills, fontSets } = fakeCanvas();
    buildMatrixAtlas(canvas);
    expect(fontSets).toHaveLength(0);

    const glyphs = orderedGlyphs();
    const idx = glyphs.findIndex((g) => g.codepoint === 0xff66);
    expect(idx).toBeGreaterThanOrEqual(0);
    const mirrored = mirrorGlyph(glyphs[idx].bitmap);

    const white = fills.filter((f) => f.style === '#fff');
    const tileX = idx * 16;
    const inTile = white.filter((f) => f.x >= tileX && f.x < tileX + 16);
    const expected: string[] = [];
    for (let gy = 0; gy < 32; gy++) {
      const srcY = Math.floor((gy * 16) / 32);
      for (let gx = 0; gx < 16; gx++) {
        const srcX = Math.floor((gx * 8) / 16);
        if (mirrored[srcY][srcX]) expected.push(`${gx},${gy}`);
      }
    }
    const got = inTile.map((f) => `${f.x - tileX},${f.y}`).sort();
    expect(got).toEqual([...expected].sort());
    // Spot-check: Unifont row 3 of ｦ is 00000010 → mirrored 01000000, so
    // source col 1 is set; at 2× that is dest x 2–3, y 6–7.
    expect(rowBits(bitsToRow(FF66_ROWS[3]))).toBe('00000010');
    expect(rowBits(mirrored[3])).toBe('01000000');
    const keys = new Set(got);
    expect(keys.has('2,6')).toBe(true);
    expect(keys.has('3,7')).toBe(true);
    expect(keys.has('0,6')).toBe(false);
  });
});
