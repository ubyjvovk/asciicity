/**
 * Unit tests for `src/world/traffic.ts` (T-0035): road graph building,
 * PathWalker wandering (straight advance, node turns, dead-end reversal,
 * determinism) and the BusFleet instanced-mesh contract.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { Road, RoadClass } from '../src/data/types';
import { mulberry32 } from '../src/data/synthetic';
import { buildRoadGraph, PathWalker, BusFleet } from '../src/world/traffic';

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
});
