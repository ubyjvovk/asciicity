/**
 * `quest` render style STUB (docs/architecture.md §4.11, wave 16). Cell 3×3,
 * sub 1×1, `needsDepth: true`. Until T-0124 lands this only writes the
 * gamma-shaped scene sample so the registry and the `R` cycle stay valid;
 * the real SVGA-era fantasy shader (painter's ramps) replaces this file wholesale.
 */
import type { RenderStyle } from '../style';

/** Placeholder fragment: shaped scene sample, no palette, no dither. */
const QUEST_STUB_FRAGMENT = `
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 c = pow(clamp(sampleSub(cell, 0.0, 0.0), 0.0, 1.0), vec3(gamma));
  gl_FragColor = vec4(c, 1.0);
}
`;

/** Single-entry registry for the `quest` id (stub until T-0124). */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'quest',
    label: 'QUEST',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
    needsDepth: true,
    fragment: QUEST_STUB_FRAGMENT,
    makeUniforms(): Record<string, never> {
      return {};
    },
  },
];
