/**
 * Unit tests for the data layer: validator, synthetic city and loader
 * (`src/data/validate.ts`, `src/data/synthetic.ts`, `src/data/load.ts`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCity } from '../src/data/validate';
import { mulberry32, syntheticCity } from '../src/data/synthetic';
import { loadCity } from '../src/data/load';

/** Deep copy of a valid synthetic city for mutation in checks. */
function base(): ReturnType<typeof syntheticCity> {
  return structuredClone(syntheticCity(1, 3));
}

describe('validateCity', () => {
  it('returns the input object unchanged when valid', () => {
    const c = syntheticCity(1, 3);
    expect(validateCity(c)).toBe(c);
  });

  it('rejects a missing version with a message containing "v"', () => {
    const c = base();
    delete (c as { v?: unknown }).v;
    expect(() => validateCity(c)).toThrow(/v/);
  });

  it('rejects v: 2 with a message containing "v"', () => {
    const c = base() as unknown as { v: number };
    c.v = 2;
    expect(() => validateCity(c)).toThrow(/v/);
  });

  it('rejects a polygon with 2 points, naming buildings[i].poly', () => {
    const c = base();
    c.buildings[0].poly = [
      [0, 0],
      [1, 0],
    ];
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.poly/);
  });

  it('rejects a NaN coordinate, naming buildings[i].poly', () => {
    const c = base();
    c.buildings[0].poly[0][1] = NaN;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.poly/);
  });

  it('rejects an unknown road class, naming roads[i].cls', () => {
    const c = base();
    (c.roads[0] as { cls: string }).cls = 'motorway';
    expect(() => validateCity(c)).toThrow(/roads\[0\]\.cls/);
  });

  it('rejects a duplicate building id, naming buildings[i].id', () => {
    const c = base();
    c.buildings[1].id = c.buildings[0].id;
    expect(() => validateCity(c)).toThrow(/buildings\[1\]\.id/);
  });

  it('rejects a building height of 400, naming buildings[i].h', () => {
    const c = base();
    c.buildings[0].h = 400;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.h/);
  });

  it('rejects a road with 1 point, naming roads[i].pts', () => {
    const c = base();
    c.roads[0].pts = [[0, 0]];
    expect(() => validateCity(c)).toThrow(/roads\[0\]\.pts/);
  });

  it('accepts an optional boolean road bridge flag', () => {
    const c = base();
    c.roads[0].bridge = true;
    expect(() => validateCity(c)).not.toThrow();
    c.roads[0].bridge = false;
    expect(() => validateCity(c)).not.toThrow();
  });

  it('rejects a non-boolean road bridge flag, naming roads[i].bridge', () => {
    const c = base();
    (c.roads[0] as { bridge?: unknown }).bridge = 'yes';
    expect(() => validateCity(c)).toThrow(/roads\[0\]\.bridge/);
  });

  it('rejects a place with an empty name, naming places[i].name', () => {
    const c = base();
    c.places[0].name = '';
    expect(() => validateCity(c)).toThrow(/places\[0\]\.name/);
  });

  it('accepts an optional valid water ring', () => {
    const c = base();
    c.water = [
      [
        [0, 0],
        [10, 0],
        [5, 8],
      ],
    ];
    expect(() => validateCity(c)).not.toThrow();
  });

  it('rejects a 2-point water ring, naming water[0]', () => {
    const c = base();
    c.water = [
      [
        [0, 0],
        [1, 1],
      ],
    ];
    expect(() => validateCity(c)).toThrow(/water\[0\]/);
  });

  it('accepts an optional valid 2-point river polyline', () => {
    const c = base();
    c.rivers = [
      [
        [0, 0],
        [100, 0],
      ],
    ];
    expect(() => validateCity(c)).not.toThrow();
  });

  it('rejects a 1-point river polyline, naming rivers[0]', () => {
    const c = base();
    c.rivers = [[[0, 0]]];
    expect(() => validateCity(c)).toThrow(/rivers\[0\]/);
  });

  it('rejects a NaN coordinate in a river, naming rivers[0]', () => {
    const c = base();
    c.rivers = [
      [
        [0, 0],
        [NaN, 0],
      ],
    ];
    expect(() => validateCity(c)).toThrow(/rivers\[0\]/);
  });

  it('accepts a valid 2x2 terrain', () => {
    const c = base();
    c.terrain = { x0: -10, z0: -10, step: 20, cols: 2, rows: 2, datum: 0, heights: [0, 1, 2, 3] };
    expect(() => validateCity(c)).not.toThrow();
  });

  it('rejects a terrain heights array of the wrong length, naming terrain.heights', () => {
    const c = base();
    c.terrain = { x0: -10, z0: -10, step: 20, cols: 2, rows: 2, datum: 0, heights: [0, 1, 2] };
    expect(() => validateCity(c)).toThrow(/terrain\.heights/);
  });

  it('rejects a non-array terrain heights, naming terrain.heights', () => {
    const c = base() as unknown as {
      terrain?: Record<string, unknown>;
    };
    c.terrain = { x0: -10, z0: -10, step: 20, cols: 2, rows: 2, datum: 0, heights: 'x' };
    expect(() => validateCity(c)).toThrow(/terrain\.heights/);
  });

  it('rejects terrain step: 0, naming terrain.step', () => {
    const c = base();
    c.terrain = { x0: -10, z0: -10, step: 0, cols: 2, rows: 2, datum: 0, heights: [0, 1, 2, 3] };
    expect(() => validateCity(c)).toThrow(/terrain\.step/);
  });

  it('rejects terrain cols: 1, naming terrain.cols', () => {
    const c = base();
    c.terrain = { x0: -10, z0: -10, step: 20, cols: 1, rows: 2, datum: 0, heights: [0, 1] };
    expect(() => validateCity(c)).toThrow(/terrain\.cols/);
  });

  it('rejects terrain cols: 2.5, naming terrain.cols', () => {
    const c = base();
    c.terrain = { x0: -10, z0: -10, step: 20, cols: 2.5, rows: 2, datum: 0, heights: [0, 1, 2, 3, 4] };
    expect(() => validateCity(c)).toThrow(/terrain\.cols/);
  });

  it('rejects a NaN terrain height, naming terrain.heights[3]', () => {
    const c = base();
    c.terrain = { x0: -10, z0: -10, step: 20, cols: 2, rows: 2, datum: 0, heights: [0, 1, 2, NaN] };
    expect(() => validateCity(c)).toThrow(/terrain\.heights\[3\]/);
  });

  it('rejects a non-finite terrain datum, naming terrain.datum', () => {
    const c = base();
    c.terrain = { x0: -10, z0: -10, step: 20, cols: 2, rows: 2, datum: Infinity, heights: [0, 1, 2, 3] };
    expect(() => validateCity(c)).toThrow(/terrain\.datum/);
  });

  it('accepts waterLevels of the same length as water', () => {
    const c = base();
    c.water = [
      [
        [0, 0],
        [10, 0],
        [5, 8],
      ],
    ];
    c.waterLevels = [-2.5];
    expect(() => validateCity(c)).not.toThrow();
  });

  it('rejects waterLevels of a different length from water, naming waterLevels', () => {
    const c = base();
    c.water = [
      [
        [0, 0],
        [10, 0],
        [5, 8],
      ],
    ];
    c.waterLevels = [-2.5, 0];
    expect(() => validateCity(c)).toThrow(/waterLevels/);
  });

  it('rejects waterLevels present without water, naming waterLevels', () => {
    const c = base();
    c.waterLevels = [-2.5];
    expect(() => validateCity(c)).toThrow(/waterLevels/);
  });

  it('rejects a non-finite waterLevels entry, naming waterLevels[0]', () => {
    const c = base();
    c.water = [
      [
        [0, 0],
        [10, 0],
        [5, 8],
      ],
    ];
    c.waterLevels = [NaN];
    expect(() => validateCity(c)).toThrow(/waterLevels\[0\]/);
  });

  it('validates a city with neither terrain nor waterLevels', () => {
    expect(() => validateCity(base())).not.toThrow();
  });
});

describe('syntheticCity', () => {
  it('is deterministic: identical JSON for the same seed, different for seed 2', () => {
    expect(JSON.stringify(syntheticCity(1, 12))).toBe(
      JSON.stringify(syntheticCity(1, 12)),
    );
    expect(JSON.stringify(syntheticCity(1, 12))).not.toBe(
      JSON.stringify(syntheticCity(2, 12)),
    );
  });

  it('produces blocks*blocks buildings, 2*(blocks+1) roads and 1 place', () => {
    const c = syntheticCity(1, 12);
    expect(c.buildings).toHaveLength(12 * 12);
    expect(c.roads).toHaveLength(2 * (12 + 1));
    expect(c.places).toHaveLength(1);
  });

  it('names every 5th building "Block <i>"', () => {
    const c = syntheticCity(1, 12);
    c.buildings.forEach((b, i) => {
      if (i % 5 === 0) {
        expect(b.name).toBe(`Block ${i}`);
      } else {
        expect(b.name).toBeUndefined();
      }
    });
  });

  it('mulberry32 is deterministic and bounded to [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 20; i++) {
      const va = a();
      expect(va).toBe(b());
      expect(va).toBeGreaterThanOrEqual(0);
      expect(va).toBeLessThan(1);
    }
  });

  it('hills = false has no terrain key and no waterLevels', () => {
    expect(syntheticCity(1, 12).terrain).toBeUndefined();
    expect(syntheticCity(1, 12).waterLevels).toBeUndefined();
  });

  it('hills = true yields step 20 with heights.length === cols*rows', () => {
    const t = syntheticCity(1, 12, true).terrain!;
    expect(t.step).toBe(20);
    expect(t.datum).toBe(0);
    expect(t.heights).toHaveLength(t.cols * t.rows);
  });

  it('hills = true grid bounds enclose +/- (blocks*74/2) with one cell of margin', () => {
    const blocks = 12;
    const t = syntheticCity(1, blocks, true).terrain!;
    const extent = (blocks * 74) / 2;
    const minNodeX = t.x0;
    const maxNodeX = t.x0 + (t.cols - 1) * t.step;
    const minNodeZ = t.z0;
    const maxNodeZ = t.z0 + (t.rows - 1) * t.step;
    expect(minNodeX).toBeLessThanOrEqual(-extent - t.step);
    expect(maxNodeX).toBeGreaterThanOrEqual(extent + t.step);
    expect(minNodeZ).toBeLessThanOrEqual(-extent - t.step);
    expect(maxNodeZ).toBeGreaterThanOrEqual(extent + t.step);
  });

  it('hills = true node nearest the origin matches the formula within 0.1', () => {
    const t = syntheticCity(1, 12, true).terrain!;
    const c = Math.round((0 - t.x0) / t.step);
    const r = Math.round((0 - t.z0) / t.step);
    const x = t.x0 + c * t.step;
    const z = t.z0 + r * t.step;
    const h =
      30 * Math.exp(-((x - 200) ** 2 + (z + 150) ** 2) / (2 * 220 ** 2)) +
      z / 200;
    expect(t.heights[r * t.cols + c]).toBeCloseTo(h, 1);
  });

  it('hills = true every height is a multiple of 0.1', () => {
    const heights = syntheticCity(1, 12, true).terrain!.heights;
    heights.forEach((v) => {
      expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-9);
    });
  });

  it('hills = true is deterministic: two calls are deep-equal', () => {
    expect(syntheticCity(1, 12, true)).toEqual(syntheticCity(1, 12, true));
  });

  it('hills = true validates', () => {
    expect(() => validateCity(syntheticCity(1, 12, true))).not.toThrow();
  });
});

describe('committed public/data/kyiv.json', () => {
  const raw = readFileSync(resolve(__dirname, '../public/data/kyiv.json'), 'utf8');
  const city = JSON.parse(raw);

  it('validates with no throw', () => {
    expect(() => validateCity(city)).not.toThrow();
  });

  it('has the central-Kyiv bbox and Maidan origin', () => {
    expect(city.bbox).toEqual([30.495, 50.422, 30.585, 50.47]);
    expect(city.origin.lat).toBeCloseTo(50.4501, 5);
    expect(city.origin.lon).toBeCloseTo(30.5234, 5);
  });

  it('includes the two cycleway bridges (Parkovyi + Klitschko) as pedestrian + bridge: true', () => {
    // T-0047: both are `highway=cycleway` + `bridge=yes`, so they are dropped
    // as roads but emitted as pedestrian bridges. Their OSM way ids:
    // 163254636 (Parkovyi, ~430 m) and 660559170 (Klitschko "glass", ~210 m).
    const roads = city.roads as Array<{
      id: number;
      cls: string;
      bridge?: boolean;
      pts: number[][];
    }>;
    const byId = new Map(roads.map((r) => [r.id, r] as const));
    for (const id of [163254636, 660559170]) {
      const r = byId.get(id);
      expect(r, `bridge way ${id} present`).toBeDefined();
      if (!r) continue; // narrows `unknown`/`undefined` after toBeDefined
      expect(r.cls).toBe('pedestrian');
      expect(r.bridge).toBe(true);
      expect(r.pts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('carries a terrain grid with a Kyiv-plausible datum (150–165 m ASL)', () => {
    expect(city.terrain).toBeDefined();
    const t = city.terrain;
    expect(t.step).toBe(20);
    expect(t.datum).toBeGreaterThanOrEqual(150);
    expect(t.datum).toBeLessThanOrEqual(165);
    expect(t.heights).toHaveLength(t.cols * t.rows);
  });

  it('waterLevels has one entry per water ring', () => {
    expect(Array.isArray(city.water)).toBe(true);
    expect(city.water.length).toBeGreaterThan(0);
    expect(city.waterLevels).toHaveLength(city.water.length);
    for (const lvl of city.waterLevels) {
      expect(Number.isFinite(lvl)).toBe(true);
    }
  });

  it('every terrain height is within ±150 of 0', () => {
    for (const h of city.terrain.heights) {
      expect(h).toBeGreaterThanOrEqual(-150);
      expect(h).toBeLessThanOrEqual(150);
    }
  });

  it('file size is under 10 MB', () => {
    expect(raw.length).toBeLessThan(10 * 1024 * 1024);
  });
});

describe('loadCity', () => {
  it('resolves to validated data for an ok response', async () => {
    const data = syntheticCity(1, 3);
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => data,
    })) as unknown as typeof fetch;
    await expect(loadCity('anything', fetchImpl)).resolves.toBe(data);
  });

  it('rejects with a message containing 404 for a non-ok response', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(loadCity('anything', fetchImpl)).rejects.toThrow(/404/);
  });
});
