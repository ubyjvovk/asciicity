/**
 * Cyberpunk cell streaming (wave 20b, src/render/punk/cells.ts): bucketing
 * and the build/dispose radius logic every geometry layer relies on.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CellStreamer, bucketSources, sourcesSignature, CELL_SIZE } from '../src/render/punk/cells';
import type { PunkSource } from '../src/render/punk/layer';
import type { Building, Road } from '../src/data/types';

const b = (id: number, x: number, z: number): Building => ({
  id,
  h: 20,
  poly: [
    [x, z],
    [x + 10, z],
    [x + 10, z + 10],
    [x, z + 10],
  ],
});
const r = (id: number, pts: [number, number][]): Road => ({ id, cls: 'residential', pts });

describe('bucketSources', () => {
  it('buckets buildings by first vertex and roads by middle vertex', () => {
    const src = new Map<string, PunkSource>([
      ['base', { buildings: [b(1, 10, 10), b(2, 260, 10), b(3, -5, -5)], roads: [r(9, [[0, 0], [300, 0], [600, 0]])] }],
    ]);
    const cells = bucketSources(src);
    expect(cells.get('0_0')?.buildings.map((x) => x.id)).toEqual([1]);
    expect(cells.get('1_0')?.buildings.map((x) => x.id)).toEqual([2]);
    expect(cells.get('-1_-1')?.buildings.map((x) => x.id)).toEqual([3]);
    expect(cells.get('1_0')?.roads.map((x) => x.id)).toEqual([9]);
    expect(cells.get('0_0')?.cx).toBeCloseTo(CELL_SIZE / 2);
  });

  it('signature changes when a chunk is added or removed', () => {
    const src = new Map<string, PunkSource>([['base', { buildings: [b(1, 0, 0)], roads: [] }]]);
    const s0 = sourcesSignature(src);
    src.set('0_0', { buildings: [b(2, 5, 5)], roads: [] });
    const s1 = sourcesSignature(src);
    expect(s1).not.toBe(s0);
    src.delete('0_0');
    expect(sourcesSignature(src)).toBe(s0);
  });
});

describe('CellStreamer', () => {
  const grid = (): Map<string, PunkSource> => {
    const buildings: Building[] = [];
    let id = 0;
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) buildings.push(b(id++, i * 250 + 5, j * 250 + 5));
    return new Map([['base', { buildings, roads: [] }]]);
  };

  it('builds nearest cells first, maxBuildsPerFrame per update, and disposes beyond disposeRadius', () => {
    const disposed: string[] = [];
    const s = new CellStreamer({
      buildRadius: 400,
      disposeRadius: 600,
      maxBuildsPerFrame: 2,
      build: (c) => Object.assign(new THREE.Object3D(), { name: c.key }),
      dispose: (o) => disposed.push(o.name),
    });
    const root = new THREE.Object3D();
    const src = grid();
    s.update(src, 125, 125, root);
    expect(root.children.map((o) => o.name)[0]).toBe('0_0');
    expect(root.children).toHaveLength(2);
    for (let k = 0; k < 20; k++) s.update(src, 125, 125, root);
    // centres within 400 m of (125,125): the 3×3 block around 0_0 (diag 354 m) = 9 cells
    expect(root.children).toHaveLength(9);
    expect(s.stats().pending).toBe(0);
    // Walk 1500 m east: everything old is > 600 m away → disposed.
    for (let k = 0; k < 20; k++) s.update(src, 1625, 125, root);
    expect(disposed).toContain('0_0');
    expect(root.children.every((o) => Number(o.name.split('_')[0]) >= 4)).toBe(true);
  });

  it('rebuilds only the cells whose content changed when the sources change, and clear() empties the root', () => {
    let builds = 0;
    const rebuilt: string[] = [];
    const s = new CellStreamer({
      buildRadius: 200,
      disposeRadius: 400,
      maxBuildsPerFrame: 10,
      build: (c) => {
        builds++;
        rebuilt.push(c.key);
        return new THREE.Object3D();
      },
      dispose: () => {},
    });
    const root = new THREE.Object3D();
    const src = grid();
    s.update(src, 250, 250, root);
    const first = builds;
    s.update(src, 250, 250, root);
    expect(builds).toBe(first);
    expect(first).toBeGreaterThan(1);
    rebuilt.length = 0;
    // A new chunk touching only cell 0_0: only that cell rebuilds.
    src.set('extra', { buildings: [b(999, 30, 30)], roads: [] });
    s.update(src, 250, 250, root);
    expect(rebuilt).toEqual(['0_0']);
    expect(builds).toBe(first + 1);
    // Removing it restores the old content: 0_0 rebuilds again, nothing else.
    rebuilt.length = 0;
    src.delete('extra');
    s.update(src, 250, 250, root);
    expect(rebuilt).toEqual(['0_0']);
    s.clear(root);
    expect(root.children).toHaveLength(0);
  });
});

import { hash2, vnoise, fbm2 } from '../src/render/punk/noise';

describe('punk noise mirrors', () => {
  it('hash2 / vnoise / fbm2 stay in [0, 1) and vnoise interpolates lattice values', () => {
    for (let i = 0; i < 500; i++) {
      const x = i * 0.37 - 50;
      const y = i * 0.91 + 3;
      for (const v of [hash2(x, y), vnoise(x, y), fbm2(x, y)]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
    expect(vnoise(3, 4)).toBeCloseTo(hash2(3, 4));
  });
});
