/**
 * Pure analytic height-fog + ground-mist maths for the cyberpunk atmosphere
 * (wave 20b). NO `three/webgpu` import: these are plain-number mirrors of
 * the TSL graph in `atmosphere.ts`, so unit tests can verify the integral,
 * the continuity and the mist floor without a GPU. Same constants, same
 * closed forms — never drift the two apart.
 */
import { smoothstepJs } from './noise';

/** Fog scale height (m): density halves every ~12.5 m above the ground. */
export const H = 18;

/** Base ground-level density (m⁻¹) at `fogAmount` = 1; scaled by the look. */
export const RHO0_BASE = 0.006;

/** Ground mist only exists within this height (m) above the camera ground. */
export const MIST_H = 2.5;

/** Ceiling on the ground-mist opacity (matches `MIST_H` band). */
export const MIST_MAX = 0.25;

/** Height-fog density (m⁻¹) at height `y`, ρ0 at the ground reference `y0`. */
export function heightFogDensity(y: number, rho0: number, H: number, y0: number): number {
  return rho0 * Math.exp(-(y - y0) / H);
}

/**
 * Transmittance (0..1) of the straight view segment from `camY` to `pY` over
 * a length `dist` (the closed form of ∫ρ ds; horizontal when `camY ≈ pY`).
 */
export function heightFogTransmittance(
  camY: number,
  pY: number,
  dist: number,
  rho0: number,
  H: number,
  y0: number,
): number {
  const delta = (pY - camY) / H;
  // (1 − exp(−delta)) / delta, stable via expm1; 1 in the horizontal limit.
  const avg = Math.abs(delta) < 1e-12 ? 1 : -Math.expm1(-delta) / delta;
  const tau = rho0 * dist * Math.exp(-(camY - y0) / H) * avg;
  return Math.exp(-tau);
}

/**
 * Ground-mist opacity (≤ `MIST_MAX`) at height `y`: 0 above `y0 + MIST_H`,
 * scaled by the value-noise sample `noise` (in [0, 1)).
 */
export function mistOpacity(y: number, y0: number, noise: number): number {
  const band = 1 - smoothstepJs(0, MIST_H, y - y0);
  return MIST_MAX * band * Math.min(1, Math.max(0, noise));
}
