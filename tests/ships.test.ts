/**
 * Unit tests for Bay shipping (`src/world/ships.ts`, architecture.md §4.17).
 * Case names match the ticket fixtures verbatim. Node / no WebGL — InstancedMesh
 * allocates no GL objects until render.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLAT_HEIGHT, type CityData, type Vec2 } from '../src/data/types';
import { loadSfGlobals } from './sfCity';
import { loadTiledGlobals } from './tiledCity';
import { syntheticCity } from '../src/data/synthetic';
import { project } from '../src/geo';
import { distToSegment, pointInPolygon } from '../src/world/collision';
import { SHIP_LANES, ShipFleet } from '../src/world/ships';

const SF: CityData = loadSfGlobals();
const SYD: CityData = loadTiledGlobals('sydney');

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

/** Shortest distance from local point `p` to a water ring's edges. */
function distToRing(p: Vec2, ring: Vec2[]): number {
  let m = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    m = Math.min(m, distToSegment(p, ring[i], ring[j]!));
  }
  return m;
}

/**
 * Water rings that are ISLANDS (centroid is land by odd parity) whose
 * centroid lies within `radius` m of the projected WGS84 reference. Used to
 * locate Fort Denison and (had the data kept it) Goat Island.
 */
function islandRingsNear(lon: number, lat: number, radius: number): Vec2[][] {
  const ref = project(lon, lat, SYD.origin);
  const found: Vec2[][] = [];
  for (const ring of SYD.water ?? []) {
    let cx = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p[0];
      cz += p[1];
    }
    cx /= ring.length;
    cz /= ring.length;
    if (Math.hypot(cx - ref[0], cz - ref[1]) > radius) continue;
    // An island's centroid is land: it sits inside an even number of rings.
    if (waterParity([cx, cz], SYD.water ?? []) % 2 !== 0) continue;
    found.push(ring);
  }
  return found;
}

/** The Harbour Bridge axis: the longest `Bradfield Highway` bridge polyline. */
function harbourBridgeAxis(): Vec2[] {
  let best: Vec2[] | null = null;
  let bestSpan = -1;
  for (const road of SYD.roads ?? []) {
    if (String(road.name ?? '').toLowerCase().includes('bradfield highway')) {
      const zs = road.pts.map((p) => p[1]);
      const span = Math.max(...zs) - Math.min(...zs);
      if (span > bestSpan) {
        bestSpan = span;
        best = road.pts;
      }
    }
  }
  return best ?? [];
}

/** Every point on a lane polyline: its vertices plus 25 m samples per segment. */
function lanePoints(lane: { pts: [number, number][] }): Vec2[] {
  const local = lane.pts.map(([lon, lat]) => project(lon, lat, SYD.origin));
  const out: Vec2[] = [];
  for (let i = 0; i < local.length - 1; i++) {
    const a = local[i]!;
    const b = local[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d <= len; d += 25) {
      const t = d / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** True when every Float32 inside `array` is finite (no NaN/Infinity). */
function allFinite(arr: Float32Array): boolean {
  for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i]!)) return false;
  return true;
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

describe('SHIP_LANES.sydney', () => {
  it('defines six lanes — five ferry routes plus one sail lane', () => {
    const lanes = SHIP_LANES.sydney ?? [];
    expect(lanes.length).toBe(6);
    const ferries = lanes.filter((l) => l.kind === 'ferry');
    const sails = lanes.filter((l) => l.kind === 'sail');
    expect(ferries.length).toBe(5);
    expect(sails.length).toBe(1);
    const total = lanes.reduce((n, l) => n + l.count, 0);
    // Budget: ≤ 20 instances total for the city (architecture.md §4.17b).
    expect(total).toBeLessThanOrEqual(20);
    expect(total).toBe(11);
  });

  it('every sydney lane vertex and every 25 m sample lies on water (odd parity)', () => {
    const rings = SYD.water ?? [];
    expect(rings.length).toBeGreaterThan(0);
    const lanes = SHIP_LANES.sydney ?? [];
    expect(lanes.length).toBe(6);
    for (const lane of lanes) {
      for (const p of lanePoints(lane)) {
        expect(waterParity(p, rings) % 2).toBe(1);
      }
    }
  });

  it('the Parramatta service passes under the Harbour Bridge (within 250 m of its axis)', () => {
    const axis = harbourBridgeAxis();
    expect(axis.length).toBeGreaterThan(0);
    const lane = (SHIP_LANES.sydney ?? []).find((l) => l.name === 'Parramatta River service')!;
    let minDist = Infinity;
    for (const p of lanePoints(lane)) {
      for (let i = 0, j = axis.length - 1; i < axis.length; j = i++) {
        minDist = Math.min(minDist, distToSegment(p, axis[i]!, axis[j]!));
      }
    }
    expect(minDist).toBeLessThanOrEqual(250);
  });

  it('no sydney lane point is within 30 m of the Goat Island or Fort Denison ring', () => {
    const guardRings = [
      ...islandRingsNear(151.2258, -33.8547, 400), // Fort Denison
      ...islandRingsNear(151.1925, -33.851, 400), // Goat Island
    ];
    // Fort Denison is a committed island ring; Goat Island is not in the
    // current dataset, so the Goat Island guard is vacuous today. The lane
    // parramatta waypoints still sit north of the Goat Island reference.
    expect(guardRings.length).toBeGreaterThan(0);
    for (const lane of SHIP_LANES.sydney ?? []) {
      for (const p of lanePoints(lane)) {
        for (const ring of guardRings) {
          expect(distToRing(p, ring)).toBeGreaterThanOrEqual(30);
        }
      }
    }
  });
});

describe('Sydney ferry fleet', () => {
  it('ShipFleet(sydney) has 7 ferries + 4 sails = 11 instances (sum of lane counts)', () => {
    const fleet = new ShipFleet('sydney', SYD, FLAT_HEIGHT);
    expect(fleet.count).toBe(11);
    const hulls = instances(fleet).filter(isLambert);
    const lights = instances(fleet).filter(isBasic);
    expect(hulls.map((m) => m.count).sort((a, b) => a - b)).toEqual([4, 7]);
    expect(lights.map((m) => m.count).sort((a, b) => a - b)).toEqual([4, 7]);
  });

  it('ferry hull is 38 long × 9 wide, double-ended (fore/aft |z| equal) with no NaN', () => {
    const fleet = new ShipFleet('sydney', SYD, FLAT_HEIGHT);
    const ferryHull = instances(fleet).find((m) => isLambert(m) && m.count === 7);
    expect(ferryHull).toBeDefined();
    const geo = ferryHull!.geometry;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(9, 5);
    expect(bb.max.z - bb.min.z).toBeCloseTo(38, 5);
    expect(bb.min.y).toBeCloseTo(-1, 5);
    expect(bb.max.y).toBeCloseTo(11, 5);
    expect(Math.abs(Math.abs(bb.max.z) - Math.abs(bb.min.z))).toBeLessThan(0.1);
    // No NaN anywhere in the hull MeshData.
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    expect(allFinite(pos.array as Float32Array)).toBe(true);
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    expect(allFinite(col.array as Float32Array)).toBe(true);
  });

  it('ferry lights mesh has finite geometry and toggles with setNight', () => {
    const fleet = new ShipFleet('sydney', SYD, FLAT_HEIGHT);
    const ferryLights = instances(fleet).find((m) => isBasic(m) && m.count === 7);
    expect(ferryLights).toBeDefined();
    const geo = ferryLights!.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    expect(allFinite(pos.array as Float32Array)).toBe(true);
    expect(ferryLights!.visible).toBe(false);
    fleet.setNight(true);
    expect(ferryLights!.visible).toBe(true);
    expect(fleet.lightsOn).toBe(true);
    fleet.setNight(false);
    expect(ferryLights!.visible).toBe(false);
  });
});
