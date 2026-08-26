/**
 * Unit tests for the shareable-URL builder (`src/hud/share.ts`, §4.10).
 */
import { describe, expect, it } from 'vitest';
import { buildShareUrl } from '../src/hud/share';
import { project, unproject } from '../src/geo';
import { parseAt } from '../src/data/spawn';

// Kyiv origin (matches kyiv.json) so `unproject`/`project` round-trip against
// the same datum the app uses.
const KYIV_ORIGIN = { lat: 50.4501, lon: 30.5234 };

describe('buildShareUrl', () => {
  it('keeps only listed params, adds city+at, drops unlisted ones', () => {
    const href = 'https://x.test/asciicity/?theme=gloom&foo=1';
    const url = buildShareUrl(
      href,
      'kyiv',
      { x: 100, z: -50, yaw: Math.PI / 2 },
      KYIV_ORIGIN,
    );
    const { lon, lat } = unproject(100, -50, KYIV_ORIGIN);
    const expected = `https://x.test/asciicity/?theme=gloom&city=kyiv&at=${lon.toFixed(5)},${lat.toFixed(5)},90`;
    expect(url).toBe(expected);
  });

  it('drops a hash from href', () => {
    const href = 'https://x.test/asciicity/?theme=gloom#section';
    const url = buildShareUrl(
      href,
      'kyiv',
      { x: 0, z: 0, yaw: 0 },
      KYIV_ORIGIN,
    );
    expect(url).not.toContain('#');
  });

  it('round-trips through parseAt + project within 1 m and bearing 90', () => {
    const url = buildShareUrl(
      'https://x.test/asciicity/',
      'kyiv',
      { x: 100, z: -50, yaw: Math.PI / 2 },
      KYIV_ORIGIN,
    );
    const at = new URL(url).searchParams.get('at');
    expect(at).not.toBeNull();
    const parsed = parseAt(at);
    expect(parsed?.bearingDeg).toBe(90);
    const [px, pz] = project(parsed!.lon!, parsed!.lat!, KYIV_ORIGIN);
    expect(Math.hypot(px - 100, pz - -50)).toBeLessThan(1);
  });

  it('preserves hud=0 from href', () => {
    const href = 'https://x.test/asciicity/?hud=0';
    const url = buildShareUrl(
      href,
      'london',
      { x: 0, z: 0, yaw: 0 },
      KYIV_ORIGIN,
    );
    expect(url).toContain('hud=0');
  });
});
