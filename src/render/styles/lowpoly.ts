/**
 * `lowpoly` render style STUB (docs/architecture.md §4.11, wave 15). Cell
 * 6×6, sub 2×2, `needsDepth: true`. Until T-0120 lands this only writes the
 * cell mean so the registry and the `R` cycle stay valid; the real '80s-CGI
 * flat-facet + ink-outline shader replaces this file wholesale.
 */
import type { RenderStyle } from '../style';

/** Placeholder fragment: exposed cell mean, no posterisation, no outlines. */
const LOWPOLY_STUB_FRAGMENT = `
void main() {
  vec2 cell = floor(vUv * grid);
  gl_FragColor = vec4(clamp(cellMean(cell), 0.0, 1.0), 1.0);
}
`;

/** Single-entry registry for the `lowpoly` id (stub until T-0120). */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'lowpoly',
    label: 'LOWPOLY',
    cellW: 6,
    cellH: 6,
    subX: 2,
    subY: 2,
    needsDepth: true,
    fragment: LOWPOLY_STUB_FRAGMENT,
    makeUniforms(): Record<string, never> {
      return {};
    },
  },
];
