/**
 * Bootstrap smoke tests (T-0001): sanity-check that three.js and the PM-owned
 * MeshBuilder are wired up and usable from the vitest (node) environment.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MeshBuilder } from '../src/world/mesh';

describe('bootstrap', () => {
  it('three.js Vector3 length is 5 for (3, 4, 0)', () => {
    expect(new THREE.Vector3(3, 4, 0).length()).toBeCloseTo(5);
  });

  it('MeshBuilder builds a 1-triangle mesh with 9 positions and one group of count 3', () => {
    const b = new MeshBuilder();
    b.triangle(
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1, 1],
    );
    const m = b.build();
    expect(m.positions.length).toBe(9);
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].count).toBe(3);
  });
});
