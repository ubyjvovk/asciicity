/**
 * Unit tests for `src/world/trees.ts` (T-0066): the pure `buildTreeInstances`
 * geometry + seeded canopy colours, and the `TreeField` browser wrapper's
 * two-instanced-mesh contract. Matrices are column-major like `THREE.Matrix4`
 * (translation at elements 12/13/14, axis scales at 0/5/10).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildTreeInstances, TreeField } from '../src/world/trees';

/** HeightAt stubbed to a fixed ground level, per the ticket. */
const flat10: (x: number, z: number) => number = () => 10;

describe('buildTreeInstances', () => {
  it('places one canopy at (0, 10 + 12 − 3.2 = 18.8, 0) scaled (4, 3.2, 4)', () => {
    const inst = buildTreeInstances([[0, 0, 12, 4]], flat10);
    expect(inst.count).toBe(1);
    // canopy matrix = indices [0, 16)
    expect(inst.matrices[0]).toBeCloseTo(4, 5); // scale x
    expect(inst.matrices[5]).toBeCloseTo(3.2, 5); // scale y
    expect(inst.matrices[10]).toBeCloseTo(4, 5); // scale z
    expect(inst.matrices[12]).toBeCloseTo(0, 5); // tx
    expect(inst.matrices[13]).toBeCloseTo(18.8, 5); // ty = y0 + h − 0.8r
    expect(inst.matrices[14]).toBeCloseTo(0, 5); // tz
  });

  it('scales the trunk to height h − 0.8r with its base at y0 = 10', () => {
    const inst = buildTreeInstances([[0, 0, 12, 4]], flat10);
    const base = 16; // trunk matrix = indices [16, 32)
    expect(inst.matrices[base + 5]).toBeCloseTo(8.8, 5); // scale y = 12 − 3.2
    // x/z scales must stay 1 so the (unit-radius) cylinder keeps its girth.
    expect(inst.matrices[base + 0]).toBeCloseTo(1, 5);
    expect(inst.matrices[base + 10]).toBeCloseTo(1, 5);
    // centre sits at y0 + trunkH/2 so the base lands exactly on y0.
    expect(inst.matrices[base + 13] - inst.matrices[base + 5] / 2).toBeCloseTo(10, 5);
    expect(inst.matrices[base + 12]).toBeCloseTo(0, 5);
    expect(inst.matrices[base + 14]).toBeCloseTo(0, 5);
  });

  it('gives canopy colours inside the §4.14 olive/green HSL ranges over 200 seeded trees', () => {
    const trees = Array.from({ length: 200 }, (_, i) => [i, i * 0.5, 10 + (i % 12), 2 + (i % 6)] as [
      number,
      number,
      number,
      number,
    ]);
    const inst = buildTreeInstances(trees, flat10);
    expect(inst.count).toBe(200);
    for (let i = 0; i < inst.count; i++) {
      const c = new THREE.Color().fromArray(inst.colors as Float32Array, 3 * i);
      // stored linear → sRGB, then read back the original CSS HSL values.
      c.convertLinearToSRGB();
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      const hueDeg = hsl.h * 360;
      expect(hueDeg).toBeGreaterThanOrEqual(95);
      expect(hueDeg).toBeLessThan(130);
      expect(hsl.s).toBeGreaterThanOrEqual(0.45);
      expect(hsl.s).toBeLessThan(0.7);
      expect(hsl.l).toBeGreaterThanOrEqual(0.22);
      expect(hsl.l).toBeLessThan(0.38);
    }
  });

  it('is deterministically seeded (same seed identical, different seed differs)', () => {
    const trees = [[0, 0, 12, 4], [5, 5, 9, 2], [-3, 7, 15, 5]] as [number, number, number, number][];
    const a = buildTreeInstances(trees, flat10, 5);
    const b = buildTreeInstances(trees, flat10, 5);
    const c = buildTreeInstances(trees, flat10, 99);
    expect(Array.from(a.matrices)).toEqual(Array.from(b.matrices));
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
    // The PRNG drives colours only, so a different seed must change the palette.
    expect(Array.from(a.colors)).not.toEqual(Array.from(c.colors));
  });

  it('reports count 0 and empty arrays for no trees', () => {
    const inst = buildTreeInstances([], flat10);
    expect(inst.count).toBe(0);
    expect(inst.matrices.length).toBe(0);
    expect(inst.colors.length).toBe(0);
  });

  it('reports count 3 with two meshes worth of matrices and one colour per canopy', () => {
    const inst = buildTreeInstances([[0, 0, 12, 4], [5, 5, 9, 2], [-3, 7, 15, 5]], flat10);
    expect(inst.count).toBe(3);
    expect(inst.matrices.length).toBe(2 * 16 * 3);
    expect(inst.colors.length).toBe(3 * 3);
  });
});

describe('TreeField', () => {
  it('exposes an object with two instanced meshes and the tree count', () => {
    const field = new TreeField([[0, 0, 12, 4], [5, 5, 9, 2]], flat10);
    expect(field.count).toBe(2);
    expect(field.object.type).toBe('Group');
    const meshes = (field.object as THREE.Group).children.filter(
      (o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh,
    );
    expect(meshes.length).toBe(2);
    expect(meshes.every((m) => m.count === 2)).toBe(true);
  });

  it('yields an empty group with count 0 for no trees', () => {
    const field = new TreeField([], flat10);
    expect(field.count).toBe(0);
    expect(field.object.type).toBe('Group');
    expect((field.object as THREE.Group).children.length).toBe(0);
  });
});
