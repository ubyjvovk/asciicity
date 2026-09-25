/**
 * Collision-rain constants and the CPU mirror of the per-drop shader maths
 * (wave 20). Pure — safe in node; `rain.ts` builds the node graph from the
 * same numbers.
 */

/** Rain box edge (m) around the point ahead of the camera. */
export const RAIN_AREA = 70;
/** Drop count (upstream default 5000, over a 60 m box). */
export const RAIN_COUNT = 6500;
/** Fall speed (m/s) before the ±7.5 % per-drop variance. */
export const RAIN_SPEED = 24;
/** Vertical span (m) a drop falls per cycle; it starts `RAIN_TOP` above the eye. */
export const RAIN_SPAN = 60;
/** Height (m) above the camera where drops spawn. */
export const RAIN_TOP = 24;
/** Splash lifetime (s). */
export const SPLASH_S = 0.22;
/** Height-map box edge (m) and resolution (px). */
export const HEIGHT_AREA = 96;
export const HEIGHT_RES = 512;
/** Height written where nothing was drawn (clear value): drops fall through. */
export const NO_FLOOR = -10000;

/**
 * CPU mirror of the per-drop shader maths (for tests / docs): the fall phase
 * `f ∈ [0, 1)`, the cycle index `k` (new xz each cycle), and whether the
 * streak is still above `floorY` given the spawn height `top`.
 */
export function rainDrop(
  phase0: number,
  speedVar: number,
  timeS: number,
  top: number,
  floorY: number,
): { f: number; k: number; y: number; falling: boolean; splash: number } {
  const cyc = (timeS * RAIN_SPEED * speedVar) / RAIN_SPAN + phase0;
  const k = Math.floor(cyc);
  const f = cyc - k;
  const y = top - f * RAIN_SPAN;
  const hitF = (top - floorY) / RAIN_SPAN;
  const sdur = (SPLASH_S * RAIN_SPEED * speedVar) / RAIN_SPAN;
  const sp = (f - hitF) / sdur;
  return { f, k, y, falling: f < hitF, splash: sp >= 0 && sp < 1 && hitF <= 1 ? sp : -1 };
}
