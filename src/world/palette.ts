/**
 * Building colours (docs/architecture.md §4.3). Famous named buildings use
 * a fixed OSM-name colour; other named buildings cycle the landmark palette;
 * everything else cycles the eight-colour street palette.
 */
import type { Building } from '../data/types';

/** Street-building hex colours, indexed by `id % 8`. */
export const PALETTE = [
  0x3a6fd8, 0x2ecc71, 0x1abc9c, 0xf1c40f, 0xe67e22, 0xc0392b, 0x9b59b6, 0x95a5a6,
] as const;

/** Landmark hex colours, indexed by `id % 4`. */
export const LANDMARK_PALETTE = [0x5dade2, 0xf7dc6f, 0xff6b6b, 0xda70d6] as const;

/** Exact OSM `name` → hex for well-known landmarks (lookup is case-sensitive). */
export const LANDMARK_COLORS: Readonly<Record<string, number>> = {
  'Elizabeth Tower': 0xf7dc6f,
  'Palace of Westminster': 0xd4a017,
  'Westminster Abbey': 0xe8e0c8,
  "St Paul's Cathedral": 0xe8e0c8,
  "Nelson's Column": 0xe8e0c8,
  'National Gallery': 0xe8e0c8,
  'Somerset House': 0xe8e0c8,
  'London Eye': 0xffffff,
  '30 St Mary Axe': 0x1abc9c,
  '20 Fenchurch Street': 0x95a5a6,
  "Lloyd's of London": 0x95a5a6,
  'Tower 42': 0x3a6fd8,
  'Heron Tower': 0x3a6fd8,
  'Tower Bridge': 0x5dade2,
  'Tower of London': 0xc0392b,
  'The Monument': 0xf7dc6f,
  Monument: 0xf7dc6f,
  'Bank of England': 0xe8e0c8,
  'Royal Exchange': 0xe8e0c8,
  'Mansion House': 0xe8e0c8,
};

/** Named-landmark colour, or `undefined` when `name` is missing or not in the table. */
export function landmarkColor(name: string | undefined): number | undefined {
  if (name === undefined) return undefined;
  if (Object.hasOwn(LANDMARK_COLORS, name)) return LANDMARK_COLORS[name];
  return undefined;
}

/** Hex colour: `LANDMARK_COLORS` by name, else landmark/street palettes as before. */
export function colorFor(b: Building): number {
  const named = landmarkColor(b.name);
  if (named !== undefined) return named;
  if (b.name !== undefined) return LANDMARK_PALETTE[b.id % LANDMARK_PALETTE.length];
  return PALETTE[b.id % PALETTE.length];
}
