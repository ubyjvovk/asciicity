/**
 * Unit tests for `scripts/dem.mjs` — SRTM tile naming/download, HGT decoding,
 * the void-aware bilinear `Dem`, the `unproject` inverse, `buildTerrain`
 * (grid + water flattening) and `fetchDemTiles` caching. Covers the cases
 * listed in T-0039's acceptance criteria, by name.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

import {
  buildTerrain,
  decodeHgt,
  Dem,
  fetchDemTiles,
  hgtTileName,
  hgtUrl,
  unproject,
} from '../scripts/dem';
import { project } from '../scripts/osm-convert';

const KYIV_BBOX: [number, number, number, number] = [
  30.495,
  50.422,
  30.585,
  50.47,
];
const KYIV_ORIGIN = { lat: 50.4501, lon: 30.5234 };

/** A `Dem` over one decoded 3×3 tile covering lat 50–51, lon 30–31. */
function tileDem(values: number[]) {
  const samples = new Int16Array(9);
  values.forEach((v, i) => (samples[i] = v));
  return new Dem(new Map([[hgtTileName(50.5, 30.5), { side: 3, samples }]]));
}

describe('dem tile naming', () => {
  it('hgtTileName (50.45, 30.52) → N50E030', () => {
    expect(hgtTileName(50.45, 30.52)).toBe('N50E030');
  });

  it('hgtTileName (51.51, -0.09) → N51W001', () => {
    expect(hgtTileName(51.51, -0.09)).toBe('N51W001');
  });

  it('hgtTileName (-33.9, 151.2) → S34E151', () => {
    expect(hgtTileName(-33.9, 151.2)).toBe('S34E151');
  });

  it('hgtUrl builds the skadi URL including the lat directory', () => {
    expect(hgtUrl('N50E030')).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/skadi/N50/N50E030.hgt.gz',
    );
  });
});

describe('dem decodeHgt', () => {
  it('decodes a hand-built 3×3 big-endian buffer, preserving a void', () => {
    const vals = [1, 2, 3, 4, -32768, 6, 7, 8, 9];
    const buf = Buffer.alloc(18);
    vals.forEach((v, i) => buf.writeInt16BE(v, i * 2));
    const { side, samples } = decodeHgt(buf);
    expect(side).toBe(3);
    samples.forEach((s, i) => expect(s).toBe(vals[i]));
  });

  it('throws on a non-square (non-integer side) buffer length', () => {
    const buf = Buffer.alloc(10); // sqrt(5) not an integer
    expect(() => decodeHgt(buf)).toThrow(/square/);
  });

  it('throws when the side would be < 2', () => {
    const buf = Buffer.alloc(2); // side == 1
    expect(() => decodeHgt(buf)).toThrow(/square/);
  });
});

describe('dem Dem.elevationAt', () => {
  it('returns the exact value at a sample point', () => {
    // Point (50.5, 30.5) maps to row 1, col 1 (the centre sample).
    const dem = tileDem([0, 0, 0, 0, 123, 0, 0, 0, 0]);
    expect(dem.elevationAt(50.5, 30.5)).toBeCloseTo(123, 10);
  });

  it('bilinearly interpolates at a midpoint between four samples', () => {
    // Point (50.75, 30.25) → row 0.5, col 0.5 over the top-left four cells.
    const dem = tileDem([10, 20, 0, 30, 40, 0, 0, 0, 0]);
    expect(dem.elevationAt(50.75, 30.25)).toBeCloseTo(25, 10);
  });

  it('treats row 0 as the north edge (top row 100, bottom 0)', () => {
    // Top row (row 0 = north) all 100, everything else 0; a point just below
    // lat+1 (= just north of the tile) must read ≈ 100.
    const dem = tileDem([100, 100, 100, 0, 0, 0, 0, 0, 0]);
    expect(dem.elevationAt(50.999, 30.5)).toBeCloseTo(100, 0);
  });

  it('replaces a void corner with the mean of the other three and counts it', () => {
    // Corners 10, 20, 30 and one void ⇒ void becomes (10+20+30)/3 = 20.
    const dem = tileDem([10, 20, 0, 30, -32768, 0, 0, 0, 0]);
    expect(dem.elevationAt(50.75, 30.25)).toBeCloseTo(20, 10);
    expect(dem.voids).toBe(1);
  });

  it('throws naming the missing tile', () => {
    const dem = tileDem([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => dem.elevationAt(10.5, 10.5)).toThrow(/N10E010/);
  });
});

describe('dem unproject', () => {
  it('round-trips project(lon, lat) back to the same lon/lat (1e-6)', () => {
    const lon = 30.5234;
    const lat = 50.4501;
    const [x, z] = project(lon, lat, KYIV_ORIGIN);
    const [lon2, lat2] = unproject(x, z, KYIV_ORIGIN);
    expect(lon2).toBeCloseTo(lon, 6);
    expect(lat2).toBeCloseTo(lat, 6);
  });

  it('round-trips an off-origin point (1e-6)', () => {
    const lon = 30.55;
    const lat = 50.44;
    const [x, z] = project(lon, lat, KYIV_ORIGIN);
    const [lon2, lat2] = unproject(x, z, KYIV_ORIGIN);
    expect(lon2).toBeCloseTo(lon, 6);
    expect(lat2).toBeCloseTo(lat, 6);
  });
});

describe('dem buildTerrain', () => {
  // Stub DEM: elevation = lat·1000, so row 0 (north = smallest z) is highest.
  const stub = {
    elevationAt: (lat: number, _lon: number) => lat * 1000,
  };

  it('matches the data-format grid formula for the Kyiv bbox and origin', () => {
    const { terrain } = buildTerrain({
      bbox: KYIV_BBOX,
      origin: KYIV_ORIGIN,
      dem: stub,
    });
    expect(terrain.x0).toBe(-2040);
    expect(terrain.z0).toBe(-2240);
    expect(terrain.cols).toBe(323);
    expect(terrain.rows).toBe(270);
    expect(terrain.step).toBe(20);
  });

  it('produces cols·rows heights rounded to 0.1 relative to datum', () => {
    const { terrain } = buildTerrain({
      bbox: KYIV_BBOX,
      origin: KYIV_ORIGIN,
      dem: stub,
    });
    expect(terrain.heights.length).toBe(terrain.cols * terrain.rows);
    const datum = terrain.datum;
    expect(datum).toBeCloseTo(Math.round(50.4501 * 1000 * 10) / 10, 10);
    for (const h of terrain.heights) {
      expect(Math.abs(h * 10 - Math.round(h * 10))).toBeLessThan(1e-6); // 0.1 m
    }
    // Relative to datum: the north-west corner node's signed offset matches
    // the stub elevation at that node minus datum.
    const [lon0, lat0] = unproject(terrain.x0, terrain.z0, KYIV_ORIGIN);
    const expected0 = Math.round((stub.elevationAt(lat0, lon0) - datum) * 10) / 10;
    expect(terrain.heights[0]).toBeCloseTo(expected0, 5);
  });

  it('row 0 is the north edge and holds the largest (stub) values', () => {
    const { terrain } = buildTerrain({
      bbox: KYIV_BBOX,
      origin: KYIV_ORIGIN,
      dem: stub,
    });
    const max = Math.max(...terrain.heights);
    expect(terrain.heights[0]).toBe(max);
  });

  it('flattens exactly the nodes inside a square ring to its 10th-percentile level', () => {
    const ring: [number, number][] = [
      [-400, -400],
      [400, -400],
      [400, 400],
      [-400, 400],
    ];
    const { terrain, waterLevels } = buildTerrain({
      bbox: KYIV_BBOX,
      origin: KYIV_ORIGIN,
      dem: stub,
      waterRings: [ring],
    });
    expect(waterLevels.length).toBe(1);
    // 10th percentile of the raw (minus-datum) vertex samples: n=4 → sorted[0].
    const raws = ring.map(([x, z]) => {
      const [lon, lat] = unproject(x, z, KYIV_ORIGIN);
      return stub.elevationAt(lat, lon) - terrain.datum;
    });
    const expectedLevel = Math.round(Math.min(...raws) * 10) / 10;
    expect(waterLevels[0]).toBeCloseTo(expectedLevel, 5);

    for (let r = 0; r < terrain.rows; r++) {
      for (let c = 0; c < terrain.cols; c++) {
        const x = terrain.x0 + c * terrain.step;
        const z = terrain.z0 + r * terrain.step;
        const idx = r * terrain.cols + c;
        const inside =
          Math.abs(x) < 400 && Math.abs(z) < 400; // strictly inside the square
        if (inside) {
          expect(terrain.heights[idx]).toBeCloseTo(waterLevels[0], 5);
        } else if (Math.abs(x) > 400 || Math.abs(z) > 400) {
          // Untouched nodes keep their un-flattened computed height.
          const [lon, lat] = unproject(x, z, KYIV_ORIGIN);
          const expected =
            Math.round((stub.elevationAt(lat, lon) - terrain.datum) * 10) / 10;
          expect(terrain.heights[idx]).toBeCloseTo(expected, 5);
        }
      }
    }
  });

  it('regression: two disjoint (non-nested) rings still flatten independently, matching the pre-parity rule', () => {
    // Two square rings that do not overlap: no grid node is inside both, so
    // odd-parity flattening must reproduce the old "inside any ring wins"
    // behaviour byte-for-byte (data-format.md "Coastline water" rule 6:
    // "existing datasets have no nested rings, so ... terrain output is
    // byte-identical").
    const ringA: [number, number][] = [
      [-400, -400],
      [-200, -400],
      [-200, -200],
      [-400, -200],
    ];
    const ringB: [number, number][] = [
      [200, 200],
      [400, 200],
      [400, 400],
      [200, 400],
    ];
    const { terrain, waterLevels } = buildTerrain({
      bbox: KYIV_BBOX,
      origin: KYIV_ORIGIN,
      dem: stub,
      waterRings: [ringA, ringB],
    });
    expect(waterLevels).toHaveLength(2);

    const nodeAt = (x: number, z: number) => {
      const c = Math.round((x - terrain.x0) / terrain.step);
      const r = Math.round((z - terrain.z0) / terrain.step);
      return { c, r, idx: r * terrain.cols + c };
    };

    // Node strictly inside ring A — flattened to waterLevels[0].
    const inA = nodeAt(-300, -300);
    expect(terrain.heights[inA.idx]).toBeCloseTo(waterLevels[0], 5);
    // Node strictly inside ring B — flattened to waterLevels[1].
    const inB = nodeAt(300, 300);
    expect(terrain.heights[inB.idx]).toBeCloseTo(waterLevels[1], 5);
    // Node between rings — un-flattened, keeps its computed height.
    const between = nodeAt(0, 0);
    const [lonBetween, latBetween] = unproject(0, 0, KYIV_ORIGIN);
    const expected =
      Math.round((stub.elevationAt(latBetween, lonBetween) - terrain.datum) * 10) /
      10;
    expect(terrain.heights[between.idx]).toBeCloseTo(expected, 5);
  });

  it('parity: bay node flattened, island node NOT flattened (nested rings)', () => {
    // Outer bay ring — water — and a smaller island ring nested inside it.
    // Rule 6: a node inside an ODD number of rings is flattened; inside both
    // (parity 2 = even) it keeps its raw terrain height.
    const bay: [number, number][] = [
      [-400, -400],
      [400, -400],
      [400, 400],
      [-400, 400],
    ];
    const island: [number, number][] = [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
    ];
    const { terrain, waterLevels } = buildTerrain({
      bbox: KYIV_BBOX,
      origin: KYIV_ORIGIN,
      dem: stub,
      waterRings: [bay, island],
    });
    expect(waterLevels).toHaveLength(2);
    // The two rings sit at genuinely different heights (stub varies with lat),
    // so the "old rule = flatten to last ring" and "new parity rule = leave
    // alone" answers are distinguishable numerically.
    expect(waterLevels[0]).not.toBeCloseTo(waterLevels[1], 3);

    const nodeAt = (x: number, z: number) => {
      const c = Math.round((x - terrain.x0) / terrain.step);
      const r = Math.round((z - terrain.z0) / terrain.step);
      return r * terrain.cols + c;
    };

    // Node inside the bay only — parity 1, flattened to the bay level.
    const bayIdx = nodeAt(200, 200);
    expect(terrain.heights[bayIdx]).toBeCloseTo(waterLevels[0], 5);

    // Node inside BOTH bay and island — parity 2 (even), NOT flattened.
    const islandIdx = nodeAt(0, 0);
    const [lon, lat] = unproject(0, 0, KYIV_ORIGIN);
    const expected =
      Math.round((stub.elevationAt(lat, lon) - terrain.datum) * 10) / 10;
    expect(terrain.heights[islandIdx]).toBeCloseTo(expected, 5);
    // Distinct from either water level (island level, old rule; bay level).
    expect(terrain.heights[islandIdx]).not.toBeCloseTo(waterLevels[0], 3);
    expect(terrain.heights[islandIdx]).not.toBeCloseTo(waterLevels[1], 3);
  });

  it('keeps waterLevels length equal to the number of rings', () => {
    const squares: [number, number][][] = [
      [
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
      ],
      [
        [1000, 1000],
        [1100, 1000],
        [1100, 1100],
        [1000, 1100],
      ],
    ];
    const { waterLevels } = buildTerrain({
      bbox: KYIV_BBOX,
      origin: KYIV_ORIGIN,
      dem: stub,
      waterRings: squares,
    });
    expect(waterLevels.length).toBe(2);
  });
});

describe('dem fetchDemTiles caching', () => {
  it('fetches and writes the cache on first call, reuses it on the second', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dem-test-'));
    try {
      // A valid 2×2 HGT tile (8 bytes) covering lat 50–51 / lon 30–31.
      const raw = Buffer.alloc(8);
      [100, 101, 102, 103].forEach((v, i) => raw.writeInt16BE(v, i * 2));
      const gz = gzipSync(raw);
      const fetchImpl = vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
        url,
      }));

      const bbox: [number, number, number, number] = [30.5, 50.5, 30.6, 50.6];
      await fetchDemTiles(bbox, { cacheDir: dir, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toContain('/N50/N50E030.hgt.gz');
      expect(existsSync(join(dir, 'N50E030.hgt.gz'))).toBe(true);

      const dem = await fetchDemTiles(bbox, { cacheDir: dir, fetchImpl });
      expect(fetchImpl).toHaveBeenCalledTimes(1); // no second network call
      expect(dem.elevationAt(50.5, 30.5)).toBeCloseTo(101.5, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
