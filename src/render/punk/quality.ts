/**
 * Adaptive quality for the cyberpunk view (wave 23 perf pass). Pure — no
 * three import; `view.ts` applies the chosen tier.
 *
 * Measured on the PM host (RTX 5080, 1920×2160): the SSR pass was ~75 % of
 * the frame; everything else is 0–8 % each. So the tiers trade pixel ratio
 * and reflection resolution/quality first. The controller watches frame
 * rate in 1.5 s windows and steps down under `DOWN_FPS`, up over `UP_FPS`
 * (3 windows in a row), and never climbs back to a tier it recently fell
 * from (so it cannot oscillate).
 */

/** One quality level. `ssrScale` 0 = reflections off (env-map sheen only). */
export interface QualityTier {
  /** Pixel-ratio cap (also capped by `devicePixelRatio`). */
  dpr: number;
  ssrScale: number;
  /** SSR march quality 0–1. */
  ssrQuality: number;
  /** SSR max ray distance (m). */
  ssrDistance: number;
}

/** Highest (0) to lowest quality. */
export const QUALITY_TIERS: readonly QualityTier[] = [
  { dpr: 1.25, ssrScale: 0.5, ssrQuality: 0.5, ssrDistance: 120 },
  { dpr: 1.0, ssrScale: 0.5, ssrQuality: 0.35, ssrDistance: 90 },
  { dpr: 1.0, ssrScale: 0.35, ssrQuality: 0.25, ssrDistance: 60 },
  { dpr: 0.8, ssrScale: 0, ssrQuality: 0.25, ssrDistance: 60 },
  { dpr: 0.6, ssrScale: 0, ssrQuality: 0.25, ssrDistance: 60 },
];

/** Step down when a window averages below this. */
export const DOWN_FPS = 48;
/** Step up only after `UP_WINDOWS` consecutive windows above this. */
export const UP_FPS = 80;
export const UP_WINDOWS = 3;
/** Averaging window (s). */
export const WINDOW_S = 1.5;
/** Ignore frames for this long after start and after every tier change (s). */
export const SETTLE_S = 2.5;
/** After falling from tier t, do not return to t for this long (s). */
export const CEILING_S = 60;

/** Controller state; `tier` is the index into {@link QUALITY_TIERS}. */
export class QualityController {
  tier: number;
  /** Last completed window's fps (0 before the first). */
  lastFps = 0;
  private readonly fixed: boolean;
  private settle = SETTLE_S;
  private winTime = 0;
  private winFrames = 0;
  private upStreak = 0;
  /** tier → time (s) until which it may not be re-entered. */
  private readonly banned = new Map<number, number>();
  private clock = 0;

  /** `fixedTier` pins the tier (no adaptation), e.g. from `?punkq=tier2`. */
  constructor(start = 0, fixedTier?: number) {
    this.fixed = fixedTier !== undefined;
    this.tier = clampTier(fixedTier ?? start);
  }

  /** Feed one frame's duration (s). Returns true when the tier changed. */
  frame(dt: number): boolean {
    this.clock += dt;
    if (this.fixed || dt <= 0 || dt > 1) return false;
    if (this.settle > 0) {
      this.settle -= dt;
      return false;
    }
    this.winTime += dt;
    this.winFrames += 1;
    if (this.winTime < WINDOW_S) return false;
    const fps = this.winFrames / this.winTime;
    this.lastFps = fps;
    this.winTime = 0;
    this.winFrames = 0;
    if (fps < DOWN_FPS && this.tier < QUALITY_TIERS.length - 1) {
      this.banned.set(this.tier, this.clock + CEILING_S);
      return this.set(this.tier + 1);
    }
    if (fps > UP_FPS && this.tier > 0) {
      this.upStreak += 1;
      const target = this.tier - 1;
      const until = this.banned.get(target) ?? 0;
      if (this.upStreak >= UP_WINDOWS && this.clock >= until) return this.set(target);
      return false;
    }
    this.upStreak = 0;
    return false;
  }

  /** The active tier's settings. */
  get settings(): QualityTier {
    return QUALITY_TIERS[this.tier];
  }

  private set(t: number): boolean {
    this.tier = clampTier(t);
    this.settle = SETTLE_S;
    this.upStreak = 0;
    return true;
  }
}

function clampTier(t: number): number {
  return Math.max(0, Math.min(QUALITY_TIERS.length - 1, Math.round(t)));
}
