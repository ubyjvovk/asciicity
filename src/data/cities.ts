/**
 * City registry (docs/architecture.md §4.10, docs/integration.md).
 * `CITIES` lists every dataset shipped in `public/data/`; `cityById` picks one
 * by URL id (trimmed, case-insensitive). Pure: no DOM/WebGL.
 */

/** Everything `main.ts` needs to boot a city: URL id, label, dataset path, default spawn. */
export interface CityInfo {
  /** URL id used in `?city=<id>`. Lower-case, no spaces. */
  id: string;
  /** Uppercase label shown on the start overlay. */
  label: string;
  /** Path (under `BASE_URL`) of the committed dataset. */
  file: string;
  /** Spawn preset used when `?at=` is absent or resolves outside the bbox. */
  defaultSpawn: string;
  /** One-line description shown next to the label on the picker. */
  blurb: string;
  /**
   * Committed size of `public/<file>` in bytes — the fallback denominator for
   * the loading bar when Content-Length is absent (gzip). Update after a
   * re-fetch (`stat -c %s`). For a tiled city this is the `index.json` size.
   */
  sizeBytes: number;
  /**
   * When true, `file` names `data/<id>/index.json` and the app boots the
   * sector-streaming path (architecture.md §4.19). Every shipped city is tiled;
   * the monolithic loader remains only for `?synthetic=1` and unit tests.
   */
  tiled?: true;
}

/** Datasets shipped in `public/data/`. Order = picker order. */
export const CITIES: readonly CityInfo[] = [
  {
    id: 'london',
    label: 'LONDON',
    file: 'data/london/index.json',
    defaultSpawn: 'bigben',
    blurb: 'City of London & Westminster · flat',
    sizeBytes: 256785,
    tiled: true,
  },
  {
    id: 'kyiv',
    label: 'KYIV',
    file: 'data/kyiv/index.json',
    defaultSpawn: 'maidan',
    blurb: 'Central Kyiv · Dnipro hills, 120 m of relief',
    sizeBytes: 634133,
    tiled: true,
  },
  {
    id: 'sf',
    label: 'SAN FRANCISCO',
    file: 'data/sf/index.json',
    defaultSpawn: 'ggb',
    blurb: 'Downtown to the Golden Gate · hills & bay',
    sizeBytes: 1273711,
    tiled: true,
  },
  {
    id: 'nyc',
    label: 'MANHATTAN',
    file: 'data/nyc/index.json',
    defaultSpawn: 'brooklynbridge',
    blurb: 'Battery to Central Park · skyscrapers & bridges',
    sizeBytes: 920302,
    tiled: true,
  },
];

/**
 * Look up a `CityInfo` by URL id. Trims whitespace and lower-cases the input;
 * `null` / `undefined` / an unknown id all return `undefined`.
 */
export function cityById(id: string | null | undefined): CityInfo | undefined {
  if (id === null || id === undefined) return undefined;
  const key = id.trim().toLowerCase();
  if (key === '') return undefined;
  return CITIES.find((c) => c.id === key);
}
