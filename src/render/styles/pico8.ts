/**
 * Stub pico8 style (docs/architecture.md §4.11). T-0055 replaces this file.
 */
import type { RenderStyle } from '../style';
import { asciiStyle } from './ascii';

/** Placeholder PICO-8 look — ascii cyber glyphs at cell 4×4. */
export const STYLES: readonly RenderStyle[] = [
  {
    ...asciiStyle('pico8', 'PICO8 (TODO)', 0),
    cellW: 4,
    cellH: 4,
    subX: 1,
    subY: 1,
    needsDepth: false,
  },
];
