/**
 * Unit tests for `parseArgs` in `scripts/fetch-osm.mjs` — bare `--tiles`,
 * the value forms `--tiles 1` / `--tiles true`, valueless non-boolean flags,
 * and a well-formed full command line. Covers the cases listed in T-0100's
 * acceptance criteria, by name. No network.
 */
import { describe, expect, it } from 'vitest';

import { parseArgs } from '../scripts/fetch-osm';

describe('parseArgs', () => {
  it('bare --tiles before another flag → tiles: true, --out keeps its own value', () => {
    // The T-0097 incident: `--tiles --out public/data/tokyo` used to set
    // tiles='--out' and fall through to DEFAULT_OUT as a monolith.
    expect(parseArgs(['--tiles', '--out', 'public/data/tokyo'])).toEqual({
      tiles: true,
      out: 'public/data/tokyo',
    });
  });

  it('bare --tiles as the last arg → tiles: true', () => {
    expect(parseArgs(['--out', 'public/data/tokyo', '--tiles'])).toEqual({
      out: 'public/data/tokyo',
      tiles: true,
    });
    expect(parseArgs(['--tiles'])).toEqual({ tiles: true });
  });

  it('--tiles 1 / --tiles true unchanged', () => {
    expect(parseArgs(['--tiles', '1', '--out', 'public/data/tokyo'])).toEqual({
      tiles: '1',
      out: 'public/data/tokyo',
    });
    expect(parseArgs(['--tiles', 'true', '--out', 'public/data/tokyo'])).toEqual(
      {
        tiles: 'true',
        out: 'public/data/tokyo',
      },
    );
  });

  it('a valueless non-boolean flag (e.g. --bbox --out x) throws/exits non-zero with a message naming the flag', () => {
    expect(() => parseArgs(['--bbox', '--out', 'x'])).toThrow(
      /unknown or valueless flag --bbox/,
    );
    expect(() => parseArgs(['--out'])).toThrow(
      /unknown or valueless flag --out/,
    );
  });

  it('a well-formed full command line parses to the same result as before the fix', () => {
    // Tokyo fetch (docs/data-format.md "Central Tokyo" / npm run fetch-data:tokyo).
    expect(
      parseArgs([
        '--bbox',
        '139.730,35.645,139.820,35.715',
        '--origin',
        '139.7671,35.6812',
        '--lang',
        'en',
        '--dem',
        '1',
        '--chunks',
        '3x3',
        '--tiles',
        '1',
        '--out',
        'public/data/tokyo',
      ]),
    ).toEqual({
      bbox: '139.730,35.645,139.820,35.715',
      origin: '139.7671,35.6812',
      lang: 'en',
      dem: '1',
      chunks: '3x3',
      tiles: '1',
      out: 'public/data/tokyo',
    });
  });
});
