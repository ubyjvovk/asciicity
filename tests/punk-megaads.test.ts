/**
 * Cyberpunk mega-ads placement + cell meshes (T-0172,
 * src/render/punk/megaadsplace.ts). Real tiles are bucketed with
 * `bucketSources` and placed per cell against that cell's roads, the way
 * the layer's CellStreamer does.
 */
import { describe, expect, it } from 'vitest';
import { FLAT_HEIGHT, type Building, type Road, type Vec2 } from '../src/data/types';
import { SPAWN_PRESETS } from '../src/data/spawn';
import { project } from '../src/geo';
import { bucketSources, CELL_SIZE } from '../src/render/punk/cells';
import type { PunkSource } from '../src/render/punk/layer';
import {
  BILLBOARD_LEG,
  CAP_BEACONS,
  CAP_SIGNS,
  MEGA_LANDSCAPE_SLOTS,
  MEGA_PORTRAIT_SLOTS,
  buildMegaAdMeshes,
  countMegaAds,
  insideRing,
  megaMass,
  megaSlotUv,
  placeMegaAds,
  ringDistance,
  segmentRingDistance,
  type MegaAd,
  type MegaBeacon,
  type MegaScreen,
} from '../src/render/punk/megaadsplace';
import { loadTiledIndex, loadTiledTile } from './tiledCity';

/** Axis-aligned w × d box footprint with its south-west corner at (x, z). */
function box(id: number, x: number, z: number, w: number, d: number, h: number): Building {
  return { id, h, poly: [[x, z], [x + w, z], [x + w, z + d], [x, z + d]] };
}

/** A straight road along z = zRoad from x0 to x1. */
function road(id: number, x0: number, x1: number, zRoad: number): Road {
  return { id, cls: 'primary', pts: [[x0, zRoad], [x1, zRoad]] };
}

const screensOf = (ads: readonly MegaAd[]): MegaScreen[] => ads.filter((a): a is MegaScreen => a.kind === 'screen');
const signsOf = (ads: readonly MegaAd[]): MegaScreen[] =>
  ads.filter((a): a is MegaScreen => a.kind === 'screen' || a.kind === 'billboard');
const beaconsOf = (ads: readonly MegaAd[]): MegaBeacon[] => ads.filter((a): a is MegaBeacon => a.kind === 'beacon');

/** Tiles of `city` whose square overlaps the `r`-metre disc around (px, pz), bucketed and placed per cell. */
function placeAround(city: string, px: number, pz: number, r: number): { ads: MegaAd[]; byId: Map<number, Building> } {
  const index = loadTiledIndex(city);
  const size = index.tileSize;
  const src = new Map<string, PunkSource>();
  for (let i = Math.floor((px - r) / size); i <= Math.floor((px + r) / size); i++) {
    for (let j = Math.floor((pz - r) / size); j <= Math.floor((pz + r) / size); j++) {
      const key = `${i}_${j}`;
      if (!(key in index.tiles)) continue;
      const t = loadTiledTile(city, key);
      src.set(key, { buildings: t.buildings, roads: t.roads });
    }
  }
  const byId = new Map<number, Building>();
  const ads: MegaAd[] = [];
  for (const cell of bucketSources(src).values()) {
    for (const b of cell.buildings) byId.set(b.id, b);
    ads.push(...placeMegaAds(cell.buildings, cell.roads, FLAT_HEIGHT, city));
  }
  return { ads, byId };
}

function presetXZ(city: string, key: string): [number, number] {
  const p = SPAWN_PRESETS[key] as { lon: number; lat: number };
  const [x, z] = project(p.lon, p.lat, loadTiledIndex(city).origin);
  return [x, z];
}

const within = (ads: readonly MegaAd[], px: number, pz: number, r: number): MegaAd[] =>
  ads.filter((a) => (a.kind === 'strip' ? true : Math.hypot(a.x - px, a.z - pz) <= r));

const trianglesOf = (ads: readonly MegaAd[]): number => {
  const m = buildMegaAdMeshes(ads);
  return (m.screens.index.length + m.frames.index.length + m.lights.index.length) / 3;
};

// Real-data placements shared by several cases (T-0101: parse each tile once).
const SYD = presetXZ('sydney', 'harbourbridge');
const TOK = presetXZ('tokyo', 'shinjuku');
const LON = presetXZ('london', 'bank');
const KYI = presetXZ('kyiv', 'maidan');

describe('mega-ads placement (T-0172)', () => {
  it('1. determinism: same input → same ads (ids, positions, slots)', () => {
    const bs = [box(11, 0, 0, 40, 30, 160), box(12, 60, 0, 30, 30, 70), box(13, 120, 0, 30, 20, 30), box(14, 0, 60, 25, 25, 95)];
    const rs = [road(1, -50, 200, -10), road(2, -50, 200, 100)];
    const a = placeMegaAds(bs, rs, FLAT_HEIGHT, 'sydney');
    const b = placeMegaAds(bs, rs, FLAT_HEIGHT, 'sydney');
    expect(b).toEqual(a);
    // Input order does not matter (placement is keyed by building id).
    const c = placeMegaAds([...bs].reverse(), rs, FLAT_HEIGHT, 'sydney');
    expect(c.map((x) => x.id).sort()).toEqual(a.map((x) => x.id).sort());
    expect(c.find((x) => x.id === '11:screen:0')).toEqual(a.find((x) => x.id === '11:screen:0'));
    // A different seed re-rolls slots.
    const d = placeMegaAds(bs, rs, FLAT_HEIGHT, 'sydney', 7);
    expect(signsOf(d).map((s) => s.slot)).not.toEqual(signsOf(a).map((s) => s.slot));
    // Real tile: two runs identical.
    const t = loadTiledTile('tokyo', '-6_-1');
    expect(placeMegaAds(t.buildings, t.roads, FLAT_HEIGHT, 'tokyo')).toEqual(placeMegaAds(t.buildings, t.roads, FLAT_HEIGHT, 'tokyo'));
  });

  it('2. thresholds: h 44 → none; h 80 → 1 screen; h 160 → 2 screens on faces > 90° apart; billboard/beacon/strip rules', () => {
    const rs = [road(1, -100, 200, -8)];
    const N = 400;
    let bill44 = 0;
    let screens45 = 0;
    for (let id = 1; id <= N; id++) {
      const at44 = placeMegaAds([box(id, 0, 0, 40, 30, 44)], rs);
      expect(screensOf(at44)).toHaveLength(0);
      expect(beaconsOf(at44)).toHaveLength(0);
      expect(at44.filter((a) => a.kind === 'strip')).toHaveLength(0);
      bill44 += at44.filter((a) => a.kind === 'billboard').length;
      screens45 += screensOf(placeMegaAds([box(id, 0, 0, 40, 30, 50)], rs)).length;

      const at80 = placeMegaAds([box(id, 0, 0, 40, 30, 80)], rs);
      const s80 = screensOf(at80);
      expect(s80).toHaveLength(1);
      // Faces the road (south, −z).
      expect(s80[0]!.nz).toBeCloseTo(-1, 6);

      const s160 = screensOf(placeMegaAds([box(id, 0, 0, 40, 30, 160)], rs));
      expect(s160).toHaveLength(2);
      const [p, q] = s160 as [MegaScreen, MegaScreen];
      const angle = Math.acos(Math.max(-1, Math.min(1, p.nx * q.nx + p.nz * q.nz)));
      expect(angle).toBeGreaterThan(Math.PI / 2);

      // Beacons: h 59 → none, h ≥ 60 → 1–4.
      expect(beaconsOf(placeMegaAds([box(id, 0, 0, 40, 30, 59)], rs))).toHaveLength(0);
      const bc = beaconsOf(placeMegaAds([box(id, 0, 0, 40, 30, 60)], rs));
      expect(bc.length).toBeGreaterThanOrEqual(1);
      expect(bc.length).toBeLessThanOrEqual(4);
      for (const b of bc) expect(b.y).toBeCloseTo(60 + 0.45, 6);
      // h 24 → nothing at all.
      expect(placeMegaAds([box(id, 0, 0, 40, 30, 24)], rs)).toHaveLength(0);
    }
    // 45 ≤ h < 80: p 0.55. Billboards 25 ≤ h < 45: p 0.12 (tokyo / nyc 0.25).
    expect(screens45 / N).toBeGreaterThan(0.45);
    expect(screens45 / N).toBeLessThan(0.65);
    expect(bill44 / N).toBeGreaterThan(0.07);
    expect(bill44 / N).toBeLessThan(0.17);
    let billTokyo = 0;
    let strips = 0;
    for (let id = 1; id <= N; id++) {
      const ads = placeMegaAds([box(id, 0, 0, 40, 30, 30)], rs, FLAT_HEIGHT, 'tokyo');
      for (const b of signsOf(ads)) {
        expect(b.kind).toBe('billboard');
        expect(b.width).toBeGreaterThanOrEqual(12);
        expect(b.width).toBeLessThanOrEqual(20);
        expect(b.height).toBeGreaterThanOrEqual(5);
        expect(b.height).toBeLessThanOrEqual(8);
        expect(b.legBase).toBeCloseTo(30, 6);
        expect(b.y - b.height / 2).toBeCloseTo(30 + BILLBOARD_LEG, 6);
        expect(b.landscape).toBe(true);
        expect(insideRing(box(id, 0, 0, 40, 30, 30).poly, b.x, b.z)).toBe(true);
        billTokyo++;
      }
      strips += placeMegaAds([box(id, 0, 0, 40, 30, 90)], rs).filter((a) => a.kind === 'strip').length;
    }
    expect(billTokyo / N).toBeGreaterThan(0.18);
    expect(billTokyo / N).toBeLessThan(0.32);
    // Strips: h ≥ 60, p 0.5.
    expect(strips / N).toBeGreaterThan(0.4);
    expect(strips / N).toBeLessThan(0.6);
    // Pitched roofs carry no billboard; parts with minH ≥ 2.5 carry nothing.
    for (let id = 1; id <= 100; id++) {
      const pitched: Building = { ...box(id, 0, 0, 40, 30, 30), roof: { shape: 'gabled', h: 4 } };
      expect(placeMegaAds([pitched], rs, FLAT_HEIGHT, 'tokyo')).toHaveLength(0);
      expect(placeMegaAds([{ ...box(id, 0, 0, 40, 30, 200), minH: 3 }], rs)).toHaveLength(0);
    }
    // PLATEAU tiers: the tall check uses the max tier top.
    const tiered: Building = {
      ...box(5, 0, 0, 60, 40, 120),
      tiers: [
        { h: 20, poly: [[0, 0], [60, 0], [60, 40], [0, 40]] },
        { h: 120, poly: [[10, 5], [40, 5], [40, 30], [10, 30]] },
      ],
    };
    const tieredAds = placeMegaAds([tiered], rs);
    expect(screensOf(tieredAds)).toHaveLength(1);
    expect(screensOf(tieredAds)[0]!.y + screensOf(tieredAds)[0]!.height / 2).toBeLessThan(120);
    // Fallback without roads: the longest edge.
    const lone = screensOf(placeMegaAds([box(9, 0, 0, 50, 20, 90)], []));
    expect(lone).toHaveLength(1);
    expect(Math.abs(lone[0]!.nz)).toBeCloseTo(1, 6);
  });

  it('3. geometry: every screen lies 0.6–1.0 m outside its footprint, top below the roof, never taller than the wall', () => {
    const synth: Building[] = [];
    for (let i = 0; i < 40; i++) synth.push(box(1000 + i, (i % 8) * 70, Math.floor(i / 8) * 70, 20 + (i % 5) * 9, 15 + (i % 3) * 12, 45 + i * 7));
    const cases: { ads: MegaAd[]; byId: Map<number, Building> }[] = [
      { ads: placeMegaAds(synth, [road(1, -50, 600, -10), road(2, -50, 600, 160)]), byId: new Map(synth.map((b) => [b.id, b])) },
      placeAround('sydney', SYD[0], SYD[1], 1500),
      placeAround('tokyo', TOK[0], TOK[1], 1000),
    ];
    let checked = 0;
    for (const { ads, byId } of cases) {
      for (const s of screensOf(ads)) {
        const b = byId.get(s.buildingId)!;
        const mass = megaMass(b)!;
        expect(insideRing(mass.ring, s.x, s.z), s.id).toBe(false);
        const d = ringDistance(mass.ring, s.x, s.z);
        expect(d, s.id).toBeGreaterThanOrEqual(0.6 - 1e-6);
        expect(d, s.id).toBeLessThanOrEqual(1.0 + 1e-6);
        const rx = s.nz;
        const rz = -s.nx;
        const p: Vec2 = [s.x - (rx * s.width) / 2, s.z - (rz * s.width) / 2];
        const q: Vec2 = [s.x + (rx * s.width) / 2, s.z + (rz * s.width) / 2];
        expect(segmentRingDistance(mass.ring, p, q), s.id).toBeGreaterThanOrEqual(0.6 - 1e-6);
        const top = s.y + s.height / 2;
        const bottom = s.y - s.height / 2;
        expect(top, s.id).toBeLessThan(mass.wallTop);
        expect(mass.wallTop - top, s.id).toBeGreaterThanOrEqual(0.04 * mass.h - 1e-6);
        expect(mass.wallTop - top, s.id).toBeLessThanOrEqual(0.1 * mass.h + 1e-6);
        expect(bottom, s.id).toBeGreaterThanOrEqual(mass.wallBase);
        expect(s.height, s.id).toBeLessThan(mass.wallTop - mass.wallBase);
        expect(s.height).toBeCloseTo(Math.min(70, Math.max(14, 0.3 * mass.h)), 6);
        expect(s.slot).toBeLessThan(s.landscape ? MEGA_LANDSCAPE_SLOTS : MEGA_PORTRAIT_SLOTS);
        expect(s.period).toBeGreaterThanOrEqual(7);
        expect(s.period).toBeLessThanOrEqual(12);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
    // Mesh sanity: 2 triangles per face, all finite, one info vec4 per screen vertex.
    const m = buildMegaAdMeshes(cases[0]!.ads);
    const nFaces = signsOf(cases[0]!.ads).length;
    expect(m.screens.index.length).toBe(nFaces * 6);
    expect(m.screens.info.length).toBe(nFaces * 16);
    expect(m.lights.blink.length * 3).toBe(m.lights.glow.length);
    for (const arr of [m.screens.position, m.frames.position, m.lights.position]) for (const v of arr) expect(Number.isFinite(v)).toBe(true);
    // Atlas slot rects stay inside the canvas and do not overlap between orientations.
    expect(megaSlotUv(false, 15).v0).toBeCloseTo(0.5, 9);
    expect(megaSlotUv(true, 0).v1).toBeCloseTo(0.5, 9);
    expect(megaSlotUv(true, 7).v0).toBeCloseTo(0.25, 9);
  }, 60_000);

  it('4. caps per 250 m cell hold on a synthetic 60-tower cell', () => {
    const towers: Building[] = [];
    for (let i = 0; i < 60; i++) towers.push(box(5000 + i, 5 + (i % 10) * 24, 5 + Math.floor(i / 10) * 40, 16, 22, 90 + (i % 7) * 20));
    for (const t of towers) {
      const p = t.poly[0]!;
      expect(Math.floor(p[0] / CELL_SIZE)).toBe(0);
      expect(Math.floor(p[1] / CELL_SIZE)).toBe(0);
    }
    const rs = [0, 1, 2, 3, 4, 5, 6].map((k) => road(k, 0, 250, k * 40 + 1));
    const ads = placeMegaAds(towers, rs, FLAT_HEIGHT, 'tokyo');
    const c = countMegaAds(ads);
    console.log(`[megaads] 60-tower cell: ${JSON.stringify(c)}`);
    expect(c.screens + c.billboards).toBe(CAP_SIGNS);
    expect(c.beacons).toBeLessThanOrEqual(CAP_BEACONS);
    expect(c.beacons).toBeGreaterThan(40);
    // Tallest buildings win the cap.
    const minWith = Math.min(...signsOf(ads).map((s) => towers.find((t) => t.id === s.buildingId)!.h));
    const maxWithout = Math.max(
      0,
      ...towers.filter((t) => !signsOf(ads).some((s) => s.buildingId === t.id)).map((t) => t.h),
    );
    expect(minWith).toBeGreaterThanOrEqual(maxWithout);
  });

  it('5. density on real data: Sydney CBD and Tokyo Shinjuku ≥ 30 screens within 1.5 km, London City ≥ 12, Kyiv ≥ 4', () => {
    const cases: [string, [number, number], number][] = [
      ['sydney', SYD, 30],
      ['tokyo', TOK, 30],
      ['london', LON, 12],
      ['kyiv', KYI, 4],
    ];
    for (const [city, [px, pz], min] of cases) {
      const { ads } = placeAround(city, px, pz, 1500);
      const near = within(ads, px, pz, 1500);
      const c = countMegaAds(near);
      console.log(`[megaads] ${city} (${px.toFixed(0)}, ${pz.toFixed(0)}) r 1.5 km: ${JSON.stringify(c)}`);
      expect(c.screens, city).toBeGreaterThanOrEqual(min);
    }
  }, 120_000);

  it('6. cell build time ≤ 8 ms per cell (median over a Tokyo tile\'s cells)', () => {
    const t = loadTiledTile('tokyo', '-6_-1');
    const cells = [...bucketSources(new Map([['-6_-1', { buildings: t.buildings, roads: t.roads }]])).values()];
    // Warm the JIT once, then time placement + mesh per cell.
    for (const cell of cells) buildMegaAdMeshes(placeMegaAds(cell.buildings, cell.roads, FLAT_HEIGHT, 'tokyo'));
    const ms: number[] = [];
    for (const cell of cells) {
      const t0 = performance.now();
      buildMegaAdMeshes(placeMegaAds(cell.buildings, cell.roads, FLAT_HEIGHT, 'tokyo'));
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    const median = ms[Math.floor(ms.length / 2)]!;
    const max = ms[ms.length - 1]!;
    console.log(`[megaads] tokyo -6_-1: ${cells.length} cells, median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
    expect(median).toBeLessThanOrEqual(8);
    // Max gets GC / loaded-host headroom (a full parallel suite hit 8.4 ms once).
    expect(max).toBeLessThanOrEqual(40);
    // Every cell the streamer builds at harbourbridge (1.6 km): max ≤ 8 ms too.
    const index = loadTiledIndex('sydney');
    const src = new Map<string, PunkSource>();
    for (const key of Object.keys(index.tiles)) {
      const [i, j] = key.split('_').map(Number) as [number, number];
      if (Math.hypot((i + 0.5) * index.tileSize - SYD[0], (j + 0.5) * index.tileSize - SYD[1]) > 1600 + index.tileSize) continue;
      const tile = loadTiledTile('sydney', key);
      src.set(key, { buildings: tile.buildings, roads: tile.roads });
    }
    const syd = [...bucketSources(src).values()].filter((c) => Math.hypot(c.cx - SYD[0], c.cz - SYD[1]) <= 1600);
    for (const cell of syd) buildMegaAdMeshes(placeMegaAds(cell.buildings, cell.roads, FLAT_HEIGHT, 'sydney'));
    let sydMax = 0;
    for (const cell of syd) {
      const t0 = performance.now();
      buildMegaAdMeshes(placeMegaAds(cell.buildings, cell.roads, FLAT_HEIGHT, 'sydney'));
      sydMax = Math.max(sydMax, performance.now() - t0);
    }
    console.log(`[megaads] sydney harbourbridge: ${syd.length} cells within 1.6 km, max ${sydMax.toFixed(2)} ms`);
    expect(sydMax).toBeLessThanOrEqual(8);
  }, 30_000);

  it('7. triangle budget: whole layer (1.6 km build radius) ≤ 150 k at harbourbridge and shinjuku', () => {
    for (const [city, [px, pz]] of [
      ['sydney', SYD],
      ['tokyo', TOK],
    ] as const) {
      const { ads } = placeAround(city, px, pz, 1600 + CELL_SIZE);
      // Cells the streamer would build: centre within 1600 m.
      const inRange = ads.filter((a) => {
        const x = a.kind === 'strip' ? a.ring[0]![0] : a.x;
        const z = a.kind === 'strip' ? a.ring[0]![1] : a.z;
        return Math.hypot(x - px, z - pz) <= 1600 + CELL_SIZE;
      });
      const tris = trianglesOf(inRange);
      console.log(`[megaads] ${city} triangles within ~1.6 km: ${tris} (${JSON.stringify(countMegaAds(inRange))})`);
      expect(tris).toBeLessThanOrEqual(150_000);
    }
  }, 120_000);
});


