/**
 * Stub dither + gameboy styles (docs/architecture.md §4.11). T-0054 replaces
 * this file.
 */
import type { RenderStyle } from '../style';
import { asciiStyle } from './ascii';

/** Placeholder dither/gameboy looks — ascii cyber glyphs at cell 2×2. */
export const STYLES: readonly RenderStyle[] = [
  {
    ...asciiStyle('dither', 'DITHER (TODO)', 0),
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    needsDepth: false,
  },
  {
    ...asciiStyle('gameboy', 'GAMEBOY (TODO)', 0),
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    needsDepth: false,
  },
];
