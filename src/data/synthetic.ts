/**
 * Deterministic synthetic test city (docs/data-format.md §Synthetic city).
 * Pure: no DOM/WebGL. Same seed ⇒ byte-identical output.
 */
import type { Building, CityData, Place, Road, RoadClass } from './types';

/** Seeded 32-bit PRNG (mulberry32) returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Block side length in metres. */
const BLOCK = 60;

/** Street width between blocks in metres. */
const STREET = 14;

/** Centre-to-centre spacing of blocks (and streets). */
const PITCH = BLOCK + STREET;

/** Building inset from each block edge in metres. */
const INSET = 4;

/** Building half-extent in metres. */
const HALF = BLOCK / 2 - INSET; // 26

/** Round to 0.1 m as the fetch script does for the real file. */
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Build a deterministic Manhattan grid of `blocks × blocks` blocks centred on
 * the origin, with alternating `primary`/`residential` streets and one place.
 * With `hills` also emits a `terrain` grid (step 20, covering the block extent
 * plus one margin cell, `datum` 0) so hills can be exercised without real data.
 */
export function syntheticCity(seed = 1, blocks = 12, hills = false): CityData {
  const rand = mulberry32(seed);
  const origin = { lat: 51.5133, lon: -0.0887 };
  const bbox: [number, number, number, number] = [
    -0.106,
    51.506,
    -0.07,
    51.521,
  ];

  const buildings: Building[] = [];
  for (let j = 0; j < blocks; j++) {
    for (let i = 0; i < blocks; i++) {
      const cx = (i - (blocks - 1) / 2) * PITCH;
      const cz = (j - (blocks - 1) / 2) * PITCH;
      const h = r1(8 + rand() * (120 - 8));
      const building: Building = {
        id: j * blocks + i + 1,
        h,
        poly: [
          [r1(cx - HALF), r1(cz - HALF)],
          [r1(cx - HALF), r1(cz + HALF)],
          [r1(cx + HALF), r1(cz + HALF)],
          [r1(cx + HALF), r1(cz - HALF)],
        ],
      };
      if ((j * blocks + i) % 5 === 0) {
        building.name = `Block ${j * blocks + i}`;
      }
      buildings.push(building);
    }
  }

  const roads: Road[] = [];
  const half = (blocks / 2) * PITCH;
  // North–south avenues.
  for (let n = 0; n <= blocks; n++) {
    const x = (n - blocks / 2) * PITCH;
    const cls: RoadClass = n % 4 === 0 ? 'primary' : 'residential';
    roads.push({
      id: n + 1,
      name: `Avenue ${n}`,
      cls,
      pts: [
        [r1(x), r1(-half)],
        [r1(x), r1(half)],
      ],
    });
  }
  // East–west streets.
  for (let n = 0; n <= blocks; n++) {
    const z = (n - blocks / 2) * PITCH;
    const cls: RoadClass = n % 4 === 0 ? 'primary' : 'residential';
    roads.push({
      id: (blocks + 1) + n + 1,
      name: `Street ${n}`,
      cls,
      pts: [
        [r1(-half), r1(z)],
        [r1(half), r1(z)],
      ],
    });
  }

  const places: Place[] = [{ name: 'Centre', x: 0, z: 0 }];

  const city: CityData = { v: 1, origin, bbox, buildings, roads, places };
  if (hills) {
    const step = 20;
    const extent = (blocks * 74) / 2;
    const minX = -extent;
    const maxX = extent;
    const minZ = -extent;
    const maxZ = extent;
    const x0 = Math.floor(minX / step) * step - step;
    const z0 = Math.floor(minZ / step) * step - step;
    const cols = Math.ceil((maxX - x0) / step) + 2;
    const rows = Math.ceil((maxZ - z0) / step) + 2;
    const h = (x: number, z: number) =>
      30 * Math.exp(-((x - 200) ** 2 + (z + 150) ** 2) / (2 * 220 ** 2)) +
      z / 200;
    const heights: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + c * step;
        const z = z0 + r * step;
        heights.push(r1(h(x, z)));
      }
    }
    city.terrain = { x0, z0, step, cols, rows, datum: 0, heights };
  }
  return city;
}
