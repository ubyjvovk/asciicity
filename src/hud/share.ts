/**
 * Shareable-URL builder for the pause menu (docs/architecture.md §4.10).
 * Pure: turns the current `href` plus the live player pose into an absolute
 * URL that reopens the same city at the same spot and heading. No DOM/WebGL.
 */
import { unproject } from '../geo';
import { yawToBearingDeg } from '../player/controls';

/** Query keys carried over from `href` (in output order). Everything else is dropped. */
const SHARE_KEEP = ['theme', 'time', 'cell', 'crt', 'minimap', 'hud'] as const;

/**
 * Build a shareable URL for the given pose: keep `theme`/`time`/`cell`/
 * `crt`/`minimap`/`hud` from `href` (in that order, when present), add
 * `city=<id>` and `at=<lon 5dp>,<lat 5dp>,<bearing rounded>` — lon/lat from
 * `unproject(x, z, origin)`, bearing from `yawToBearingDeg(yaw)` — and return
 * `origin + pathname + '?' + params` (any hash in `href` is dropped).
 */
export function buildShareUrl(
  href: string,
  cityId: string,
  state: { x: number; z: number; yaw: number },
  origin: { lat: number; lon: number },
): string {
  const url = new URL(href);
  url.hash = '';
  const params = new URLSearchParams();
  for (const key of SHARE_KEEP) {
    const value = url.searchParams.get(key);
    if (value !== null) params.set(key, value);
  }
  params.set('city', cityId);
  const { lon, lat } = unproject(state.x, state.z, origin);
  // `at` carries raw commas (URLSearchParams would %2C-encode them), which is
  // exactly the form `parseAt`/`?at=` accept.
  const at = `${lon.toFixed(5)},${lat.toFixed(5)},${Math.round(yawToBearingDeg(state.yaw))}`;
  const base = params.toString();
  url.search = base ? `${base}&at=${at}` : `at=${at}`;
  return url.toString();
}
