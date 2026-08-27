/**
 * Unit tests for landmark fixes / extra buildings (`src/world/landmarks.ts`)
 * and their palette integration (docs/architecture.md §4.13).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Building, CityData } from '../src/data/types';
import { project } from '../src/geo';
import { applyLandmarks, LANDMARK_FIXES } from '../src/world/landmarks';
import { colorFor } from '../src/world/palette';

const KYIV: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'kyiv.json'), 'utf8'),
);
const LONDON: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'city.json'), 'utf8'),
);

function byName(buildings: Building[]): Record<string, Building> {
  const out: Record<string, Building> = {};
  for (const b of buildings) {
    if (b.name !== undefined) out[b.name] = b;
  }
  return out;
}

describe('LANDMARK_FIXES', () => {
  it('the Kyiv and London tables are non-empty and carry the §4.13 shapes', () => {
    expect(Object.keys(LANDMARK_FIXES.kyiv).length).toBeGreaterThan(0);
    expect(Object.keys(LANDMARK_FIXES.london).length).toBeGreaterThan(0);
    expect(LANDMARK_FIXES.kyiv['Saint Sophia Cathedral'].shape).toBe('dome');
    expect(LANDMARK_FIXES.kyiv['Bell tower'].shape).toBe('spire');
    expect(LANDMARK_FIXES.london["St Paul's Cathedral"].shape).toBe('dome');
    expect(LANDMARK_FIXES.london['Elizabeth Tower'].shape).toBe('spire');
    expect(LANDMARK_FIXES.london["Nelson's Column"].h).toBe(6);
    expect(LANDMARK_FIXES.london["Nelson's Column"].label).toBe('Trafalgar Square');
  });
});

describe('applyLandmarks (Kyiv)', () => {
  it('Kyiv fixes carry the §4.13 shapes onto the buildings (dome/spire)', () => {
    const city = applyLandmarks(KYIV, 'kyiv');
    const names = byName(city.buildings);
    expect(names['Saint Sophia Cathedral'].shape).toBe('dome');
    expect(names['St. Michael Golden-Domed Cathedral'].shape).toBe('dome');
    expect(names["St. Volodymyr's Cathedral"].shape).toBe('dome');
    expect(names['St. Nicholas Cathedral'].shape).toBe('dome');
    expect(names['Bell tower'].shape).toBe('spire');
    expect(names['Great Lavra Belltower'].shape).toBe('spire');
    expect(names["Near Cave's Belltower"].shape).toBe('spire');
    expect(names['Bell Tower of Far Caves'].shape).toBe('spire');
    expect(names["Saint Andrew's Church"].shape).toBe('spire');
    // Non-shaped buildings are untouched.
    expect(names['Golden Gate'].shape).toBeUndefined();
    expect(names['Verkhovna Rada of Ukraine'].shape).toBeUndefined();
  });

  it('the Motherland Monument extra is a tower', () => {
    const city = applyLandmarks(KYIV, 'kyiv');
    const extra = city.buildings.find((b) => b.name === 'Motherland Monument');
    expect(extra).toBeDefined();
    expect(extra!.shape).toBe('tower');
  });

  it('sets Saint Sophia Cathedral to 29 and Great Lavra Belltower to 96', () => {
    const city = applyLandmarks(KYIV, 'kyiv');
    const names = byName(city.buildings);
    expect(names['Saint Sophia Cathedral'].h).toBe(29);
    expect(names['Great Lavra Belltower'].h).toBe(96);
  });

  it('appends exactly one extra building named Motherland Monument with a 4-point side-20 square within 1 m of the projected point and id ≤ −1000', () => {
    const city = applyLandmarks(KYIV, 'kyiv');
    const extra = city.buildings.find((b) => b.name === 'Motherland Monument');
    expect(extra).toBeDefined();
    expect(extra!.poly).toHaveLength(4);
    // Square of side 20 → each edge 20, corners meet perpendicularly.
    const [a, b, c, d] = extra!.poly;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(20);
    expect(Math.hypot(b[0] - c[0], b[1] - c[1])).toBeCloseTo(20);
    expect(Math.hypot(c[0] - d[0], c[1] - d[1])).toBeCloseTo(20);
    expect(Math.hypot(d[0] - a[0], d[1] - a[1])).toBeCloseTo(20);
    // Centroid is within 1 m of the projected WGS84 point (30.5632, 50.4266).
    const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
    const cz = (a[1] + b[1] + c[1] + d[1]) / 4;
    const [px, pz] = project(30.5632, 50.4266, KYIV.origin);
    expect(Math.hypot(cx - px, cz - pz)).toBeLessThan(1);
    expect(extra!.id).toBeLessThanOrEqual(-1000);
  });

  it('leaves the building count + 1 and every other height unchanged', () => {
    const city = applyLandmarks(KYIV, 'kyiv');
    expect(city.buildings.length).toBe(KYIV.buildings.length + 1);
    // Only the fix-table heights may change; every other height is untouched.
    const changed = new Set(
      Object.entries(LANDMARK_FIXES.kyiv)
        .filter(([, f]) => f.h !== undefined)
        .map(([n]) => n),
    );
    for (const b of KYIV.buildings) {
      if (b.name !== undefined && changed.has(b.name)) continue;
      const fixed = city.buildings.find((f) => f.id === b.id);
      expect(fixed).toBeDefined();
      expect(fixed!.h).toBe(b.h);
    }
  });

  it('is idempotent — applying twice adds no second monument', () => {
    const once = applyLandmarks(KYIV, 'kyiv');
    const twice = applyLandmarks(once, 'kyiv');
    expect(twice.buildings.filter((b) => b.name === 'Motherland Monument')).toHaveLength(1);
    expect(twice.buildings.length).toBe(KYIV.buildings.length + 1);
  });

  it('colorFor of the fixed Saint Sophia Cathedral is gold', () => {
    const city = applyLandmarks(KYIV, 'kyiv');
    const sophia = city.buildings.find((b) => b.name === 'Saint Sophia Cathedral')!;
    expect(colorFor(sophia)).toBe(0xf7dc6f);
  });

  it('colorFor of the Motherland Monument extra is silver (0xc0c0c0), not the id palette', () => {
    // The extra has a negative id; its colour must come from the registered
    // extras map (registered by applyLandmarks) and not bypass it via
    // `LANDMARK_PALETTE[id % 4]`.
    const city = applyLandmarks(KYIV, 'kyiv');
    const mom = city.buildings.find((b) => b.name === 'Motherland Monument')!;
    expect(mom.id).toBeLessThanOrEqual(-1000);
    expect(colorFor(mom)).toBe(0xc0c0c0);
  });
});

describe('applyLandmarks (London / synthetic)', () => {
  it('adds shape-only fixes to St Paul\'s (dome) and Elizabeth Tower (spire) with those heights unchanged', () => {
    const city = applyLandmarks(LONDON, 'london');
    const names = byName(city.buildings);
    expect(names["St Paul's Cathedral"].shape).toBe('dome');
    expect(names['Elizabeth Tower'].shape).toBe('spire');
    // Shape-only fixes: St Paul's / Elizabeth Tower heights are untouched.
    // Building count grows by the Nelson's Column extra (covered below).
    expect(names["St Paul's Cathedral"].h).toBe(
      byName(LONDON.buildings)["St Paul's Cathedral"].h,
    );
    expect(names['Elizabeth Tower'].h).toBe(byName(LONDON.buildings)['Elizabeth Tower'].h);
    expect(city.buildings.length).toBe(LONDON.buildings.length + 1);
  });

  it('the OSM Nelson\'s Column has h === 6', () => {
    const city = applyLandmarks(LONDON, 'london');
    const osm = city.buildings.find((b) => b.name === "Nelson's Column" && b.id > 0);
    expect(osm).toBeDefined();
    expect(osm!.h).toBe(6);
  });

  it('appends exactly one extra named Nelson\'s Column with h === 52 and a 4-point square of side 5 within 1 m of the projected point and id ≤ −1000', () => {
    const city = applyLandmarks(LONDON, 'london');
    const extras = city.buildings.filter(
      (b) => b.name === "Nelson's Column" && b.id <= -1000,
    );
    expect(extras).toHaveLength(1);
    const extra = extras[0]!;
    expect(extra.h).toBe(52);
    expect(extra.shape).toBeUndefined();
    expect(extra.poly).toHaveLength(4);
    const [a, b, c, d] = extra.poly;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(5);
    expect(Math.hypot(b[0] - c[0], b[1] - c[1])).toBeCloseTo(5);
    expect(Math.hypot(c[0] - d[0], c[1] - d[1])).toBeCloseTo(5);
    expect(Math.hypot(d[0] - a[0], d[1] - a[1])).toBeCloseTo(5);
    const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
    const cz = (a[1] + b[1] + c[1] + d[1]) / 4;
    const [px, pz] = project(-0.12793, 51.50776, LONDON.origin);
    expect(Math.hypot(cx - px, cz - pz)).toBeLessThan(1);
    expect(extra.id).toBeLessThanOrEqual(-1000);
  });

  it('is idempotent — applying twice adds no second Nelson\'s Column extra', () => {
    const once = applyLandmarks(LONDON, 'london');
    const twice = applyLandmarks(once, 'london');
    expect(
      twice.buildings.filter((b) => b.name === "Nelson's Column" && b.id <= -1000),
    ).toHaveLength(1);
    expect(twice.buildings.filter((b) => b.name === "Nelson's Column")).toHaveLength(2);
    expect(twice.buildings.length).toBe(LONDON.buildings.length + 1);
    const extra = twice.buildings.find(
      (b) => b.name === "Nelson's Column" && b.id <= -1000,
    );
    expect(extra!.h).toBe(52);
  });

  it('returns an unknown/synthetic id unchanged (deep-equal)', () => {
    const city = applyLandmarks(LONDON, 'synthetic');
    expect(city).toEqual(LONDON);
  });
});
