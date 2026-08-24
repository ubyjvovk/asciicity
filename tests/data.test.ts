/**
 * Unit tests for the data layer: validator, synthetic city and loader
 * (`src/data/validate.ts`, `src/data/synthetic.ts`, `src/data/load.ts`).
 */
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
