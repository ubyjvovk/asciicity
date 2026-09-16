/**
 * Type declarations for `scripts/minas-tirith-buildings.mjs`, so the vitest
 * test and `tsc --noEmit` can import the JS module without `allowJs`.
 */

import type { Building } from '../src/data/types';
import type { Tier } from './gen-minas-tirith';

/**
 * Tangential house rows on tiers 1–6 (architecture.md §4.23 Houses).
 * Ids `10000 + k·1000 + n`; colour from the four stone tints by `id % 4`.
 */
export function buildHouses(
  tiers: ReadonlyArray<Tier>,
  gateAz: ReadonlyArray<number>,
  rand: () => number,
): Building[];

/**
 * Citadel halls, Rath Dínen tombs, Houses of Healing, Old Guesthouse.
 * Twelve named buildings; ids `20000 + n`.
 */
export function buildLandmarks(): Building[];

/**
 * White Tree plus six garden trees (architecture.md §4.23).
 * Seven `[x, z, h, r]` entries, `[0, 0, 8, 3]` first.
 */
export function buildTrees(): [number, number, number, number][];
