/**
 * `pencil` render style STUB (docs/architecture.md §4.11, wave 18 "sketch
 * family"). Cell 3×3, sub 1×1, `needsDepth: true`, `groundGrid: false`.
 * Until its wave-18 ticket lands this only writes the gamma-shaped scene
 * sample so the registry and the `R` cycle stay valid; the real shader
 * replaces this file wholesale.
 */
import type { RenderStyle } from '../style';

/** Placeholder fragment: shaped scene sample. */
const PENCIL_STUB_FRAGMENT = `
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 c = pow(clamp(sampleSub(cell, 0.0, 0.0), 0.0, 1.0), vec3(gamma));
  gl_FragColor = vec4(c, 1.0);
}
`;

/** Single-entry registry for the `pencil` id (stub until its wave-18 ticket). */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'pencil',
    label: 'PENCIL',
    cellW: 3,
    cellH: 3,
    subX: 1,
    subY: 1,
    needsDepth: true,
    groundGrid: false,
    fragment: PENCIL_STUB_FRAGMENT,
    makeUniforms(): Record<string, never> {
      return {};
    },
  },
];
