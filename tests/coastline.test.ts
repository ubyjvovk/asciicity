/**
 * Unit tests for the coastline pipeline in `scripts/osm-convert.mjs`
 * (data-format.md "Coastline water"). Every fixture uses the unit bbox
 * `[0, 0, 1, 1]` in lat/lon so the expected vertex sequences can be
 * hand-computed — corners included, so orientation bugs cannot hide.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  clipPolylineToBbox,
  closeCoastline,
  convertOverpass,
  signedArea,
  stitchChains,
} from '../scripts/osm-convert';
import type { Vec2 } from '../src/data/types';

const UNIT_BBOX = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

describe('coastline clipPolylineToBbox', () => {
  it('clips a horizontal coast crossing the bbox to one interior piece', () => {
    const pieces = clipPolylineToBbox(
      [
        [-0.1, 0.5],
        [1.1, 0.5],
      ],
      UNIT_BBOX,
    );
    expect(pieces).toEqual([[[0, 0.5], [1, 0.5]]]);
  });

  it('returns an empty array for a polyline entirely outside the bbox', () => {
    expect(
      clipPolylineToBbox(
        [
          [-1, -1],
          [-0.5, -0.5],
        ],
        UNIT_BBOX,
      ),
    ).toEqual([]);
  });

  it('preserves interior vertices between two boundary crossings', () => {
    const pieces = clipPolylineToBbox(
      [
        [-0.1, 0.5],
        [0.5, 0.5],
        [1.1, 0.5],
      ],
      UNIT_BBOX,
    );
    expect(pieces).toEqual([[[0, 0.5], [0.5, 0.5], [1, 0.5]]]);
  });
});

describe('coastline stitchChains', () => {
  it('recognises a closed loop and drops the repeated closing point', () => {
    const pieces: Vec2[][] = [
      [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
        [0.4, 0.4],
      ],
    ];
    const { closed, open } = stitchChains(pieces);
    expect(open).toEqual([]);
    expect(closed).toEqual([
      [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
      ],
    ]);
  });

  it('leaves a single unmatched piece as an open chain', () => {
    const pieces: Vec2[][] = [[[0, 0.5], [1, 0.5]]];
    const { closed, open } = stitchChains(pieces);
    expect(closed).toEqual([]);
    expect(open).toEqual(pieces);
  });

  it('empty input → no chains', () => {
    expect(stitchChains([])).toEqual({ closed: [], open: [] });
  });
});

describe('coastline closeCoastline — coast → southern-band ring', () => {
  it('walks CW from (1,0.5) to (0,0.5), inserting the SE and SW corners', () => {
    const rings = closeCoastline([[[0, 0.5], [1, 0.5]]], UNIT_BBOX);
    expect(rings).toEqual([
      [
        [0, 0.5],
        [1, 0.5],
        [1, 0], // SE corner
        [0, 0], // SW corner
      ],
    ]);
  });
});

describe('coastline closeCoastline — strait → middle-band ring', () => {
  it('closes two opposing coasts into one ring with no corners passed', () => {
    const rings = closeCoastline(
      [
        [[0, 0.7], [1, 0.7]], // upper coast (land north)
        [[1, 0.3], [0, 0.3]], // lower coast (land south)
      ],
      UNIT_BBOX,
    );
    expect(rings).toEqual([
      [
        [0, 0.7],
        [1, 0.7],
        [1, 0.3],
        [0, 0.3],
      ],
    ]);
  });
});

describe('coastline island ring emitted + CCW warning path', () => {
  it('CCW island coast passes through stitchChains as a closed ring with positive signed area', () => {
    // A tiny island square in the middle of the bbox. Walking the ring in
    // this order keeps land (the interior) on the LEFT — the OSM convention.
    const pieces = clipPolylineToBbox(
      [
        [0.4, 0.4],
        [0.6, 0.4],
        [0.6, 0.6],
        [0.4, 0.6],
        [0.4, 0.4],
      ],
      UNIT_BBOX,
    );
    const { closed, open } = stitchChains(pieces);
    expect(open).toEqual([]);
    expect(closed).toHaveLength(1);
    // CCW in a y-up frame ⇒ positive signed area.
    expect(signedArea(closed[0])).toBeGreaterThan(0);
  });

  it('CW island coast triggers the winding warning inside convertOverpass', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Same square, reversed direction — land on the RIGHT, which is the
    // wrong OSM orientation for an island (rule 5).
    convertOverpass(
      {
        elements: [
          {
            type: 'way',
            id: 1,
            tags: { natural: 'coastline' },
            geometry: [
              { lon: 0.4, lat: 0.4 },
              { lon: 0.4, lat: 0.6 },
              { lon: 0.6, lat: 0.6 },
              { lon: 0.6, lat: 0.4 },
              { lon: 0.4, lat: 0.4 },
            ],
          },
        ],
      },
      { origin: { lat: 0.5, lon: 0.5 }, bbox: [0, 0, 1, 1] },
    );
    expect(warn).toHaveBeenCalled();
    const joined = warn.mock.calls.map((c) => c.join(' ')).join(' ');
    expect(joined).toMatch(/coastline/i);
    expect(joined).toMatch(/clockwise/i);
    warn.mockRestore();
  });
});

describe('coastline no-coastline → no rings', () => {
  it('closeCoastline([], bbox) → []', () => {
    expect(closeCoastline([], UNIT_BBOX)).toEqual([]);
  });

  it('convertOverpass with no coastline elements omits the water key', () => {
    const city = convertOverpass(
      { elements: [] },
      { origin: { lat: 0.5, lon: 0.5 }, bbox: [0, 0, 1, 1] },
    );
    expect(city.water).toBeUndefined();
  });
});
