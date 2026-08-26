/**
 * Unit tests for the pure teletext helpers (docs/architecture.md §4.11):
 * `TELETEXT_PALETTE`, `teletextIndex`, `sixelBits`. Runs in node; no WebGL.
 */
import { describe, expect, it } from 'vitest';
import {
  STYLES,
  TELETEXT_PALETTE,
  sixelBits,
  teletextIndex,
} from '../../src/render/styles/teletext';

describe('TELETEXT_PALETTE', () => {
  it('has 8 entries with components 0/1', () => {
    expect(TELETEXT_PALETTE).toHaveLength(8);
    for (const colour of TELETEXT_PALETTE) {
      expect(colour).toHaveLength(3);
      for (const ch of colour) {
        expect(ch === 0 || ch === 1).toBe(true);
      }
    }
  });

  it('is black, red, green, yellow, blue, magenta, cyan, white', () => {
    expect(TELETEXT_PALETTE[0]).toEqual([0, 0, 0]);
    expect(TELETEXT_PALETTE[1]).toEqual([1, 0, 0]);
    expect(TELETEXT_PALETTE[2]).toEqual([0, 1, 0]);
    expect(TELETEXT_PALETTE[3]).toEqual([1, 1, 0]);
    expect(TELETEXT_PALETTE[4]).toEqual([0, 0, 1]);
    expect(TELETEXT_PALETTE[5]).toEqual([1, 0, 1]);
    expect(TELETEXT_PALETTE[6]).toEqual([0, 1, 1]);
    expect(TELETEXT_PALETTE[7]).toEqual([1, 1, 1]);
  });
});

describe('sixelBits', () => {
  it('sixelBits of a bottom-bright column lights bits 0 and 1 only', () => {
    // Bottom row of the 2×3 mosaic (y = 0, both x) → bits 0 and 1.
    expect(sixelBits([1, 1, 0, 0, 0, 0])).toBe(0b000011);
    expect(sixelBits([1, 1, 0, 0, 0, 0]) & ~0b000011).toBe(0);
  });

  it('all-equal → 63', () => {
    expect(sixelBits([0, 0, 0, 0, 0, 0])).toBe(63);
    expect(sixelBits([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])).toBe(63);
    expect(sixelBits([1, 1, 1, 1, 1, 1])).toBe(63);
  });
});

describe('teletextIndex', () => {
  it('maps pure red → 1', () => {
    expect(teletextIndex([1, 0, 0])).toBe(1);
  });

  it('maps yellow → 3', () => {
    expect(teletextIndex([1, 1, 0])).toBe(3);
  });

  it('maps cyan → 6', () => {
    expect(teletextIndex([0, 1, 1])).toBe(6);
  });

  it('maps white → 7', () => {
    expect(teletextIndex([1, 1, 1])).toBe(7);
  });

  it('maps a dim grey (bright < 0.15) → 0', () => {
    expect(teletextIndex([0.1, 0.1, 0.1])).toBe(0);
    expect(teletextIndex([0.14, 0.0, 0.0])).toBe(0);
  });

  it('maps an orange (1, 0.6, 0) → yellow (3)', () => {
    expect(teletextIndex([1, 0.6, 0])).toBe(3);
  });
});

describe('STYLES', () => {
  it('exports id teletext at cell 6×12 sub 2×3 without depth', () => {
    expect(STYLES).toHaveLength(1);
    const s = STYLES[0];
    expect(s.id).toBe('teletext');
    expect(s.cellW).toBe(6);
    expect(s.cellH).toBe(12);
    expect(s.subX).toBe(2);
    expect(s.subY).toBe(3);
    expect(s.needsDepth).toBe(false);
    expect(s.fragment).toMatch(/void\s+main\s*\(\s*\)/);
  });
});
