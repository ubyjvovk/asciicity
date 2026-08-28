/**
 * Minimal ambient types for `gifenc@1.0.3`, which ships no bundled
 * declarations. Only the symbols the postcard GIF path imports.
 */
declare module 'gifenc' {
  /** Streaming GIF encoder. */
  export function GIFEncoder(): {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number; repeat?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  };

  /** Reduce RGBA pixels to at most `maxColors` RGB triples. */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' },
  ): number[][];

  /** Map RGBA pixels onto a palette, returning one index per pixel. */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
  ): Uint8Array;
}
