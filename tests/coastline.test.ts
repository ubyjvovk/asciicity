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

  it('joins two open pieces sharing an interior node regardless of array order', () => {
    // A ends where B starts: A = [[0,0.5],[0.5,0.5]] ends at [0.5,0.5],
    // B = [[0.5,0.5],[1,0.5]] starts there. A.concat(B.slice(1)) is one open
    // chain [0,0.5]→[0.5,0.5]→[1,0.5].
    const A: Vec2[] = [
      [0, 0.5],
      [0.5, 0.5],
    ];
    const B: Vec2[] = [
      [0.5, 0.5],
      [1, 0.5],
    ];
    // Pieces [B, A]: B is processed first, then A must prepend BEFORE it.
    const { closed, open } = stitchChains([B, A]);
    expect(closed).toEqual([]);
    expect(open).toEqual([A.concat(B.slice(1))]);
    // Same assertion with [A, B] proves order-independence.
    const { closed: c2, open: o2 } = stitchChains([A, B]);
    expect(c2).toEqual([]);
    expect(o2).toEqual([A.concat(B.slice(1))]);
  });

  it('stitches a three-piece open coast given in the order [middle, last, first]', () => {
    const first: Vec2[] = [
      [0, 0.5],
      [0.33, 0.5],
    ];
    const middle: Vec2[] = [
      [0.33, 0.5],
      [0.66, 0.5],
    ];
    const last: Vec2[] = [
      [0.66, 0.5],
      [1, 0.5],
    ];
    const { closed, open } = stitchChains([middle, last, first]);
    expect(closed).toEqual([]);
    expect(open).toHaveLength(1);
    // One open chain with the first piece's start and the last piece's end.
    expect(open[0][0]).toEqual([0, 0.5]);
    expect(open[0][open[0].length - 1]).toEqual([1, 0.5]);
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

describe('coastline closeCoastline — corner ordering', () => {
  it('walks CW past NW→NE→SE when a chain ends on the west edge', () => {
    // Chain from south edge (0.5, 0) to west edge (0, 0.5): the walk from the
    // end back to the start must cross NW (t=3), NE (t=4) then SE (t=5) — in
    // that order. The naive fixed-order push [SE, SW, NW, NE] emits a bowtie.
    const rings = closeCoastline([[[0.5, 0], [0, 0.5]]], UNIT_BBOX);
    expect(rings).toEqual([
      [
        [0.5, 0],
        [0, 0.5],
        [0, 1], // NW corner
        [1, 1], // NE corner
        [1, 0], // SE corner
      ],
    ]);
  });

  it('walks CW past SW→NW→NE when a chain wraps t=4 from south to east', () => {
    // Chain from east edge (1, 0.7) to south edge (0.5, 0): the walk wraps
    // past t=4, crossing SW (t=2), NW (t=3), NE (t=4) in that order.
    const rings = closeCoastline([[[1, 0.7], [0.5, 0]]], UNIT_BBOX);
    expect(rings).toEqual([
      [
        [1, 0.7],
        [0.5, 0],
        [0, 0], // SW corner
        [0, 1], // NW corner
        [1, 1], // NE corner
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
