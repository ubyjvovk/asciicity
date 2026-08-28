/**
 * Unit tests for the pure helpers of the postcard PNG export (T-0072,
 * docs/architecture.md §4.15). The capture itself is browser-only and covered
 * by `e2e/postcard.spec.ts`; here we test the filename and caption layout.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTION_HEIGHT,
  CAPTION_PAD_X,
  CAPTION_TEXT_Y,
  captionLayout,
  postcardFilename,
} from '../src/export/postcard';

describe('postcardFilename', () => {
  it('formats a city + local time as asciicity-<city>-<yyyymmdd-hhmmss>.png', () => {
    expect(postcardFilename('london', new Date(2026, 7, 28, 14, 22, 33))).toBe(
      'asciicity-london-20260828-142233.png',
    );
  });

  it('zero-pads month/day/hour/minute/second to two digits', () => {
    // Aug 5, 2026 09:07:03 → all single-digit components zero-padded.
    expect(postcardFilename('kyiv', new Date(2026, 7, 5, 9, 7, 3))).toBe(
      'asciicity-kyiv-20260805-090703.png',
    );
  });

  it('lower-cases the city id', () => {
    expect(postcardFilename('LONDON', new Date(2026, 0, 1, 0, 0, 0))).toBe(
      'asciicity-london-20260101-000000.png',
    );
  });
});

describe('captionLayout', () => {
  it('returns the bar rect and left/right text anchors for a given width', () => {
    const layout = captionLayout(400, 120);
    expect(layout.bar).toEqual({ x: 0, y: 0, width: 400, height: CAPTION_HEIGHT });
    expect(layout.left).toEqual({ x: CAPTION_PAD_X, y: CAPTION_TEXT_Y });
    // Right text hugs the right padding: width − textWidth − pad.
    expect(layout.right).toEqual({ x: 400 - 120 - CAPTION_PAD_X, y: CAPTION_TEXT_Y });
  });

  it('keeps the left anchor fixed and the right anchor depends on text width', () => {
    const short = captionLayout(300, 50);
    const long = captionLayout(300, 200);
    expect(short.left).toEqual(long.left);
    expect(short.right.x).toBeGreaterThan(long.right.x);
  });
});
