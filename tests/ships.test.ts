/**
 * Unit tests for Bay shipping (`src/world/ships.ts`, architecture.md §4.17).
 * Case names match the ticket fixtures verbatim. Node / no WebGL — InstancedMesh
 * allocates no GL objects until render.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLAT_HEIGHT, type CityData, type Vec2 } from '../src/data/types';
import { syntheticCity } from '../src/data/synthetic';
import { project } from '../src/geo';
import { pointInPolygon } from '../src/world/collision';
import { SHIP_LANES, ShipFleet } from '../src/world/ships';

const SF: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'sf.json'), 'utf8'),
);

const SYNTH = syntheticCity();

/** Odd-parity water test over `rings` (architecture.md §4.6). */
function waterParity(p: Vec2, rings: Vec2[][]): number {
  let n = 0;
  for (const ring of rings) {
    if (pointInPolygon(p, ring)) n++;
  }
  return n;
}

/** InstancedMesh children of a fleet Group. */
function instances(fleet: ShipFleet): THREE.InstancedMesh[] {
  return fleet.object.children.filter(
    (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh,
  );
}

function isLambert(mesh: THREE.InstancedMesh): boolean {
  return mesh.material instanceof THREE.MeshLambertMaterial;
}

function isBasic(mesh: THREE.InstancedMesh): boolean {
  return mesh.material instanceof THREE.MeshBasicMaterial;
}

describe('SHIP_LANES', () => {
  it('every SF lane vertex lies on water (odd parity over sf.json rings)', () => {
    const rings = SF.water ?? [];
    expect(rings.length).toBeGreaterThan(0);
    const lanes = SHIP_LANES.sf ?? [];
    expect(lanes.length).toBe(3);
    for (const lane of lanes) {
      for (const [lon, lat] of lane.pts) {
        const p = project(lon, lat, SF.origin);
        const parity = waterParity(p, rings);
        expect(parity % 2).toBe(1);
      }
    }
  });
});

describe('ShipFleet', () => {
  it('SF fleet has 15 ships: 3 cargo + 12 sail', () => {
    const fleet = new ShipFleet('sf', SF, FLAT_HEIGHT);
    expect(fleet.count).toBe(15);
    expect(fleet.object).toBeInstanceOf(THREE.Group);
    const hulls = instances(fleet).filter(isLambert);
    const lights = instances(fleet).filter(isBasic);
    expect(hulls.map((m) => m.count).sort((a, b) => a - b)).toEqual([3, 12]);
    expect(lights.map((m) => m.count).sort((a, b) => a - b)).toEqual([3, 12]);
  });

  it('London and Kyiv fleets are inert (count 0, update is a no-op)', () => {
    const london = new ShipFleet('london', SYNTH, FLAT_HEIGHT);
    const kyiv = new ShipFleet('kyiv', SYNTH, FLAT_HEIGHT);
    expect(london.count).toBe(0);
    expect(kyiv.count).toBe(0);
    expect(london.object).toBeInstanceOf(THREE.Group);
    expect(kyiv.object).toBeInstanceOf(THREE.Group);
    expect(london.object.children.length).toBe(0);
    expect(kyiv.object.children.length).toBe(0);
    expect(() => london.update(0.5)).not.toThrow();
    expect(() => kyiv.update(0.5)).not.toThrow();
  });

  it('setNight toggles the lights meshes visible flag and lightsOn', () => {
    const fleet = new ShipFleet('sf', SF, FLAT_HEIGHT);
    const lights = instances(fleet).filter(isBasic);
    expect(lights.length).toBe(2);
    expect(fleet.lightsOn).toBe(false);
    for (const m of lights) expect(m.visible).toBe(false);

    fleet.setNight(true);
    expect(fleet.lightsOn).toBe(true);
    for (const m of lights) expect(m.visible).toBe(true);

    fleet.setNight(false);
    expect(fleet.lightsOn).toBe(false);
    for (const m of lights) expect(m.visible).toBe(false);
  });

  it('cargo hull spans 280 × 40 m with the waterline at y 0', () => {
    const fleet = new ShipFleet('sf', SF, FLAT_HEIGHT);
    const cargoHull = instances(fleet).find((m) => isLambert(m) && m.count === 3);
    expect(cargoHull).toBeDefined();
    const geo = cargoHull!.geometry;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(40, 5);
    expect(bb.max.z - bb.min.z).toBeCloseTo(280, 5);
    expect(bb.min.y).toBeCloseTo(-2, 5);
    expect(bb.min.y).toBeLessThan(0);
    expect(bb.max.y).toBeGreaterThan(0);
  });

  it('every fleet mesh disables frustum culling (lanes outrun the initial bounding sphere)', () => {
    const fleet = new ShipFleet('sf', SF, FLAT_HEIGHT);
    const meshes: THREE.InstancedMesh[] = [];
    for (const child of fleet.object.children) {
      expect(child).toBeInstanceOf(THREE.InstancedMesh);
      const mesh = child as THREE.InstancedMesh;
      expect(mesh.frustumCulled).toBe(false);
      meshes.push(mesh);
    }
    expect(meshes.length).toBe(4);
  });

  it('update advances ships without allocating per frame', () => {
    const fleet = new ShipFleet('sf', SF, FLAT_HEIGHT);
    const hulls = instances(fleet).filter(isLambert);
    expect(hulls.length).toBeGreaterThan(0);
    fleet.update(0);
    const refs = hulls.map((m) => m.instanceMatrix.array);
    const before = hulls.map((m) => Float32Array.from(m.instanceMatrix.array));
    fleet.update(1);
    for (let h = 0; h < hulls.length; h++) {
      const mesh = hulls[h]!;
      expect(mesh.instanceMatrix.array).toBe(refs[h]);
      expect(mesh.instanceMatrix.array).not.toEqual(before[h]);
      for (let i = 0; i < mesh.count; i++) {
        const te = mesh.instanceMatrix.array;
        const o = i * 16;
        const heading = -Math.atan2(te[o + 8]!, te[o]!);
        expect(Number.isFinite(heading)).toBe(true);
        expect(Number.isFinite(te[o + 12]!)).toBe(true);
        expect(Number.isFinite(te[o + 13]!)).toBe(true);
        expect(Number.isFinite(te[o + 14]!)).toBe(true);
      }
    }
  });
});
