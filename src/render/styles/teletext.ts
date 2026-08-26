/**
 * Stub teletext style (docs/architecture.md §4.11). T-0053 replaces this file.
 */
import type { RenderStyle } from '../style';
import { asciiStyle } from './ascii';

/** Placeholder teletext look — ascii cyber glyphs at 2×3 sub-samples. */
export const STYLES: readonly RenderStyle[] = [
  {
    ...asciiStyle('teletext', 'TELETEXT (TODO)', 0),
    cellW: 6,
    cellH: 12,
    subX: 2,
    subY: 3,
    needsDepth: false,
  },
];
