/**
 * Unit tests for `src/world/sky.ts` (docs/world.md §Sky): sun/moon astronomical
 * positions, fraction bounds and the makeSky/updateSky object contract.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { sunPosition, moonPosition, makeSky, updateSky } from '../src/world/sky';

/** London (City) coordinates used throughout these tests. */
const LAT = 51.5074;
const LON = -0.1278;

/** Max position error the low-precision formulas should stay within. */
const TOL_DEG = 2.5;

function isoT(iso: string): Date {
  return new Date(iso);
}

describe('sunPosition', () => {
  it('noon on the summer solstice puts the sun high in the south', () => {
    const s = sunPosition(isoT('2026-06-21T12:00:00Z'), LAT, LON);
    expect(Math.abs(s.altitudeDeg - 61.9)).toBeLessThanOrEqual(TOL_DEG);
    expect(Math.abs(s.azimuthDeg - 180)).toBeLessThanOrEqual(6);
  });

  it('noon on the winter solstice puts the sun low in the south', () => {
    const s = sunPosition(isoT('2026-12-21T12:00:00Z'), LAT, LON);
    expect(Math.abs(s.altitudeDeg - 15.1)).toBeLessThanOrEqual(TOL_DEG);
  });

  it('midnight on the summer solstice has the sun below the horizon', () => {
    const s = sunPosition(isoT('2026-06-21T00:00:00Z'), LAT, LON);
    expect(s.altitudeDeg).toBeLessThan(-10);
  });

  it('azimuth is always normalized to [0, 360)', () => {
    for (let day = 1; day <= 30; day++) {
      const s = sunPosition(isoT(`2026-06-${String(day).padStart(2, '0')}T12:00:00Z`), LAT, LON);
      expect(s.azimuthDeg).toBeGreaterThanOrEqual(0);
      expect(s.azimuthDeg).toBeLessThan(360);
    }
  });

  it('azimuth increases through the morning (09:00Z < 12:00Z)', () => {
    const morning = sunPosition(isoT('2026-06-21T09:00:00Z'), LAT, LON);
    const noon = sunPosition(isoT('2026-06-21T12:00:00Z'), LAT, LON);
    expect(morning.azimuthDeg).toBeLessThan(noon.azimuthDeg);
  });
});

describe('moonPosition', () => {
  it('fraction stays in [0, 1] across 30 daily samples', () => {
    for (let day = 1; day <= 30; day++) {
      const m = moonPosition(isoT(`2026-06-${String(day).padStart(2, '0')}T00:00:00Z`), LAT, LON);
      expect(m.fraction).toBeGreaterThanOrEqual(0);
      expect(m.fraction).toBeLessThanOrEqual(1);
    }
  });

  it('fraction spans below 0.15 and above 0.85 within 30 days', () => {
    let min = 1;
    let max = 0;
    for (let day = 1; day <= 30; day++) {
      const m = moonPosition(isoT(`2026-06-${String(day).padStart(2, '0')}T00:00:00Z`), LAT, LON);
      if (m.fraction < min) min = m.fraction;
      if (m.fraction > max) max = m.fraction;
    }
    expect(min).toBeLessThan(0.15);
    expect(max).toBeGreaterThan(0.85);
  });

  it('moon altitude is always finite', () => {
    for (let day = 1; day <= 30; day++) {
      const m = moonPosition(isoT(`2026-06-${String(day).padStart(2, '0')}T00:00:00Z`), LAT, LON);
      expect(Number.isFinite(m.altitudeDeg)).toBe(true);
      expect(Number.isFinite(m.azimuthDeg)).toBe(true);
    }
  });
});

describe('makeSky/updateSky', () => {
  it('creates sun, moon and stars children with fog disabled', () => {
    const sky = makeSky(isoT('2026-06-21T12:00:00Z'), { lat: LAT, lon: LON });
    expect(sky.children.length).toBe(3);
    for (const child of sky.children) {
      const mat = (child as unknown as { material: THREE.MeshBasicMaterial | THREE.PointsMaterial }).material;
      expect(mat.fog).toBe(false);
    }
  });

  it('night hides the stars and moon, day shows the sun', () => {
    const sky = makeSky(isoT('2026-06-21T00:00:00Z'), { lat: LAT, lon: LON });
    const children = sky.children as (THREE.Mesh | THREE.Points)[];
    expect(children[0].visible).toBe(false); // sun below horizon at midnight
    expect(children[1].visible).toBe(false); // moon below horizon at midnight
    expect(children[2].visible).toBe(true); // stars out at night

    updateSky(sky, isoT('2026-06-21T12:00:00Z'), { lat: LAT, lon: LON });
    expect(children[0].visible).toBe(true); // sun up at noon
    expect(children[2].visible).toBe(false); // no stars at day
  });

  it('updateSky moves the sun to a finite on-sphere position without new children', () => {
    const sky = makeSky(isoT('2026-06-21T00:00:00Z'), { lat: LAT, lon: LON });
    const childCount = sky.children.length;
    updateSky(sky, isoT('2026-12-21T12:00:00Z'), { lat: LAT, lon: LON });
    expect(sky.children.length).toBe(childCount);
    const sun = sky.children[0] as THREE.Mesh;
    const r = Math.hypot(sun.position.x, sun.position.y, sun.position.z);
    expect(r).toBeCloseTo(1200, 0);
    expect(Number.isFinite(sun.position.x)).toBe(true);
    expect(Number.isFinite(sun.position.y)).toBe(true);
    expect(Number.isFinite(sun.position.z)).toBe(true);
  });
});
