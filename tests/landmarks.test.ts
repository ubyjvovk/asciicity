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
import { landmarkAnchors } from '../src/hud/tags';

const KYIV: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'kyiv.json'), 'utf8'),
);
const LONDON: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'city.json'), 'utf8'),
);
const SF: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'sf.json'), 'utf8'),
);
const NYC: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'nyc.json'), 'utf8'),
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

// Wave 8 SF landmarks (T-0076): the fixes touch only names that are present in
// the fetched data. Wave 9 (T-0080) removed the Golden Gate Bridge tower
// extras — those towers are synthesised by src/world/bridge.ts.
describe('applyLandmarks (San Francisco)', () => {
  it('fixes only the Coit Tower colour (h 64 already right) and leaves other heights untouched', () => {
    const city = applyLandmarks(SF, 'sf');
    expect(LANDMARK_FIXES.sf).toEqual({
      'Coit Tower': { color: 0xf5f0e6 },
      'Alcatraz Island Lighthouse': { color: 0xf5f0e6, label: 'Alcatraz' },
    });
    const names = byName(city.buildings);
    // The colour-only fix reaches colourFor but not height/shape.
    expect(colorFor(names['Coit Tower'])).toBe(0xf5f0e6);
    expect(names['Coit Tower'].h).toBe(64);
    expect(names['Coit Tower'].shape).toBeUndefined();
    // Well-tagged landmarks stay as OSM (no height fix).
    expect(names['Transamerica Pyramid'].h).toBe(260);
    expect(names['Salesforce Tower'].h).toBe(320);
    expect(names['San Francisco Ferry Building'].h).toBe(15);
  });

  it('applies fixes only for names present in the fetched sf.json', () => {
    const present = new Set(
      SF.buildings.filter((b) => b.name !== undefined).map((b) => b.name),
    );
    for (const name of Object.keys(LANDMARK_FIXES.sf)) {
      expect(present.has(name), `fix name "${name}" must exist in sf.json`).toBe(true);
    }
  });

  it('appends the Ferry Building Clock Tower extra as a tower', () => {
    const city = applyLandmarks(SF, 'sf');
    const extraNames = city.buildings
      .filter((b) => b.id <= -1000)
      .map((b) => b.name);
    expect(extraNames).toEqual(['Ferry Building Clock Tower']);
    const clock = city.buildings.find((b) => b.name === 'Ferry Building Clock Tower')!;
    expect(clock.shape).toBe('tower');
  });

  it('sf fixes tag the Alcatraz lighthouse as Alcatraz', () => {
    // The fix's `label: 'Alcatraz'` makes `landmarkAnchors` produce a tag
    // reading "Alcatraz" above the lighthouse instead of the long OSM name.
    const city = applyLandmarks(SF, 'sf');
    const anchors = landmarkAnchors(city, LANDMARK_FIXES.sf);
    const alcatraz = anchors.find((a) => a.name === 'Alcatraz Island Lighthouse');
    expect(alcatraz).toBeDefined();
    expect(alcatraz!.label).toBe('Alcatraz');
  });

  it('the Ferry Building Clock Tower is a 14×14 square centred on the OSM building centroid', () => {
    const city = applyLandmarks(SF, 'sf');
    const clock = city.buildings.find((b) => b.name === 'Ferry Building Clock Tower')!;
    const osm = SF.buildings.find((b) => b.name === 'San Francisco Ferry Building')!;
    let ocx = 0;
    let ocz = 0;
    for (const [x, z] of osm.poly) {
      ocx += x;
      ocz += z;
    }
    ocx /= osm.poly.length;
    ocz /= osm.poly.length;
    const [a, b, c, d] = clock.poly;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(14);
    expect(Math.hypot(b[0] - c[0], b[1] - c[1])).toBeCloseTo(14);
    const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
    const cz = (a[1] + b[1] + c[1] + d[1]) / 4;
    expect(Math.hypot(cx - ocx, cz - ocz)).toBeLessThan(2);
  });

  it('is idempotent — applying twice adds no second set of SF extras', () => {
    const once = applyLandmarks(SF, 'sf');
    const twice = applyLandmarks(once, 'sf');
    const extras = twice.buildings.filter((b) => b.id <= -1000);
    expect(extras).toHaveLength(1);
    expect(twice.buildings.length).toBe(SF.buildings.length + 1);
  });
});

// Wave 10 Manhattan (T-0087): the nyc fix table names must all exist in the
// fetched nyc.json (else the fix is dead), and the Washington Square Arch
// extra must be appended as an 8×8 ivory landmark near the projected point.
// Building-part support (T-0086) brought real setback massing so only Saint
// Patrick’s and Woolworth have OSM stubs — the other seventeen fixes are
// shape/colour only.
describe('applyLandmarks (Manhattan)', () => {
  it('every nyc fix name is present in the fetched nyc.json', () => {
    const present = new Set(
      NYC.buildings.filter((b) => b.name !== undefined).map((b) => b.name),
    );
    for (const name of Object.keys(LANDMARK_FIXES.nyc)) {
      expect(present.has(name), `fix name "${name}" must exist in nyc.json`).toBe(true);
    }
  });

  it("Saint Patrick’s Cathedral is a 42 m OSM stub — fix raises it to 101 m (spire)", () => {
    // A tiny sanity: the OSM stub is <60% of the real 101 m, so the fix must
    // rewrite h. This is one of only two height fixes in the nyc table.
    const osm = NYC.buildings.find((b) => b.name === 'Saint Patrick’s Cathedral');
    expect(osm).toBeDefined();
    expect(osm!.h).toBeLessThan(0.6 * 101);
    const city = applyLandmarks(NYC, 'nyc');
    const fixed = city.buildings.find((b) => b.name === 'Saint Patrick’s Cathedral');
    expect(fixed).toBeDefined();
    expect(fixed!.h).toBe(101);
    expect(fixed!.shape).toBe('spire');
  });

  it('Woolworth Building is a 120 m OSM stub — fix raises it to 241 m (spire)', () => {
    const osm = NYC.buildings.find((b) => b.name === 'Woolworth Building');
    expect(osm).toBeDefined();
    expect(osm!.h).toBeLessThan(0.6 * 241);
    const city = applyLandmarks(NYC, 'nyc');
    const fixed = city.buildings.find((b) => b.name === 'Woolworth Building');
    expect(fixed).toBeDefined();
    expect(fixed!.h).toBe(241);
    expect(fixed!.shape).toBe('spire');
  });

  it('shape-only fixes carry the §4.13 caps onto their landmarks (dome/spire/tower)', () => {
    const city = applyLandmarks(NYC, 'nyc');
    const names = byName(city.buildings);
    expect(names['Empire State Building'].shape).toBe('spire');
    expect(names['Chrysler Building'].shape).toBe('spire');
    expect(names['One World Trade Center'].shape).toBe('spire');
    expect(names['Bank of America Tower'].shape).toBe('spire');
    expect(names['Trinity Church'].shape).toBe('spire');
    expect(names['One Vanderbilt'].shape).toBe('tower');
    expect(names['432 Park Avenue'].shape).toBe('tower');
    expect(names['Central Park Tower'].shape).toBe('tower');
    expect(names['Madison Square Garden'].shape).toBe('dome');
    // Colour-only rows keep their OSM shape (usually undefined).
    expect(names['Flatiron Building'].shape).toBeUndefined();
    expect(names['MetLife Building'].shape).toBeUndefined();
  });

  it('leaves the well-tagged landmark heights untouched (T-0086 parts)', () => {
    // The Empire State Building, One WTC, Chrysler etc. read their real
    // heights straight from OSM `building:part` ways — no h fix in the table.
    const before = byName(NYC.buildings);
    const city = applyLandmarks(NYC, 'nyc');
    const after = byName(city.buildings);
    for (const name of [
      'Empire State Building',
      'Chrysler Building',
      'One World Trade Center',
      'Flatiron Building',
      '30 Rockefeller Plaza',
      'Bank of America Tower',
      'One Vanderbilt',
      '432 Park Avenue',
      'Central Park Tower',
      'MetLife Building',
      'Madison Square Garden',
    ]) {
      expect(after[name].h, name).toBe(before[name].h);
    }
  });

  it('appends exactly one Washington Square Arch extra: 8×8 square, h 23, id ≤ −1000, ivory', () => {
    const city = applyLandmarks(NYC, 'nyc');
    const extras = city.buildings.filter(
      (b) => b.name === 'Washington Square Arch' && b.id <= -1000,
    );
    expect(extras).toHaveLength(1);
    const extra = extras[0]!;
    expect(extra.h).toBe(23);
    expect(extra.poly).toHaveLength(4);
    const [a, b, c, d] = extra.poly;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(8);
    expect(Math.hypot(b[0] - c[0], b[1] - c[1])).toBeCloseTo(8);
    expect(Math.hypot(c[0] - d[0], c[1] - d[1])).toBeCloseTo(8);
    expect(Math.hypot(d[0] - a[0], d[1] - a[1])).toBeCloseTo(8);
    const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
    const cz = (a[1] + b[1] + c[1] + d[1]) / 4;
    const [px, pz] = project(-73.99734, 40.731, NYC.origin);
    expect(Math.hypot(cx - px, cz - pz)).toBeLessThan(1);
    // Colour is registered so colorFor pulls it from the extras table (the
    // OSM arch is also named Washington Square Arch — the extra wins for the
    // negative id via `colorFor`'s extras lookup).
    expect(colorFor(extra)).toBe(0xe8e0c8);
  });

  it('the OSM Washington Square Arch keeps its own h (both entries coexist, like Nelson\'s Column)', () => {
    const city = applyLandmarks(NYC, 'nyc');
    const arches = city.buildings.filter((b) => b.name === 'Washington Square Arch');
    // OSM arch + extra (both share the name); the pair works exactly like the
    // London Nelson's Column plinth-plus-extra pairing.
    expect(arches.length).toBe(2);
    const osm = arches.find((b) => b.id > 0)!;
    const extra = arches.find((b) => b.id <= -1000)!;
    expect(extra.h).toBe(23);
    // OSM 20.5 stays as-is (there is no `h` in the fix for the arch — the
    // ivory landmark is the extra alone).
    const osmBefore = NYC.buildings.find((b) => b.name === 'Washington Square Arch')!;
    expect(osm.h).toBe(osmBefore.h);
  });

  it('is idempotent — applying twice adds no second Washington Square Arch extra', () => {
    const once = applyLandmarks(NYC, 'nyc');
    const twice = applyLandmarks(once, 'nyc');
    const extras = twice.buildings.filter(
      (b) => b.name === 'Washington Square Arch' && b.id <= -1000,
    );
    expect(extras).toHaveLength(1);
    expect(twice.buildings.length).toBe(NYC.buildings.length + 1);
  });

  it('colorFor of the fixed Empire State Building is the ivory limestone (0xd9cfbf)', () => {
    const city = applyLandmarks(NYC, 'nyc');
    const esb = city.buildings.find((b) => b.name === 'Empire State Building')!;
    expect(colorFor(esb)).toBe(0xd9cfbf);
  });

  it('sf fixes still target their names after the nyc table lands (no cross-city bleed)', () => {
    // Adding LANDMARK_FIXES.nyc must not disturb the SF fixes: the tables
    // are per-city, and applying the SF cityId must not lift any nyc fix.
    const city = applyLandmarks(SF, 'sf');
    const names = byName(city.buildings);
    // Empire State Building lives only in NYC — but if `applyLandmarks(SF)`
    // accidentally applied nyc-table shapes it would surface a `.shape` on
    // some SF building. Instead every SF entry stays unchanged shape-wise.
    for (const b of city.buildings) {
      if (b.id <= -1000) continue;
      const before = SF.buildings.find((x) => x.id === b.id);
      if (!before) continue;
      // Only Coit Tower carries a color fix on SF (that fix is shape-less).
      expect(b.shape).toBe(before.shape);
    }
    // Sanity: Coit is still 64 m ivory.
    expect(names['Coit Tower'].h).toBe(64);
  });
});
