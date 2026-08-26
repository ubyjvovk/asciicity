/**
 * Stub edges style (docs/architecture.md §4.11). T-0056 replaces this file.
 */
import type { RenderStyle } from '../style';
import { asciiStyle } from './ascii';

/** Placeholder edges look — ascii cyber glyphs with a depth texture attached. */
export const STYLES: readonly RenderStyle[] = [
  {
    ...asciiStyle('edges', 'EDGES (TODO)', 0),
    cellW: 2,
    cellH: 2,
    subX: 1,
    subY: 1,
    needsDepth: true,
  },
];
