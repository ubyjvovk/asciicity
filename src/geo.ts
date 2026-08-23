/**
 * WGS84 → local-metre equirectangular projection (docs/data-format.md
 * §Coordinate system). Pure: no DOM/WebGL. x = east, z = south.
 */
import type { Vec2 } from './data/types';

/** Metres per degree of latitude (fixed). */
export const M_PER_DEG_LAT = 110574;

/** Metres per degree of longitude at the equator. */
export const M_PER_DEG_LON_EQ = 111320;

/**
 * Project a WGS84 point to local metres relative to `origin`.
 * `x = (lon − origin.lon) · cos(origin.lat°) · 111320`, `z = −(lat − origin.lat) · 110574`.
 */
export function project(
  lon: number,
  lat: number,
  origin: { lat: number; lon: number },
): Vec2 {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const x = (lon - origin.lon) * cosLat * M_PER_DEG_LON_EQ;
  const z = -(lat - origin.lat) * M_PER_DEG_LAT;
  return [x, z];
}

/**
 * Inverse of `project`: convert local metres back to a WGS84 point relative to `origin`.
 */
export function unproject(
  x: number,
  z: number,
  origin: { lat: number; lon: number },
): { lon: number; lat: number } {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const lon = origin.lon + x / (cosLat * M_PER_DEG_LON_EQ);
  const lat = origin.lat - z / M_PER_DEG_LAT;
  return { lon, lat };
}
