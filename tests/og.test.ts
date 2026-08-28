/**
 * Unit tests for the Open Graph / social meta (docs/architecture.md §4.15):
 * every tag in `index.html` is present with an absolute GitHub Pages URL, and
 * the committed `public/og.png` is a real 1200×630 PNG larger than 50 KB (a
 * blank capture compresses smaller). Pure node — reads files, no browser.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Base URL the site is served from on GitHub Pages (deploy sets /asciicity/). */
const BASE = 'https://ubyjvovk.github.io/asciicity';

/** The description sentence §4.15 requires on both og:description and name=description. */
const DESCRIPTION =
  'Walk London and Kyiv rendered as coloured ASCII — 13 render styles, fly mode, postcards.';

const INDEX = readFileSync('index.html', 'utf8');

/** The Open Graph / Twitter tags §4.15 requires (property/name → content). */
const META = [
  ['property', 'og:title', 'AsciiCity'],
  ['property', 'og:type', 'website'],
  ['property', 'og:url', `${BASE}/`],
  ['property', 'og:image', `${BASE}/og.png`],
  ['property', 'og:image:width', '1200'],
  ['property', 'og:image:height', '630'],
  ['property', 'og:description', DESCRIPTION],
  ['name', 'description', DESCRIPTION],
  ['name', 'twitter:card', 'summary_large_image'],
  ['name', 'twitter:image', `${BASE}/og.png`],
] as const;

/** Read the content of the first meta tag matching `key=value` (or ''). */
function metaContent(key: string, value: string): string {
  const re = new RegExp(
    `<meta\\s+${key}=["']${value}["'][^>]*content=["']([^"']*)["']`,
    'i',
  );
  const m = re.exec(INDEX);
  if (m) return m[1];
  // Attribute order can differ — try content before the keyed attribute.
  const re2 = new RegExp(
    `<meta\\s+content=["']([^"']*)["'][^>]*${key}=["']${value}["']`,
    'i',
  );
  const m2 = re2.exec(INDEX);
  return m2 ? m2[1] : '';
}

describe('Open Graph / Twitter meta (index.html)', () => {
  for (const [key, tag, expected] of META) {
    it(`${key}="${tag}" has content "${expected}"`, () => {
      expect(metaContent(key, tag)).toBe(expected);
    });
  }

  it('og:description and name=description are identical', () => {
    expect(metaContent('property', 'og:description')).toBe(
      metaContent('name', 'description'),
    );
  });
});

describe('public/og.png social preview', () => {
  const png = readFileSync('public/og.png');

  it('is a PNG (8-byte magic)', () => {
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect([...png.subarray(0, 8)]).toEqual(magic);
  });

  it('is 1200×630 (IHDR width/height, big-endian bytes 16–23)', () => {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  it('is larger than 50 KB (a blank frame compresses far smaller)', () => {
    expect(png.length).toBeGreaterThan(50_000);
  });
});
