/**
 * Stub braille style (docs/architecture.md §4.11). T-0051 replaces this file.
 */
import type { RenderStyle } from '../style';
import { asciiStyle } from './ascii';

/** Placeholder braille look — ascii cyber glyphs at 2×4 sub-samples. */
export const STYLES: readonly RenderStyle[] = [
  {
    ...asciiStyle('braille', 'BRAILLE (TODO)', 0),
    cellW: 6,
    cellH: 12,
    subX: 2,
    subY: 4,
    needsDepth: false,
  },
];
