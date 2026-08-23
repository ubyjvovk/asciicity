/**
 * MeshBuilder / toGeometry (PM-owned src/world/mesh.ts, covered by T-0004).
 */
import { describe, expect, it } from 'vitest';
import { MeshBuilder, toGeometry } from '../src/world/mesh';

describe('MeshBuilder', () => {
  it('vertexCount starts at 0 and tracks pushed vertices', () => {
    const b = new MeshBuilder();
    expect(b.vertexCount).toBe(0);
    b.vertex([0, 0, 0], [0, 1, 0], [0, 0], [1, 1, 1]);
    expect(b.vertexCount).toBe(1);
    b.vertex([1, 0, 0], [0, 1, 0], [1, 0], [1, 0, 0]);
    expect(b.vertexCount).toBe(2);
  });

  it('triangle pushes 3 vertices with the given normal/colour', () => {
    const b = new MeshBuilder();
    const n: [number, number, number] = [0, 0, 1];
    const color: [number, number, number] = [0.2, 0.4, 0.6];
    b.triangle([0, 0, 0], [1, 0, 0], [0, 1, 0], n, [0, 0], [1, 0], [0, 1], color);
    expect(b.vertexCount).toBe(3);
    const m = b.build();
    expect(Array.from(m.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(m.normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(Array.from(m.uvs)).toEqual([0, 0, 1, 0, 0, 1]);
    const colors = Array.from(m.colors);
    expect(colors).toHaveLength(9);
    for (let i = 0; i < 3; i++) {
      expect(colors[i * 3]).toBeCloseTo(0.2);
      expect(colors[i * 3 + 1]).toBeCloseTo(0.4);
      expect(colors[i * 3 + 2]).toBeCloseTo(0.6);
    }
  });

  it('quad pushes 6 vertices (two triangles a,b,c and a,c,d)', () => {
    const b = new MeshBuilder();
    const n: [number, number, number] = [0, 1, 0];
    const color: [number, number, number] = [1, 0, 0];
    b.quad(
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      n,
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      color,
    );
    expect(b.vertexCount).toBe(6);
    const m = b.build();
    expect(Array.from(m.positions)).toEqual([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1,
    ]);
    expect(m.normals.length).toBe(18);
    expect(m.colors.length).toBe(18);
    expect(m.uvs.length).toBe(12);
  });

  it('endGroup records start/count/materialIndex', () => {
    const b = new MeshBuilder();
    b.triangle([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0], [1, 0], [0, 1], [1, 1, 1]);
    b.endGroup(2);
    b.triangle([0, 0, 1], [1, 0, 1], [0, 1, 1], [0, 0, 1], [0, 0], [1, 0], [0, 1], [0, 0, 0]);
    b.endGroup(1);
    const m = b.build();
    expect(m.groups).toEqual([
      { start: 0, count: 3, materialIndex: 2 },
      { start: 3, count: 3, materialIndex: 1 },
    ]);
  });

  it('build() closes a trailing group as material 0', () => {
    const b = new MeshBuilder();
    b.triangle([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 0], [0, 1], [1, 1, 1]);
    const m = b.build();
    expect(m.groups).toEqual([{ start: 0, count: 3, materialIndex: 0 }]);
  });
});

describe('toGeometry', () => {
  it('toGeometry sets the four attributes with the right item sizes and the groups', () => {
    const b = new MeshBuilder();
    b.triangle([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0], [1, 0], [0, 1], [1, 0, 0]);
    b.endGroup(0);
    b.quad(
      [0, 1, 0],
      [1, 1, 0],
      [1, 1, 1],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 1, 0],
    );
    b.endGroup(1);
    const m = b.build();
    const g = toGeometry(m);
    const position = g.getAttribute('position');
    const normal = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const color = g.getAttribute('color');
    expect(position.itemSize).toBe(3);
    expect(normal.itemSize).toBe(3);
    expect(uv.itemSize).toBe(2);
    expect(color.itemSize).toBe(3);
    expect(position.count).toBe(9);
    expect(normal.count).toBe(9);
    expect(uv.count).toBe(9);
    expect(color.count).toBe(9);
    expect(g.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 6, materialIndex: 1 },
    ]);
  });
});
