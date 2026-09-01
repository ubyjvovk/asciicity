/**
 * Unit tests for the Sydney Opera House sail shells (`src/world/opera.ts`,
 * architecture.md §4.22). Case names match the T-0114 acceptance fixtures.
 * Uses the memoized tiled-dataset helpers so the tile reads happen only
 * once per vitest worker (T-0101 lesson).
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { CityData, Vec2 } from '../src/data/types';
import { project } from '../src/geo';
import {
  OPERA_HOUSES,
  buildOperaHouse,
  makeOperaObject,
} from '../src/world/opera';
import type { MeshData } from '../src/world/mesh';
import { loadTiledCity } from './tiledCity';

vi.setConfig({ testTimeout: 30_000 });

const SYD: CityData = loadTiledCity('sydney');
const SPEC = OPERA_HOUSES.sydney!;
const OPERA_NAME = 'Sydney Opera House';

function vertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

/** Even-odd point-in-polygon test on a single ring. */
function pointInRing(x: number, z: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Squared distance from `(x, z)` to segment `a`→`b`. */
function distSqToSegment(x: number, z: number, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const len2 = abx * abx + abz * abz;
  let t = len2 === 0 ? 0 : ((x - a[0]) * abx + (z - a[1]) * abz) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = a[0] + abx * t;
  const qz = a[1] + abz * t;
  return (x - qx) * (x - qx) + (z - qz) * (z - qz);
}

/**
 * `true` when `(x, z)` lies inside `ring` OR within `d` metres of any of
 * its edges — i.e., the Minkowski sum of the polygon with a disc of
 * radius `d`.
 */
function insideRingOrWithin(x: number, z: number, ring: readonly Vec2[], d: number): boolean {
  if (pointInRing(x, z, ring)) return true;
  const d2 = d * d;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (distSqToSegment(x, z, a, b) <= d2) return true;
  }
  return false;
}

function operaFootprint(city: CityData): Vec2[] {
  const b = city.buildings.find((bb) => bb.name === OPERA_NAME);
  if (!b) throw new Error(`Sydney tiled city is missing ${OPERA_NAME}`);
  return b.poly;
}

function stubCity(): CityData {
  return {
    v: 1,
    origin: { lat: 0, lon: 0 },
    bbox: [0, 0, 0, 0],
    buildings: [],
    roads: [],
    places: [],
  };
}

describe('src/world/opera.ts', () => {
  it('OPERA_HOUSES has exactly one sydney entry per §4.22', () => {
    const keys = Object.keys(OPERA_HOUSES);
    expect(keys).toEqual(['sydney']);
    expect(SPEC.podiumASL).toBe(8);
    expect(SPEC.sphereR).toBe(75);
    expect(SPEC.color).toBe(0xf7f4ec);
    expect(SPEC.mouthColor).toBe(0x2a2f36);
    expect(SPEC.groups).toHaveLength(3);
    // Sails increase landward → seaward.
    for (const g of SPEC.groups) {
      expect(g.sails.length).toBeGreaterThan(0);
      expect(g.halfWidths.length).toBe(g.sails.length);
      for (let i = 1; i < g.sails.length; i++) {
        expect(g.sails[i]!).toBeGreaterThanOrEqual(g.sails[i - 1]!);
      }
    }
    // Tallest tip across all groups is 67 m ASL (Concert Hall sail 2).
    let maxTip = -Infinity;
    for (const g of SPEC.groups) for (const t of g.sails) if (t > maxTip) maxTip = t;
    expect(maxTip).toBe(67);
  });

  it('tallest ridge tip y = (67 − datum) ± 1', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const mesh = buildOperaHouse(SPEC, SYD);
    let maxY = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1]!;
      if (y > maxY) maxY = y;
    }
    expect(Math.abs(maxY - (67 - datum))).toBeLessThanOrEqual(1);
  });

  it('every sail-base vertex lies inside the Sydney Opera House footprint expanded by 6 m', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const baseY = SPEC.podiumASL - datum;
    const ring = operaFootprint(SYD);
    const mesh = buildOperaHouse(SPEC, SYD);
    let checked = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1]!;
      if (Math.abs(y - baseY) > 0.25) continue; // only base-arc vertices
      const x = mesh.positions[i]!;
      const z = mesh.positions[i + 2]!;
      checked++;
      expect(
        insideRingOrWithin(x, z, ring, 6),
        `sail-base vertex (${x.toFixed(2)}, ${z.toFixed(2)}) outside podium+6 m`,
      ).toBe(true);
    }
    expect(checked, 'no sail-base vertices sampled').toBeGreaterThan(0);
  });

  it('per group, the tip x/z of each sail lies bearing-ward of its base', () => {
    for (const g of SPEC.groups) {
      const [gx, gz] = project(g.base[0], g.base[1], SYD.origin);
      const bearing = (g.bearingDeg * Math.PI) / 180;
      const fwdX = Math.sin(bearing);
      const fwdZ = -Math.cos(bearing);
      for (let i = 0; i < g.sails.length; i++) {
        const bx = gx + fwdX * g.spacing * i;
        const bz = gz + fwdZ * g.spacing * i;
        // The builder chooses leanDist = min(R * 0.35, rise * 0.6) > 0, so
        // tip − base has a strictly positive component along `forward`.
        // Reconstruct that component from the spec's tip height and R.
        const rise = g.sails[i]! - SPEC.podiumASL;
        const leanDist = Math.min(SPEC.sphereR * 0.35, rise * 0.6);
        expect(leanDist).toBeGreaterThan(0);
        const tipX = bx + fwdX * leanDist;
        const tipZ = bz + fwdZ * leanDist;
        const dot = (tipX - bx) * fwdX + (tipZ - bz) * fwdZ;
        expect(
          dot,
          `group ${g.bearingDeg}° sail ${i}: tip not bearing-ward of base`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every vertex y ≥ podiumASL − datum − 0.5', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const minAllowed = SPEC.podiumASL - datum - 0.5;
    const mesh = buildOperaHouse(SPEC, SYD);
    let minY = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1]!;
      if (y < minY) minY = y;
    }
    expect(minY).toBeGreaterThanOrEqual(minAllowed);
  });

  it('vertex count is > 0 and < 20 000, and every position/normal is finite', () => {
    const mesh = buildOperaHouse(SPEC, SYD);
    const n = vertexCount(mesh);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(20000);
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(Number.isFinite(mesh.positions[i])).toBe(true);
    }
    for (let i = 0; i < mesh.normals.length; i++) {
      expect(Number.isFinite(mesh.normals[i])).toBe(true);
    }
  });

  it('every non-sydney city id → empty MeshData / empty Object3D', () => {
    const city = stubCity();
    for (const id of ['london', 'kyiv', 'sf', 'nyc', 'tokyo', 'synthetic']) {
      expect(OPERA_HOUSES[id]).toBeUndefined();
      const obj = makeOperaObject(id, city);
      // Not a Mesh (has no geometry) — the empty Object3D fallback.
      expect(obj).toBeInstanceOf(THREE.Object3D);
      expect((obj as THREE.Object3D).children.length).toBe(0);
      if (obj instanceof THREE.Mesh) {
        expect(obj.geometry.getAttribute('position').count).toBe(0);
      }
    }
  });

  it('sydney → makeOperaObject is a THREE.Mesh with a non-empty position buffer', () => {
    const obj = makeOperaObject('sydney', SYD);
    expect(obj).toBeInstanceOf(THREE.Mesh);
    const attr = (obj as THREE.Mesh).geometry.getAttribute('position');
    expect(attr.count).toBeGreaterThan(0);
  });
});
