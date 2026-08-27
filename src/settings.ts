/**
 * Persisted UI settings: HUD / minimap / CRT / render-style / last city.
 * Pure: no DOM. `localStorage` and `history.replaceState` live in `main.ts`.
 */
import { STYLE_ORDER } from './render/style';

/** Key under which the JSON blob is stored in `localStorage`. */
export const SETTINGS_KEY = 'asciicity.settings';

/** Live toggle state plus the last-chosen city id. */
export interface Settings {
  /** NAVIGATION panel visible. */
  hud: boolean;
  /** Top-left minimap panel visible. */
  minimap: boolean;
  /** CRT scanline overlay visible. */
  crt: boolean;
  /** Render-style id (`?render=`). */
  render: string;
  /** Last city id, or `null` if unset (show the picker). */
  city: string | null;
}

/** Factory defaults: every panel on, ASCII look, no remembered city. */
export const DEFAULT_SETTINGS: Settings = {
  hud: true,
  minimap: true,
  crt: true,
  render: 'ascii',
  city: null,
};

/**
 * Merge storage + URL into a {@link Settings} object: URL wins, storage fills
 * gaps, {@link DEFAULT_SETTINGS} last. Malformed storage JSON is ignored.
 */
export function loadSettings(
  storage: Pick<Storage, 'getItem'>,
  url: URLSearchParams,
): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };

  const raw = storage.getItem(SETTINGS_KEY);
  if (raw !== null && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if (typeof o.hud === 'boolean') out.hud = o.hud;
        if (typeof o.minimap === 'boolean') out.minimap = o.minimap;
        if (typeof o.crt === 'boolean') out.crt = o.crt;
        if (typeof o.render === 'string') out.render = resolveRenderId(o.render);
        if (typeof o.city === 'string' || o.city === null) out.city = o.city;
      }
    } catch {
      // Malformed JSON → keep defaults (URL may still override below).
    }
  }

  const hud = url.get('hud');
  if (hud !== null) out.hud = hud !== '0';
  const minimap = url.get('minimap');
  if (minimap !== null) out.minimap = minimap !== '0';
  const crt = url.get('crt');
  if (crt !== null) out.crt = crt !== '0';

  const fromUrl = renderFromUrl(url);
  if (fromUrl !== undefined) out.render = fromUrl;

  const city = url.get('city');
  if (city !== null && city.trim() !== '') out.city = city;

  return out;
}

/**
 * Write `s` to `storage` under {@link SETTINGS_KEY}.
 */
export function saveSettings(storage: Pick<Storage, 'setItem'>, s: Settings): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/**
 * Rewrite only `hud` / `minimap` / `crt` / `render` on `search`. Booleans are
 * `1`/`0`; a key equal to its default is removed so the URL stays short.
 * Every other parameter (city, at, synthetic, …) is kept.
 */
export function applySettingsToUrl(search: string, s: Settings): string {
  const params = new URLSearchParams(search);
  setBoolParam(params, 'hud', s.hud, DEFAULT_SETTINGS.hud);
  setBoolParam(params, 'minimap', s.minimap, DEFAULT_SETTINGS.minimap);
  setBoolParam(params, 'crt', s.crt, DEFAULT_SETTINGS.crt);
  if (s.render === DEFAULT_SETTINGS.render) params.delete('render');
  else params.set('render', s.render);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function setBoolParam(
  params: URLSearchParams,
  key: string,
  value: boolean,
  defaultValue: boolean,
): void {
  if (value === defaultValue) params.delete(key);
  else params.set(key, value ? '1' : '0');
}

/**
 * Resolve a render-style id: known ids pass through, anything else is `ascii`.
 */
function resolveRenderId(raw: string): string {
  const id = raw.trim().toLowerCase();
  return (STYLE_ORDER as readonly string[]).includes(id) ? id : 'ascii';
}

/**
 * Read `?render=` (with `?theme=` / `?gloom=1` aliases) from the URL.
 * `undefined` means the URL does not specify a style.
 */
function renderFromUrl(url: URLSearchParams): string | undefined {
  if (url.has('render')) return resolveRenderId(url.get('render') ?? '');
  const themeRaw = url.get('theme');
  if (themeRaw !== null) {
    const tv = themeRaw.trim().toLowerCase();
    if (tv === 'gloom' || tv === '1') return 'gloom';
    if (tv === 'solarized' || tv === '2') return 'solarized';
    return 'ascii';
  }
  if (url.get('gloom') === '1') return 'gloom';
  return undefined;
}
