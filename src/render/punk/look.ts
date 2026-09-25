/**
 * Cyberpunk colour-grade presets (wave 20). Pure data, safe in node.
 *
 * Ported from ektogamat/threejs-conference `src/post/look/cyberpunkLook.js`
 * (MIT, © 2026 Anderson Mancini and Sunag). Fog distances are rescaled from
 * the demo's 60 m alley to AsciiCity's city blocks (`FOG_SCALE`); every other
 * number is the original.
 */

/** Demo alley → city: the look's fog `near`/`far` are multiplied by this. */
export const FOG_SCALE = 5;

/** One colour grade + bloom/flare setting. Colours are sRGB triples. */
export interface LookPreset {
  id: string;
  label: string;
  bloom: { strength: number; radius: number };
  bloomWide: { strength: number; radius: number };
  lensflare: { strength: number; threshold: number; ghostSpacing: number; ghostAttenuation: number };
  fogEnabled: number;
  fogNear: number;
  fogFar: number;
  fogAmount: number;
  fogColorSrgb: [number, number, number];
  gradeTint: [number, number, number];
  gradeOffset: [number, number, number];
  saturation: number;
  contrast: number;
  greenSuppress: number;
  gradeMix: number;
  chromaticStrength: number;
  chromaticEdgeFalloff: number;
  vignetteIntensity: number;
  vignetteSmoothness: number;
  grainIntensity: number;
}

const FOG = { enabled: 0.35, near: 0, far: 50 * FOG_SCALE, amount: 0.8 };

/** Every preset, in `L`-cycle order; the first is the default. */
export const LOOK_PRESETS: readonly LookPreset[] = [
  {
    id: 'neonNoir',
    label: 'NEON NOIR',
    bloom: { strength: 0.85, radius: 0.55 },
    bloomWide: { strength: 2.2, radius: 0.85 },
    lensflare: { strength: 0.35, threshold: 0.9, ghostSpacing: 0.22, ghostAttenuation: 50 },
    fogEnabled: FOG.enabled,
    fogNear: FOG.near,
    fogFar: FOG.far,
    fogAmount: FOG.amount,
    fogColorSrgb: [0.34, 0.37, 0.47],
    gradeTint: [1.02, 0.9, 1.06],
    gradeOffset: [0.004, -0.006, 0.008],
    saturation: 1.06,
    contrast: 1.1,
    greenSuppress: 0.72,
    gradeMix: 0.7,
    chromaticStrength: 0.8,
    chromaticEdgeFalloff: 3.5,
    vignetteIntensity: 0.8,
    vignetteSmoothness: 0.64,
    grainIntensity: 0.12,
  },
  {
    id: 'magentaRain',
    label: 'MAGENTA RAIN',
    bloom: { strength: 5, radius: 0.72 },
    bloomWide: { strength: 2.6, radius: 1 },
    lensflare: { strength: 0.2, threshold: 0.45, ghostSpacing: 0.2, ghostAttenuation: 22 },
    fogEnabled: FOG.enabled,
    fogNear: FOG.near,
    fogFar: FOG.far,
    fogAmount: FOG.amount,
    fogColorSrgb: [0.4, 0.34, 0.44],
    gradeTint: [1.08, 0.9, 1.08],
    gradeOffset: [0.012, -0.015, 0.01],
    saturation: 1.28,
    contrast: 1.12,
    greenSuppress: 0.68,
    gradeMix: 0.9,
    chromaticStrength: 0.85,
    chromaticEdgeFalloff: 3.5,
    vignetteIntensity: 0.5,
    vignetteSmoothness: 0.55,
    grainIntensity: 0.3,
  },
  {
    id: 'tealDusk',
    label: 'TEAL DUSK',
    bloom: { strength: 3.6, radius: 0.58 },
    bloomWide: { strength: 1.85, radius: 0.78 },
    lensflare: { strength: 0.55, threshold: 0.6, ghostSpacing: 0.24, ghostAttenuation: 30 },
    fogEnabled: FOG.enabled,
    fogNear: FOG.near,
    fogFar: FOG.far,
    fogAmount: FOG.amount,
    fogColorSrgb: [0.32, 0.38, 0.46],
    gradeTint: [0.94, 0.98, 1.06],
    gradeOffset: [-0.008, 0, 0.01],
    saturation: 1.06,
    contrast: 1.06,
    greenSuppress: 0.8,
    gradeMix: 0.72,
    chromaticStrength: 0.28,
    chromaticEdgeFalloff: 3,
    vignetteIntensity: 0.3,
    vignetteSmoothness: 0.68,
    grainIntensity: 0.14,
  },
  {
    id: 'silentHill',
    label: 'SILENT HILL',
    bloom: { strength: 1.41, radius: 1 },
    bloomWide: { strength: 0, radius: 0 },
    lensflare: { strength: 0, threshold: 0.6, ghostSpacing: 0.25, ghostAttenuation: 25 },
    fogEnabled: 1,
    fogNear: -20 * FOG_SCALE,
    fogFar: 30 * FOG_SCALE,
    fogAmount: 1,
    fogColorSrgb: [0.37, 0.38, 0.39],
    gradeTint: [1, 1, 1],
    gradeOffset: [0, 0, 0],
    saturation: 0.42,
    contrast: 1.91,
    greenSuppress: 0,
    gradeMix: 0.24,
    chromaticStrength: 0.61,
    chromaticEdgeFalloff: 12,
    vignetteIntensity: 0.63,
    vignetteSmoothness: 0,
    grainIntensity: 0.48,
  },
  {
    id: 'sinCity',
    label: 'SIN CITY',
    bloom: { strength: 2.9, radius: 0.59 },
    bloomWide: { strength: 0, radius: 0 },
    lensflare: { strength: 0, threshold: 0.6, ghostSpacing: 0.25, ghostAttenuation: 25 },
    fogEnabled: 1,
    fogNear: -13 * FOG_SCALE,
    fogFar: 53 * FOG_SCALE,
    fogAmount: 0.83,
    fogColorSrgb: [0.47, 0, 0.58],
    gradeTint: [1, 1, 1],
    gradeOffset: [0, 0, 0],
    saturation: 0,
    contrast: 2,
    greenSuppress: 1,
    gradeMix: 1,
    chromaticStrength: 0.79,
    chromaticEdgeFalloff: 4.17,
    vignetteIntensity: 0.77,
    vignetteSmoothness: 0.24,
    grainIntensity: 0,
  },
  {
    id: 'neutral',
    label: 'NEUTRAL',
    bloom: { strength: 3, radius: 0.5 },
    bloomWide: { strength: 1.25, radius: 1 },
    lensflare: { strength: 0, threshold: 0.6, ghostSpacing: 0.25, ghostAttenuation: 25 },
    fogEnabled: FOG.enabled,
    fogNear: FOG.near,
    fogFar: FOG.far,
    fogAmount: FOG.amount,
    fogColorSrgb: [0.36, 0.38, 0.42],
    gradeTint: [1, 1, 1],
    gradeOffset: [0, 0, 0],
    saturation: 1,
    contrast: 1,
    greenSuppress: 1,
    gradeMix: 0,
    chromaticStrength: 0,
    chromaticEdgeFalloff: 3,
    vignetteIntensity: 0,
    vignetteSmoothness: 0.65,
    grainIntensity: 0,
  },
];

/** Preset by id, or the default (`neonNoir`) for unknown ids. */
export function lookPreset(id: string | undefined): LookPreset {
  return LOOK_PRESETS.find((p) => p.id === id) ?? LOOK_PRESETS[0];
}

/** The preset `step` places after `id` in cycle order (wraps). */
export function nextLookPreset(id: string, step = 1): LookPreset {
  const n = LOOK_PRESETS.length;
  const i = LOOK_PRESETS.findIndex((p) => p.id === id);
  return LOOK_PRESETS[((((i < 0 ? 0 : i) + step) % n) + n) % n];
}

/**
 * The demo's two-band bloom collapsed onto one `BloomNode` (same formula as
 * `applyBloomSettings` upstream): strength `b + 0.35·wide`, radius
 * `max(b, 0.55·wide)`.
 */
export function bloomSettings(p: LookPreset): { strength: number; radius: number } {
  return {
    strength: p.bloom.strength + p.bloomWide.strength * 0.35,
    radius: Math.max(p.bloom.radius, p.bloomWide.radius * 0.55),
  };
}
