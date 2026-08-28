/**
 * Unit tests for the committed `public/data/sf.json` dataset (T-0077): the
 * Golden Gate Bridge roadway is `highway=motorway`, so it must arrive as a
 * `cls: 'primary'` bridge road (and the two sidewalks must survive).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CityData } from '../src/data/types';
import { project } from '../scripts/osm-convert';

const SF: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'sf.json'), 'utf8'),
);

// SF fetch origin (package.json `fetch-data:sf`).
const ORIGIN = { lon: -122.4075, lat: 37.788 };
// SF bbox (minLon,minLat,maxLon,maxLat) — same as the fetch CLI.
const BBOX = [-122.487, 37.764, -122.383, 37.835];

describe('sf.json Golden Gate Bridge roadway (T-0077)', () => {
  it('sf.json carries the Golden Gate Bridge roadway as a primary bridge road', () => {
    const roadways = SF.roads.filter(
      (r) => r.name === 'Golden Gate Bridge' && r.cls === 'primary' && r.bridge === true,
    );
    expect(roadways.length).toBeGreaterThanOrEqual(1);
  });

  it('every Golden Gate Bridge roadway point falls inside the sf bbox', () => {
    // Project the bbox corners to local metres (same project() as the
    // converter) and require every roadway point inside the rectangle.
    const corners: Array<[number, number]> = [
      [BBOX[0], BBOX[1]],
      [BBOX[2], BBOX[1]],
      [BBOX[2], BBOX[3]],
      [BBOX[0], BBOX[3]],
    ];
    const proj = corners.map(([lon, lat]) => project(lon, lat, ORIGIN));
    const xs = proj.map(([x]) => x);
    const zs = proj.map(([, z]) => z);
    const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
    const [minZ, maxZ] = [Math.min(...zs), Math.max(...zs)];

    const roadways = SF.roads.filter(
      (r) => r.name === 'Golden Gate Bridge' && r.cls === 'primary' && r.bridge === true,
    );
    expect(roadways.length).toBeGreaterThanOrEqual(1);
    for (const r of roadways) {
      for (const [x, z] of r.pts) {
        expect(x).toBeGreaterThanOrEqual(minX);
        expect(x).toBeLessThanOrEqual(maxX);
        expect(z).toBeGreaterThanOrEqual(minZ);
        expect(z).toBeLessThanOrEqual(maxZ);
      }
    }
  });

  it('sf.json still carries both Golden Gate Bridge sidewalks', () => {
    const east = SF.roads.filter(
      (r) => r.name === 'Golden Gate Bridge East Sidewalk',
    );
    const west = SF.roads.filter(
      (r) => r.name === 'Golden Gate Bridge West Sidewalk',
    );
    expect(east.length).toBeGreaterThanOrEqual(1);
    expect(west.length).toBeGreaterThanOrEqual(1);
    for (const r of [...east, ...west]) {
      expect(r.cls).toBe('pedestrian');
      expect(r.bridge).toBe(true);
    }
  });

  it('sf.json is under 16 MB and passes validateCity', async () => {
    const raw = readFileSync(
      resolve(__dirname, '..', 'public', 'data', 'sf.json'),
      'utf8',
    );
    expect(raw.length).toBeLessThan(16 * 1024 * 1024);
    const { validateCity } = await import('../src/data/validate');
    expect(() => validateCity(SF)).not.toThrow();
  });
});
