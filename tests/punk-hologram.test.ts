/**
 * Cyberpunk giant hologram (wave 25, T-0173, src/render/punk/hologramplace.ts):
 * per-city anchors, the clear-spot search, facing and the model budget.
 * Pure — no three/webgpu.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Building } from '../src/data/types';
import { SPAWN_PRESETS } from '../src/data/spawn';
import {
  HOLO_ANCHORS,
  HOLO_CLEAR_R,
  HOLO_ORIGINS,
  HOLO_SEARCH_MAX,
  holoDiscClear,
  holoFlicker,
  holoGlitchGap,
  holoPlacement,
  holoSpot,
  holoStart,
  holoSway,
  holoTileKeys,
  holoYaw,
} from '../src/render/punk/hologramplace';

const DATA = join(__dirname, '..', 'public', 'data');
const CITIES = ['london', 'kyiv', 'tokyo', 'sydney', 'sf', 'nyc'];

/** Axis-aligned square footprint centred on (cx, cz), half-size `h`. */
function box(id: number, cx: number, cz: number, h: number): Building {
  return { id, h: 20, poly: [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]] };
}

/** Distance from (x, z) to the nearest footprint edge (0 when inside). */
function clearance(x: number, z: number, buildings: readonly Building[]): number {
  let best = Infinity;
  for (const b of buildings) {
    if (!holoDiscClear(x, z, [b], 0.001)) return 0;
    const p = b.poly;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [ax, az] = p[i]!;
      const [bx, bz] = p[j]!;
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
    }
  }
  return best;
}

/** Buildings of every committed tile around `(x, z)` (square half-extent 500 m). */
function tileBuildings(city: string, x: number, z: number): Building[] {
  const out: Building[] = [];
  for (const key of holoTileKeys(x, z, 500)) {
    const f = join(DATA, city, 'tiles', `${key}.json`);
    if (!existsSync(f)) continue;
    const tile = JSON.parse(readFileSync(f, 'utf8')) as { buildings: Building[] };
    out.push(...tile.buildings);
  }
  return out;
}

describe('HOLO_ANCHORS', () => {
  it('covers london, kyiv, tokyo, sydney, sf, nyc and every preset key exists in SPAWN_PRESETS', () => {
    for (const c of CITIES) {
      const a = HOLO_ANCHORS[c];
      expect(a, c).toBeDefined();
      expect(SPAWN_PRESETS[a!.preset], a!.preset).toBeDefined();
      expect(SPAWN_PRESETS[a!.preset]!.city).toBe(c);
      expect(a!.aheadM).toBe(40);
    }
    expect(HOLO_ANCHORS['synthetic']).toBeUndefined();
    expect(HOLO_ANCHORS['minas-tirith']).toBeUndefined();
    expect(holoStart('synthetic')).toBeNull();
  });

  it('HOLO_ORIGINS match every index.json origin', () => {
    for (const c of CITIES) {
      const index = JSON.parse(readFileSync(join(DATA, c, 'index.json'), 'utf8')) as { origin: { lat: number; lon: number } };
      expect(HOLO_ORIGINS[c]).toEqual(index.origin);
    }
  });

  it('holoStart steps aheadM metres along the preset bearing', () => {
    const s = holoStart('london')!;
    expect(Math.hypot(s.start.x - s.preset.x, s.start.z - s.preset.z)).toBeCloseTo(40, 6);
    // bank faces west (270°): the step goes −x.
    expect(s.start.x - s.preset.x).toBeCloseTo(-40, 6);
  });
});

describe('holoSpot', () => {
  it('holoSpot on a synthetic block: returns a point clear of footprints by ≥ 14 m, nearest-first', () => {
    // Open ground: the start itself.
    expect(holoSpot({ x: 0, z: 0 }, 0, [])).toEqual({ x: 0, z: 0 });
    // A block right on the start: the spot is the first clear ring sample.
    const blocks = [box(1, 0, 0, 20), box(2, 60, 0, 10)];
    const spot = holoSpot({ x: 0, z: 0 }, 0, blocks)!;
    expect(spot).not.toBeNull();
    expect(clearance(spot.x, spot.z, blocks)).toBeGreaterThanOrEqual(HOLO_CLEAR_R - 1e-9);
    const d = Math.hypot(spot.x, spot.z);
    // Needs 20 + 14 = 34 m (sides) → the 35 m ring; bearing 0 → due north first.
    expect(d).toBeCloseTo(35, 6);
    expect(spot.x).toBeCloseTo(0, 6);
    expect(spot.z).toBeCloseTo(-35, 6);
    // Nearest-first: no clear sample on any smaller ring.
    for (let r = 0; r < 35; r += 5) {
      const n = Math.max(6, Math.ceil((2 * Math.PI * r) / 5));
      for (let k = 0; k < (r === 0 ? 1 : n); k++) {
        const a = (2 * Math.PI * k) / n;
        expect(holoDiscClear(r * Math.sin(a), -r * Math.cos(a), blocks)).toBe(false);
      }
    }
    // Bearing orders the ring: facing east the first clear sample is east… blocked by #2, so it rotates on.
    const east = holoSpot({ x: 0, z: 0 }, Math.PI / 2, blocks)!;
    expect(Math.hypot(east.x, east.z)).toBeCloseTo(35, 6);
    expect(clearance(east.x, east.z, blocks)).toBeGreaterThanOrEqual(HOLO_CLEAR_R - 1e-9);
    // aheadM steps along the bearing before searching.
    expect(holoSpot({ x: 0, z: 0 }, Math.PI / 2, [], 40)!.x).toBeCloseTo(40, 6);
  });

  it('holoSpot returns null when the whole 80 m search area is built up', () => {
    const full = [box(1, 0, 0, HOLO_SEARCH_MAX + 20)];
    expect(holoSpot({ x: 0, z: 0 }, 0, full)).toBeNull();
    // A grid of blocks with 20 m streets (< 28 m) is also fully built up.
    const grid: Building[] = [];
    let id = 1;
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) grid.push(box(id++, i * 40, j * 40, 10));
    expect(holoSpot({ x: 0, z: 0 }, 0, grid)).toBeNull();
  });
});

describe('real data', () => {
  it("on the committed real data (tiles around each anchor), every city's spot resolves, lies ≤ 80 m from the stepped start, and is clear of footprints", () => {
    for (const c of CITIES) {
      const s = holoStart(c)!;
      const buildings = tileBuildings(c, s.start.x, s.start.z);
      expect(buildings.length, c).toBeGreaterThan(0);
      const p = holoPlacement(c, buildings);
      expect(p, c).not.toBeNull();
      expect(Math.hypot(p!.x - s.start.x, p!.z - s.start.z), c).toBeLessThanOrEqual(HOLO_SEARCH_MAX + 1e-9);
      expect(clearance(p!.x, p!.z, buildings), c).toBeGreaterThanOrEqual(HOLO_CLEAR_R - 1e-9);
    }
  }, 30000);

  it('facing: the returned yaw points from the spot to the preset position (±1°)', () => {
    for (const c of CITIES) {
      const s = holoStart(c)!;
      const p = holoPlacement(c, tileBuildings(c, s.start.x, s.start.z))!;
      const fx = Math.sin(p.yaw);
      const fz = -Math.cos(p.yaw);
      const dx = p.presetX - p.x;
      const dz = p.presetZ - p.z;
      const err = Math.acos(Math.min(1, (fx * dx + fz * dz) / Math.hypot(dx, dz)));
      expect(err, c).toBeLessThan((1 * Math.PI) / 180);
    }
    // Pure yaw convention: north is 0, east +π/2.
    expect(holoYaw({ x: 0, z: 0 }, { x: 0, z: -10 })).toBeCloseTo(0, 9);
    expect(holoYaw({ x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(Math.PI / 2, 9);
  }, 30000);
});

describe('animation timing', () => {
  it('sway stays within ±20° with a 40 s period', () => {
    for (let t = 0; t < 80; t += 0.37) expect(Math.abs(holoSway(t))).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-12);
    expect(holoSway(10)).toBeCloseTo((20 * Math.PI) / 180, 9);
    expect(holoSway(13)).toBeCloseTo(holoSway(53), 9);
  });

  it('flicker stays within 0.75 ± 0.08 and glitch gaps within 6–14 s', () => {
    for (let t = 0; t < 30; t += 0.013) {
      const f = holoFlicker(t);
      expect(f).toBeGreaterThanOrEqual(0.67 - 1e-12);
      expect(f).toBeLessThanOrEqual(0.83 + 1e-12);
    }
    for (let k = 0; k < 200; k++) {
      const g = holoGlitchGap(k);
      expect(g).toBeGreaterThanOrEqual(6);
      expect(g).toBeLessThan(14);
    }
  });
});

describe('model asset', () => {
  it('the GLB exists and its byte size ≤ 3 MB (fs check)', () => {
    const f = join(__dirname, '..', 'public', 'models', 'holo', 'mia.glb');
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeLessThanOrEqual(3 * 1024 * 1024);
  });
});
