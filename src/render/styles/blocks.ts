/**
 * Stub blocks style (docs/architecture.md §4.11). T-0052 replaces this file.
 */
import type { RenderStyle } from '../style';
import { asciiStyle } from './ascii';

/** Placeholder blocks look — ascii cyber glyphs at 2×2 sub-samples. */
export const STYLES: readonly RenderStyle[] = [
  {
    ...asciiStyle('blocks', 'BLOCKS (TODO)', 0),
    cellW: 6,
    cellH: 12,
    subX: 2,
    subY: 2,
    needsDepth: false,
  },
];
