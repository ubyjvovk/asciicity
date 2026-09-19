/**
 * `retrocgi` render style (docs/architecture.md §4.11 "`retrocgi` (wave
 * 19)"): the 1981 wireframe-glider display — phosphor-green outlines on
 * black, nothing else. STUB until T-0149: the `edges` shader under this
 * style's id, geometry and flags, so the cycle, `?render=retrocgi` and the
 * NOSEVIEW HUD skin (src/hud/noseview.ts) work today. T-0149 replaces this
 * file wholesale.
 */
import type { RenderStyle } from '../style';
import { STYLES as edges } from './edges';

/** Single-entry registry for the `retrocgi` id (docs/architecture.md §4.11). */
export const STYLES: readonly RenderStyle[] = [
  {
    ...edges[0]!,
    id: 'retrocgi',
    label: 'RETROCGI (TODO)',
    groundGrid: false,
    targetCap: { w: 960, h: 540 },
  },
];
