/**
 * Floating landmark tags (T-0063): pure `landmarkAnchors` / `pickTags` and a
 * fake-camera projection through the DOM `Tags` pool (node vitest, no WebGL).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Building, CityData } from '../src/data/types';
import { Tags, landmarkAnchors, pickTags, type TagAnchor } from '../src/hud/tags';

function square(id: number, name: string | undefined, h: number, cx: number, cz: number, side = 10): Building {
  const half = side / 2;
  return {
    id,
    name,
    h,
    poly: [
      [cx - half, cz - half],
      [cx + half, cz - half],
      [cx + half, cz + half],
      [cx - half, cz + half],
    ],
  };
}

function cityOf(buildings: Building[]): CityData {
  return {
    v: 1,
    origin: { lat: 0, lon: 0 },
    bbox: [0, 0, 1, 1],
    buildings,
    roads: [],
    places: [],
  };
}

describe('landmarkAnchors', () => {
  it('landmarkAnchors returns only fixed/extra buildings with y = roofY + 4', () => {
    const city = cityOf([
      square(1, 'Saint Sophia Cathedral', 29, 0, 0),
      square(-1000, 'Motherland Monument', 102, 200, 0),
      square(2, 'Random House', 15, 50, 50),
      square(3, undefined, 20, 70, 70),
    ]);
    const anchors = landmarkAnchors(city, {
      'Saint Sophia Cathedral': { label: 'Sophia' },
    });
    expect(anchors).toHaveLength(2);
    const names = anchors.map((a) => a.name).sort();
    expect(names).toEqual(['Motherland Monument', 'Saint Sophia Cathedral']);

    const sophia = anchors.find((a) => a.name === 'Saint Sophia Cathedral')!;
    expect(sophia.label).toBe('Sophia');
    expect(sophia.x).toBeCloseTo(0);
    expect(sophia.z).toBeCloseTo(0);
    expect(sophia.y).toBeCloseTo(29 + 4);

    const mom = anchors.find((a) => a.name === 'Motherland Monument')!;
    expect(mom.label).toBe('Motherland Monument');
    expect(mom.x).toBeCloseTo(200);
    expect(mom.z).toBeCloseTo(0);
    expect(mom.y).toBeCloseTo(102 + 4);
  });

  it('an extra named like a fixed building uses its own name, not the fix label', () => {
    // OSM building `X` has a fix label, but the extra (id −1000) also called
    // `X` must be tagged with its own name (T-0070).
    const city = cityOf([
      square(1, 'X', 10, 0, 0),
      square(-1000, 'X', 20, 0, 100),
    ]);
    const anchors = landmarkAnchors(city, { X: { label: 'Plinth' } });
    expect(anchors).toHaveLength(2);
    const byX = anchors.filter((a) => a.x === 0);
    expect(byX).toHaveLength(2);
    const byZ = (z: number) => anchors.find((a) => a.z === z)!;
    expect(byZ(0).label).toBe('Plinth');
    expect(byZ(100).label).toBe('X');
  });
});

describe('pickTags', () => {
  it('pickTags returns nearest-first, caps at 8, excludes > 600 m', () => {
    const anchors: TagAnchor[] = [];
    // 10 points along +x at 50 m spacing: 50, 100, …, 500, plus one at 601.
    for (let i = 1; i <= 10; i++) {
      anchors.push({ name: `N${i}`, label: `N${i}`, x: i * 50, y: 4, z: 0 });
    }
    anchors.push({ name: 'Far', label: 'Far', x: 601, y: 4, z: 0 });
    anchors.push({ name: 'Edge', label: 'Edge', x: 600, y: 4, z: 0 });

    const picked = pickTags(anchors, 0, 0);
    expect(picked).toHaveLength(8);
    expect(picked.map((a) => a.name)).toEqual([
      'N1',
      'N2',
      'N3',
      'N4',
      'N5',
      'N6',
      'N7',
      'N8',
    ]);
    expect(picked.some((a) => a.name === 'Far')).toBe(false);
    expect(picked.some((a) => a.name === 'N9')).toBe(false);
    expect(picked.some((a) => a.name === 'N10')).toBe(false);

    // Exactly 600 m is kept when it is among the nearest 8.
    const edgeOnly = pickTags(
      [
        { name: 'Edge', label: 'Edge', x: 600, y: 4, z: 0 },
        { name: 'Far', label: 'Far', x: 601, y: 4, z: 0 },
      ],
      0,
      0,
    );
    expect(edgeOnly.map((a) => a.name)).toEqual(['Edge']);
  });
});

// Tiny stand-in for the DOM so `Tags` can run in the node vitest environment.
interface FakeElement {
  ownerDocument: FakeDocument;
  className: string;
  textContent: string;
  style: { display: string; left: string; top: string };
  append(...items: FakeElement[]): void;
}
interface FakeDocument {
  createElement(tag: string): FakeElement;
}

function makeFakeRoot(): { root: FakeElement; pool: () => FakeElement[] } {
  const created: FakeElement[] = [];
  const doc: FakeDocument = {
    createElement(_tag: string) {
      const el: FakeElement = {
        ownerDocument: doc,
        className: '',
        textContent: '',
        style: { display: '', left: '', top: '' },
        append() {
          /* unused */
        },
      };
      created.push(el);
      return el;
    },
  };
  const root: FakeElement = {
    ownerDocument: doc,
    className: '',
    textContent: '',
    style: { display: '', left: '', top: '' },
    append(...items: FakeElement[]) {
      void items;
    },
  };
  return { root, pool: () => created };
}

describe('Tags.update', () => {
  it('a fake camera projection test: a point behind the camera is hidden', () => {
    const { root, pool } = makeFakeRoot();
    const tags = new Tags(root as unknown as HTMLElement);
    expect(pool()).toHaveLength(8);

    const camera = new THREE.PerspectiveCamera(70, 1, 0.3, 2000);
    camera.rotation.order = 'YXZ';
    camera.position.set(0, 0, 0);
    camera.rotation.y = 0;
    camera.rotation.x = 0;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const behind: TagAnchor = { name: 'Back', label: 'Back', x: 0, y: 0, z: 10 };
    const front: TagAnchor = { name: 'Front', label: 'Front', x: 0, y: 0, z: -50 };
    tags.update([behind, front], camera, 800, 800);

    const els = pool();
    expect(els[0]!.style.display).toBe('none');
    expect(els[1]!.style.display).not.toBe('none');
    expect(els[1]!.textContent).toBe('Front');
    for (let i = 2; i < 8; i++) expect(els[i]!.style.display).toBe('none');
  });
});
