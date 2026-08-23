/**
 * Building colours (docs/architecture.md §4.3). Named buildings use the
 * landmark palette; everything else cycles the eight-colour street palette.
 */
import type { Building } from '../data/types';

/** Street-building hex colours, indexed by `id % 8`. */
export const PALETTE = [
  0x3a6fd8, 0x2ecc71, 0x1abc9c, 0xf1c40f, 0xe67e22, 0xc0392b, 0x9b59b6, 0x95a5a6,
] as const;

/** Landmark hex colours, indexed by `id % 4`. */
export const LANDMARK_PALETTE = [0x5dade2, 0xf7dc6f, 0xff6b6b, 0xda70d6] as const;

/** Hex colour for a building: landmarks cycle `LANDMARK_PALETTE`, others `PALETTE`. */
export function colorFor(b: Building): number {
  if (b.name !== undefined) return LANDMARK_PALETTE[b.id % LANDMARK_PALETTE.length];
  return PALETTE[b.id % PALETTE.length];
}
