/**
 * Type declarations for `scripts/fetch-osm.mjs` — only the pure helpers the
 * vitest test imports (the CLI itself is exercised via child_process). The
 * `.mjs` runtime is authoritative; this file only narrows the shapes.
 */

type Bbox = [number, number, number, number];

/** Overpass element as returned by `[out:json]` (any element kind). */
type OsmElement = { type: string; id: number };

/**
 * Split a WGS84 bbox into an N×M grid of sub-bboxes that tile it exactly
 * (shared edges, no gaps or overlaps). Used by `--chunks NxM`.
 */
export function splitBbox(
  bbox: Bbox,
  n: number,
  m: number,
): Bbox[];

/**
 * Keep one copy of each Overpass element by `type` + `id` (first wins,
 * original order preserved) — a seam element is returned by every chunk.
 */
export function dedupeElements(elements: OsmElement[]): OsmElement[];

/**
 * Parse CLI argv into a record. `--tiles` is a boolean flag (bare ⇒ true);
 * every other `--key` requires a value.
 */
export function parseArgs(argv: string[]): Record<string, string | true>;
