/**
 * Stub matrix style (docs/architecture.md §4.11). T-0058 replaces this file.
 */
import type { RenderStyle } from '../style';
import { asciiStyle } from './ascii';

/** Placeholder matrix look — ascii cyber glyphs at cell 6×12. */
export const STYLES: readonly RenderStyle[] = [
  {
    ...asciiStyle('matrix', 'MATRIX (TODO)', 0),
    cellW: 6,
    cellH: 12,
    subX: 1,
    subY: 1,
    needsDepth: false,
  },
];
