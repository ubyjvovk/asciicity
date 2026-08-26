/**
 * Unit tests for `src/world/traffic.ts` (T-0035): road graph building,
 * PathWalker wandering (straight advance, node turns, dead-end reversal,
 * determinism) and the BusFleet instanced-mesh contract.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { Road, RoadClass } from '../src/data/types';
import { mulberry32 } from '../src/data/synthetic';
import { buildRoadGraph, PathWalker, BusFleet, BoatFleet } from '../src/world/traffic';

function road(cls: RoadClass, pts: [number, number][], id = 1): Road {
  return { id, cls, pts };
}

/** Stub rand that always returns a fixed value. */
function stubRand(v = 0): () => number {
  return () => v;
}

describe('buildRoadGraph', () => {
  it('links a cross of roads into one shared central node with 4 adjacent edge-ends', () => {
    // Four 2-point primary arms meet at the centre (0,0) — the shared node.
    const roads = [
      road('primary', [[-100, 0], [0, 0]], 1),
      road('primary', [[100, 0], [0, 0]], 2),
      road('primary', [[0, -100], [0, 0]], 3),
      road('primary', [[0, 100], [0, 0]], 4),
    ];
    const g = buildRoadGraph(roads, ['primary', 'secondary']);
    expect(g.edges.length).toBe(4);
    // All four edges have (0,0) as one endpoint → a single degree-4 node.
    expect(g.adj.get('0,0')?.length).toBe(4);
    expect(g.nodes.size).toBe(5); // centre + 4 outer ends
    expect(g.nodes.get('0,0')).toEqual([0, 0]);
  });

  it('filters out roads outside the requested classes', () => {
    const roads = [
      road('primary', [[-100, 0], [100, 0]], 1),
      road('tertiary', [[-200, 0], [200, 0]], 2),
      road('footway', [[-300, 0], [300, 0]], 3),
    ];
    const g = buildRoadGraph(roads, ['primary', 'secondary']);
    expect(g.edges.length).toBe(1);
    // Only the primary ends exist as nodes.
    expect([...g.nodes.keys()].sort()).toEqual(['-100,0', '100,0']);
  });

  it('skips roads with fewer than two points', () => {
    const g = buildRoadGraph([road('primary', [[0, 0]], 1)], ['primary']);
    expect(g.edges.length).toBe(0);
  });
});

describe('PathWalker', () => {
  it('advances exactly dtMetres along a straight edge (position check)', () => {
    const g = buildRoadGraph([road('primary', [[0, 0], [100, 0]], 1)], ['primary']);
    const w = new PathWalker(g, stubRand(0)); // rand 0 → start at (0,0)
    expect(w.x).toBeCloseTo(0);
    expect(w.z).toBeCloseTo(0);
    w.advance(10);
    // 10 m east along the x axis.
    expect(w.x).toBeCloseTo(10, 5);
    expect(w.z).toBeCloseTo(0, 5);
    expect(w.heading).toBeCloseTo(Math.PI / 2, 5); // east
  });

  it('turns onto another edge at a shared node', () => {
    const g = buildRoadGraph(
      [
        road('primary', [[0, 0], [100, 0]], 1),
        road('primary', [[100, 0], [100, 100]], 2),
      ],
      ['primary'],
    );
    const w = new PathWalker(g, stubRand(0));
    w.advance(150); // 100 m to the node, then 50 m up edge 2
    expect(w.x).toBeCloseTo(100, 5);
    expect(w.z).toBeCloseTo(50, 5);
    // Edge 2 goes +z (south), heading = atan2(0, -100) = π.
    expect(w.heading).toBeCloseTo(Math.PI, 5);
  });

  it('reverses at a dead end', () => {
    const g = buildRoadGraph([road('primary', [[0, 0], [100, 0]], 1)], ['primary']);
    const w = new PathWalker(g, stubRand(0));
    w.advance(150); // 100 m to the far end, then 50 m back west
    expect(w.x).toBeCloseTo(50, 5);
    expect(w.z).toBeCloseTo(0, 5);
    expect(w.heading).toBeCloseTo(-Math.PI / 2, 5); // now facing west
  });

  it('reverseAtEnds ping-pongs: position returns toward start after passing an end', () => {
    const g = buildRoadGraph([road('primary', [[0, 0], [100, 0]], 1)], ['primary']);
    const w = new PathWalker(g, stubRand(0), true); // starts at (0,0), dir east
    w.advance(150); // 100 m to the far end, then 50 m back west
    expect(w.x).toBeCloseTo(50, 5); // returned toward the start
    expect(w.z).toBeCloseTo(0, 5);
    expect(w.heading).toBeCloseTo(-Math.PI / 2, 5); // now facing west
  });

  it('two walkers with the same seed follow identical positions for 100 steps', () => {
    const g = buildRoadGraph(
      [
        road('primary', [[-200, 0], [200, 0]], 1),
        road('primary', [[0, -200], [0, 200]], 2),
      ],
      ['primary'],
    );
    const a = new PathWalker(g, mulberry32(7));
    const b = new PathWalker(g, mulberry32(7));
    for (let i = 0; i < 100; i++) {
      a.advance(1);
      b.advance(1);
      expect(a.x).toBeCloseTo(b.x, 9);
      expect(a.z).toBeCloseTo(b.z, 9);
      expect(a.heading).toBeCloseTo(b.heading, 9);
    }
  });
});

describe('BusFleet', () => {
  it('empty road list → count 0 and update is a no-op', () => {
    const fleet = new BusFleet([], 12, 9);
    expect(fleet.count).toBe(0);
    expect(() => fleet.update(0.5)).not.toThrow();
    expect(fleet.object instanceof THREE.Group).toBe(true);
  });

  it('no matching road classes → count 0', () => {
    const fleet = new BusFleet([road('footway', [[0, 0], [50, 0]], 1)], 12, 9);
    expect(fleet.count).toBe(0);
  });

  it('creates one instanced bus per requested count and updates without allocation', () => {
    const fleet = new BusFleet(
      [road('primary', [[0, 0], [500, 0]], 1)],
      12,
      9,
    );
    expect(fleet.count).toBe(12);
    expect(fleet.object).toBeInstanceOf(THREE.InstancedMesh);
    const mesh = fleet.object as THREE.InstancedMesh;
    expect(mesh.count).toBe(12);
    const before = mesh.instanceMatrix.array.slice();
    const version = mesh.instanceMatrix.version;
    fleet.update(0.5); // buses move
    // `needsUpdate` is a setter-only property in three 0.185, so assert via version.
    expect(mesh.instanceMatrix.version).toBeGreaterThan(version);
    expect(mesh.instanceMatrix.array).not.toEqual(before);
  });

  it('defaults keep buses at y = 2.15 (flat world)', () => {
    const fleet = new BusFleet([road('primary', [[0, 0], [500, 0]], 1)], 1, 9);
    const mesh = fleet.object as THREE.InstancedMesh;
    fleet.update(1);
    for (let i = 0; i < fleet.count; i++) {
      expect(mesh.instanceMatrix.array[i * 16 + 13]).toBeCloseTo(2.15, 5);
    }
  });

  it('with heightAt = () => 10 every bus sits at y = 12.15 after one update', () => {
    const fleet = new BusFleet([road('primary', [[0, 0], [500, 0]], 1)], 12, 9, () => 10);
    const mesh = fleet.object as THREE.InstancedMesh;
    fleet.update(1);
    for (let i = 0; i < fleet.count; i++) {
      const y = mesh.instanceMatrix.array[i * 16 + 13];
      expect(y).toBeCloseTo(12.15, 5);
    }
  });

  it('with a plane heightAt = (x, z) => 0.1·x each bus y = 0.1·x + 2.15 for its own x', () => {
    const fleet = new BusFleet(
      [road('primary', [[0, 0], [500, 0]], 1)],
      12,
      9,
      (x) => 0.1 * x,
    );
    const mesh = fleet.object as THREE.InstancedMesh;
    fleet.update(1);
    for (let i = 0; i < fleet.count; i++) {
      const x = mesh.instanceMatrix.array[i * 16 + 12];
      const y = mesh.instanceMatrix.array[i * 16 + 13];
      expect(y).toBeCloseTo(0.1 * x + 2.15, 5);
    }
  });
});

describe('BoatFleet', () => {
  const RIVERS: [number, number][][] = [
    [[0, 0], [500, 0]],
    [[0, 0], [0, 300]],
  ];

  it('creates an instanced boat per requested count and updates without allocation', () => {
    const fleet = new BoatFleet(RIVERS, 4, 17);
    expect(fleet.count).toBe(4);
    expect(fleet.object).toBeInstanceOf(THREE.InstancedMesh);
    const mesh = fleet.object as THREE.InstancedMesh;
    expect(mesh.count).toBe(4);
    const before = mesh.instanceMatrix.array.slice();
    const version = mesh.instanceMatrix.version;
    fleet.update(0.5); // boats move
    expect(mesh.instanceMatrix.version).toBeGreaterThan(version);
    expect(mesh.instanceMatrix.array).not.toEqual(before);
  });

  it('defaults keep boats at y = 1.0 (flat world)', () => {
    const fleet = new BoatFleet(RIVERS, 4, 17);
    const mesh = fleet.object as THREE.InstancedMesh;
    fleet.update(1);
    for (let i = 0; i < fleet.count; i++) {
      expect(mesh.instanceMatrix.array[i * 16 + 13]).toBeCloseTo(1.0, 5);
    }
  });

  it('with heightAt = () => 10 every boat sits at y = 11.0 after one update', () => {
    const fleet = new BoatFleet(RIVERS, 4, 17, () => 10);
    const mesh = fleet.object as THREE.InstancedMesh;
    fleet.update(1);
    for (let i = 0; i < fleet.count; i++) {
      const y = mesh.instanceMatrix.array[i * 16 + 13];
      expect(y).toBeCloseTo(11.0, 5);
    }
  });

  it('with a plane heightAt = (x, z) => 0.1·x each boat y = 0.1·x + 1.0 for its own x', () => {
    const fleet = new BoatFleet(RIVERS, 4, 17, (x) => 0.1 * x);
    const mesh = fleet.object as THREE.InstancedMesh;
    fleet.update(1);
    for (let i = 0; i < fleet.count; i++) {
      const x = mesh.instanceMatrix.array[i * 16 + 12];
      const y = mesh.instanceMatrix.array[i * 16 + 13];
      expect(y).toBeCloseTo(0.1 * x + 1.0, 5);
    }
  });

  it('is seed-deterministic: two fleets with the same seed drive identical paths', () => {
    const a = new BoatFleet(RIVERS, 4, 17);
    const b = new BoatFleet(RIVERS, 4, 17);
    const ma = a.object as THREE.InstancedMesh;
    const mb = b.object as THREE.InstancedMesh;
    for (let i = 0; i < 50; i++) {
      a.update(0.5);
      b.update(0.5);
    }
    expect(ma.instanceMatrix.array).toEqual(mb.instanceMatrix.array);
  });

  it('boats ping-pong: reverse at the ends and stay on the polyline', () => {
    // One boat on one east-west polyline, run for far longer than one full
    // out-and-back. It must never leave [0, 500] and its velocity must change
    // sign at least once (it reversed at an end instead of one-way drifting).
    const fleet = new BoatFleet([[[0, 0], [500, 0]]], 1, 3);
    const mesh = fleet.object as THREE.InstancedMesh;
    let prevX = mesh.instanceMatrix.array[12];
    let prevDx: number | null = null;
    let sawReversal = false;
    for (let i = 0; i < 1000; i++) {
      fleet.update(0.5); // 4 m/s * 0.5 s = 2 m per step
      const x = mesh.instanceMatrix.array[12];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(500);
      const dx = x - prevX;
      if (dx !== 0) {
        if (prevDx !== null && Math.sign(dx) !== Math.sign(prevDx)) {
          sawReversal = true;
        }
        prevDx = dx;
      }
      prevX = x;
    }
    expect(sawReversal).toBe(true);
  });

  it('empty rivers → count 0 and update is a no-op', () => {
    const fleet = new BoatFleet([], 4, 17);
    expect(fleet.count).toBe(0);
    expect(() => fleet.update(0.5)).not.toThrow();
    expect(fleet.object instanceof THREE.Group).toBe(true);
  });
});
