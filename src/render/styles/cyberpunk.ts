/**
 * Cyberpunk render style (wave 20): the look itself is the WebGPU pipeline
 * in `src/render/punk/` (ported from ektogamat/threejs-conference). This
 * module is only the registry entry plus the WebGL fallback shown while the
 * WebGPU renderer boots or if it fails — a graded, full-colour pass-through
 * in the same neon-noir palette.
 */
import type { RenderStyle } from '../style';

const FRAGMENT = `
void main() {
  vec3 c = texture2D(tScene, vUv).rgb * exposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.1) * vec3(1.02, 0.86, 1.1);
  float v = 1.0 - smoothstep(0.55, 1.0, length(vUv - 0.5) * 1.6) * 0.7;
  gl_FragColor = vec4(c * v, 1.0);
}
`;

/** The single cyberpunk style (`engine: 'webgpu'`). */
export const STYLES: readonly RenderStyle[] = [
  {
    id: 'cyberpunk',
    label: 'CYBERPUNK',
    cellW: 1,
    cellH: 1,
    subX: 1,
    subY: 1,
    needsDepth: false,
    groundGrid: false,
    targetCap: { w: 960, h: 540 },
    engine: 'webgpu',
    fragment: FRAGMENT,
    makeUniforms: () => ({}),
  },
];
