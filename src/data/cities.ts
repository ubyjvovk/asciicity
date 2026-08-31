/**
 * City registry (docs/architecture.md §4.10, docs/integration.md).
 * `CITIES` lists every dataset shipped in `public/data/`; `cityById` picks one
 * by URL id (trimmed, case-insensitive). Pure: no DOM/WebGL.
 */
import { STYLE_ORDER } from '../render/style';

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
  /**
   * Boot render-style id (a `STYLE_ORDER` id, architecture.md §4.20): when the
   * URL carries no explicit `?render=`, this city boots that style instead of
   * the persisted choice. Applied at boot only — `R` cycling and persistence
   * are unaffected. An unknown id falls through to the persisted setting.
   * Only Tokyo sets one (`matrix`); other cities must leave it unset.
   */
  defaultRender?: string;
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
  {
    id: 'tokyo',
    label: 'TOKYO',
    file: 'data/tokyo/index.json',
    defaultSpawn: 'tokyostation',
    blurb: 'Imperial Palace to the Skytree · streamed',
    sizeBytes: 2701381,
    tiled: true,
    defaultRender: 'matrix',
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

/**
 * Boot render-style precedence (architecture.md §4.20, locked): an explicit
 * URL style (`urlRender`, parsed by the caller) always wins, then the city's
 * `defaultRender` (an unknown id falls through), then the persisted
 * `settings.render` (which itself falls back to `'ascii'`). `cityInfo` is
 * `undefined` for synthetic, so no city default applies. Pure: no DOM/WebGL.
 */
export function resolveBootRender(
  urlRender: string | undefined,
  cityInfo: CityInfo | undefined,
  persistedRender: string,
): string {
  if (urlRender !== undefined) return urlRender;
  const cityDefault = cityInfo?.defaultRender;
  if (
    cityDefault !== undefined &&
    (STYLE_ORDER as readonly string[]).includes(cityDefault)
  ) {
    return cityDefault;
  }
  return persistedRender;
}
