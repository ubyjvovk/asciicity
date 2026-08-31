/**
 * Synthesised suspension-bridge structure (docs/architecture.md §4.16).
 * Pure geometry via MeshBuilder; the OSM sidewalks only supply the deck
 * path and height samples. Visual-only: nothing is registered for collision.
 */
import * as THREE from 'three';
import { FLAT_HEIGHT, type CityData, type HeightFn, type Vec2 } from '../data/types';
import { project } from '../geo';
import type { TagAnchor } from '../hud/tags';
import { MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';
import type { DeckHump } from './terrain';

const UV: UV = [0, 0];
/** Cable / hanger sample spacing (m). */
const STEP = 16;
/** Truss box depth (m). */
const TRUSS_DEPTH = 7.6;
/** Road/sidewalk ribbons render above the truss top. */
const TRUSS_TOP_BELOW_DECK = 0.4;
/** Main-cable clearance above the deck at mid-span (m). */
const MIDSPAN_CLEAR = 3;
/** Cable square-section side (m). */
const CABLE_W = 1.2;
/** Hanger square-section side (m). */
const HANGER_W = 0.6;
/** Skip hangers shorter than this (m). */
const HANGER_MIN = 2;
/** Leg size in the deck frame (across × along, m). */
const LEG_ACROSS = 10;
const LEG_ALONG = 12;
/** Portal opening: 2 m posts at each across-face, 8 m tall. */
const POST_THICK = 2;
const PORTAL_BELOW = 1;
const PORTAL_ABOVE = 7;
/** Portal struts: 8 m tall, 10 m along, at these heights above the deck. */
const STRUT_LEVELS = [30, 70, 110, 150] as const;
const STRUT_H = 8;
const STRUT_ALONG = 10;
/**
 * Max deck-box piece length before sloped subdivision (m, T-0084). Ticket
 * caps at ≤ 50 m; 25 m keeps every top-edge vertex within 12.5 m along of
 * any 25 m sample point, so the ribbon (deck + 0.15) stays > 0.4 m above
 * the piecewise-linear box top everywhere the profile rises ≥ 3 %/m — well
 * under the tests' 0.1 m tolerance for the actual GGB profile.
 */
const DECK_BOX_MAX_PIECE = 25;
/** Anchorage block. */
const ANCH_ALONG = 25;
const ANCH_H = 14;
const ANCH_TOP_ABOVE_DECK = 2;
/** Tag lift above the tower top (m). */
const TAG_LIFT = 4;
/** Joint-dedup radius when concatenating sidewalk pieces (m). */
const JOINT_EPS = 0.5;

/** Spec for a synthesised suspension bridge (architecture.md §4.16). */
export interface SuspensionBridgeSpec {
  /** Display name, e.g. `'Golden Gate Bridge'`. */
  name: string;
  /**
   * Exact road names of the deck-edge walkway polylines (`bridge: true`).
   * Two names = east then west; one name (wave 10) = the walkway is the
   * deck axis and `deckWidth` is required.
   */
  sidewalks: [string, string] | [string];
  /** Full deck width in metres; required with one walkway. */
  deckWidth?: number;
  /** Deck height at mid-span, metres above sea level. */
  deckApexASL: number;
  /** Exact names of the roadway/walkway roads that ride this deck. */
  deckRoads: string[];
  /** WGS84 `[lon, lat]` tower centres (south, then north). */
  towers: [[number, number], [number, number]];
  /** Metres of tower above the deck (GGB: 160). */
  towerTopAboveDeck: number;
  /** Metres from each tower to its anchorage along the axis. */
  sideSpan: number;
  /** Hex colour for every part (GGB: `0xc0362c` international orange). */
  color: number;
}

/** Per-city suspension-bridge table (`sf` + `nyc`). */
export const SUSPENSION_BRIDGES: Readonly<Record<string, readonly SuspensionBridgeSpec[]>> = {
  sf: [
    {
      name: 'Golden Gate Bridge',
      sidewalks: ['Golden Gate Bridge East Sidewalk', 'Golden Gate Bridge West Sidewalk'],
      deckApexASL: 67,
      deckRoads: ['Golden Gate Bridge'],
      towers: [
        [-122.4779, 37.814],
        [-122.47923, 37.8255],
      ],
      towerTopAboveDeck: 160,
      sideSpan: 343,
      color: 0xc0362c,
    },
  ],
  nyc: [
    {
      // OSM pylon ways 317352708 (Brooklyn / south) and 1255363983
      // (Manhattan / north), `bridge:support=pylon` centroids.
      name: 'Brooklyn Bridge',
      sidewalks: ['Brooklyn Bridge Promenade'],
      deckWidth: 26,
      deckApexASL: 41,
      deckRoads: ['Brooklyn Bridge', 'Brooklyn Bridge Bicycle Path'],
      towers: [
        [-73.994355, 40.704103],
        [-73.998335, 40.707268],
      ],
      towerTopAboveDeck: 43,
      sideSpan: 284,
      color: 0x8f857a,
    },
    {
      // OSM pylon ways 317352033 (Brooklyn / south) and 1255353996
      // (Manhattan / north); matching pier ways 1016640944 / 1255353997.
      name: 'Manhattan Bridge',
      sidewalks: ['Manhattan Bridge Pedestrian Path', 'Manhattan Bridge Bike Path'],
      deckWidth: 37,
      deckApexASL: 41,
      deckRoads: ['Manhattan Bridge', 'Manhattan Bridge (lower level)'],
      towers: [
        [-73.989436, 40.705115],
        [-73.991489, 40.708812],
      ],
      towerTopAboveDeck: 61,
      sideSpan: 221,
      color: 0x6f7f8f,
    },
    {
      // OSM pylon ways 1016434035 (Brooklyn / south) and 1016434034
      // (Manhattan / north). Both OSM walkways exist; they sit ~13 m
      // apart on a 36 m deck, so `deckWidth` supplies `sep`.
      name: 'Williamsburg Bridge',
      sidewalks: ['Williamsburg Bridge Footpath', 'Williamsburg Bridge Bike Path'],
      deckWidth: 36,
      deckApexASL: 41,
      deckRoads: ['Williamsburg Bridge'],
      towers: [
        [-73.969458, 40.712758],
        [-73.97482, 40.714395],
      ],
      towerTopAboveDeck: 54,
      sideSpan: 180,
      color: 0x7a6f66,
    },
  ],
};

interface Seg {
  a: Vec2;
  b: Vec2;
}

/** Shared deck-frame basis used by every prism/box/beam helper. */
interface AxisFrame {
  origin: Vec2;
  along: Vec2;
  across: Vec2;
}

interface Frame extends AxisFrame {
  span: number;
  sep: number;
  halfW: number;
  lat: number;
  east: Seg[];
  west: Seg[];
  eastLine: Vec2[];
}

/** Linear rgb of `hex` via `THREE.Color` (working colour space). */
function linearRgb(hex: number): Vec3 {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Unit geometric normal of triangle a→b→c. */
function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return [0, 1, 0];
  return [nx / len, ny / len, nz / len];
}

/** Quad a→b→c→d with winding flipped so the normal points along `toward`. */
function faceToward(
  mesh: MeshBuilder,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  toward: Vec3,
  color: Vec3,
): void {
  const n = triNormal(a, b, c);
  if (n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] < 0) {
    mesh.quad(a, d, c, b, [-n[0], -n[1], -n[2]], UV, UV, UV, UV, color);
  } else {
    mesh.quad(a, b, c, d, n, UV, UV, UV, UV, color);
  }
}

/** Upper median of `values` (0 when empty). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const a = values.slice().sort((x, y) => x - y);
  return a[a.length >> 1]!;
}

/** Nearest point on segment `a`→`b` to `p`. */
function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; d: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  let t = len2 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const q: Vec2 = [a[0] + t * abx, a[1] + t * aby];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

/** Nearest point over a set of segments, or `null` when the set is empty. */
function nearestOnPoly(p: Vec2, segs: readonly Seg[]): { q: Vec2; d: number } | null {
  let best: { q: Vec2; d: number } | null = null;
  for (const s of segs) {
    const r = nearestOnSegment(p, s.a, s.b);
    if (!best || r.d < best.d) best = r;
  }
  return best;
}

/** `bridge: true` segments of the named road. */
function namedBridgeSegs(city: CityData, name: string): Seg[] {
  const segs: Seg[] = [];
  for (const r of city.roads) {
    if (r.name !== name || !r.bridge) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      if (!a || !b) continue;
      segs.push({ a, b });
    }
  }
  return segs;
}

/** Along-axis coordinate of `p` relative to `origin`. */
function alongOf(p: Vec2, origin: Vec2, along: Vec2): number {
  return (p[0] - origin[0]) * along[0] + (p[1] - origin[1]) * along[1];
}

/**
 * Concatenate sidewalk pieces in along-order and drop duplicate joints so
 * the truss follows the full viaduct, not just tower-to-tower.
 */
function concatAlong(pieces: Vec2[][], origin: Vec2, along: Vec2): Vec2[] {
  const oriented = pieces.map((pts) => {
    if (pts.length < 2) return pts;
    const s0 = alongOf(pts[0]!, origin, along);
    const s1 = alongOf(pts[pts.length - 1]!, origin, along);
    return s0 <= s1 ? pts : pts.slice().reverse();
  });
  oriented.sort(
    (a, b) => alongOf(a[0] ?? origin, origin, along) - alongOf(b[0] ?? origin, origin, along),
  );
  const out: Vec2[] = [];
  for (const pts of oriented) {
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < JOINT_EPS) continue;
      out.push(p);
    }
  }
  return out;
}

/** Deck-axis point at along-distance `s` from the south tower. */
function axisXZ(frame: AxisFrame, s: number): Vec2 {
  return [frame.origin[0] + frame.along[0] * s, frame.origin[1] + frame.along[1] * s];
}

/** World xz of a cable / leg centre (`side` = ±1). */
function lateralXZ(frame: Frame, s: number, side: number): Vec2 {
  const a = axisXZ(frame, s);
  return [
    a[0] + side * frame.lat * frame.across[0],
    a[1] + side * frame.lat * frame.across[1],
  ];
}

/**
 * Deck surface height at along-distance `s`: `heightAt` of the nearest point
 * on the EAST sidewalk (the axis centre is over the sea bed).
 */
function deckY(frame: Frame, s: number, heightAt: HeightFn): number {
  const q = axisXZ(frame, s);
  const n = nearestOnPoly(q, frame.east);
  if (!n) return heightAt(q[0], q[1]);
  return heightAt(n.q[0], n.q[1]);
}

/** Build the deck frame, or `null` when sidewalks / towers are unusable. */
function makeFrame(spec: SuspensionBridgeSpec, city: CityData): Frame | null {
  const south = project(spec.towers[0][0], spec.towers[0][1], city.origin);
  const north = project(spec.towers[1][0], spec.towers[1][1], city.origin);
  const dx = north[0] - south[0];
  const dz = north[1] - south[1];
  const span = Math.hypot(dx, dz);
  if (span < 1) return null;
  const along: Vec2 = [dx / span, dz / span];
  const eastName = spec.sidewalks[0];
  const westName = spec.sidewalks[1];
  const east = namedBridgeSegs(city, eastName);
  if (east.length === 0) return null;
  const cw: Vec2 = [along[1], -along[0]];
  const ccw: Vec2 = [-along[1], along[0]];
  const eastPieces = city.roads
    .filter((r) => r.name === eastName && r.bridge)
    .map((r) => r.pts);
  const eastLine = concatAlong(eastPieces, south, along);

  // One-walkway (wave 10): the walkway IS the axis; sep = deckWidth;
  // cables/legs sit at ±(sep/2 + 1.4). +across is along rotated +90° (ccw).
  if (westName === undefined) {
    const sep = spec.deckWidth;
    if (sep === undefined || sep < 1) return null;
    return {
      origin: south,
      along,
      across: ccw,
      span,
      sep,
      halfW: sep / 2 + 2,
      lat: sep / 2 + 1.4,
      east,
      west: [],
      eastLine,
    };
  }

  const west = namedBridgeSegs(city, westName);
  if (west.length === 0) return null;
  // +across must point from the east sidewalk toward the west one.
  const westHint = nearestOnPoly(south, west);
  if (!westHint) return null;
  const hx = westHint.q[0] - south[0];
  const hz = westHint.q[1] - south[1];
  const across: Vec2 = hx * cw[0] + hz * cw[1] > 0 ? cw : ccw;
  const dists: number[] = [];
  for (const r of city.roads) {
    if (r.name !== eastName || !r.bridge) continue;
    for (const p of r.pts) {
      const n = nearestOnPoly(p, west);
      if (n) dists.push(n.d);
    }
  }
  const measured = median(dists);
  // `deckWidth` (when set) is the real deck width; OSM walkways are not
  // always the deck edges (Williamsburg's pair sit ~13 m apart on a 36 m
  // deck). GGB has no `deckWidth` and keeps the measured median.
  const sep = spec.deckWidth !== undefined && spec.deckWidth >= 1 ? spec.deckWidth : measured;
  if (sep < 1) return null;
  return {
    origin: south,
    along,
    across,
    span,
    sep,
    halfW: sep / 2 + 2,
    lat: sep / 2 + 1.4,
    east,
    west,
    eastLine,
  };
}

/**
 * Axis-aligned-in-deck-frame box: six faces, outward normals.
 * `s` along the towers, `a` across, `y` up.
 */
function box(
  mesh: MeshBuilder,
  frame: AxisFrame,
  s0: number,
  s1: number,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  color: Vec3,
): void {
  let ss0 = s0;
  let ss1 = s1;
  let aa0 = a0;
  let aa1 = a1;
  let yy0 = y0;
  let yy1 = y1;
  if (ss0 > ss1) {
    const t = ss0;
    ss0 = ss1;
    ss1 = t;
  }
  if (aa0 > aa1) {
    const t = aa0;
    aa0 = aa1;
    aa1 = t;
  }
  if (yy0 > yy1) {
    const t = yy0;
    yy0 = yy1;
    yy1 = t;
  }
  if (ss1 - ss0 < 1e-6 || aa1 - aa0 < 1e-6 || yy1 - yy0 < 1e-6) return;
  const p = (s: number, a: number, y: number): Vec3 => [
    frame.origin[0] + frame.along[0] * s + frame.across[0] * a,
    y,
    frame.origin[1] + frame.along[1] * s + frame.across[1] * a,
  ];
  const p000 = p(ss0, aa0, yy0);
  const p100 = p(ss1, aa0, yy0);
  const p110 = p(ss1, aa1, yy0);
  const p010 = p(ss0, aa1, yy0);
  const p001 = p(ss0, aa0, yy1);
  const p101 = p(ss1, aa0, yy1);
  const p111 = p(ss1, aa1, yy1);
  const p011 = p(ss0, aa1, yy1);
  const alongP: Vec3 = [frame.along[0], 0, frame.along[1]];
  const alongM: Vec3 = [-frame.along[0], 0, -frame.along[1]];
  const acrossP: Vec3 = [frame.across[0], 0, frame.across[1]];
  const acrossM: Vec3 = [-frame.across[0], 0, -frame.across[1]];
  const up: Vec3 = [0, 1, 0];
  const down: Vec3 = [0, -1, 0];
  faceToward(mesh, p100, p110, p111, p101, alongP, color);
  faceToward(mesh, p010, p000, p001, p011, alongM, color);
  faceToward(mesh, p110, p010, p011, p111, acrossP, color);
  faceToward(mesh, p000, p100, p101, p001, acrossM, color);
  faceToward(mesh, p001, p101, p111, p011, up, color);
  faceToward(mesh, p000, p010, p110, p100, down, color);
}

/**
 * Sloped deck-box prism from `s0` to `s1` in the deck frame: rectangular
 * cross-section `[a0, a1] × [yTop − depth, yTop]` at each end, but with
 * per-end top heights `y0` (at `s0`) and `y1` (at `s1`); six faces with
 * outward normals. Used by the deck-box loop (T-0084) so the top follows
 * the deck profile within each ≤ 50 m piece and the road ribbons stay
 * above the box.
 */
function prism(
  mesh: MeshBuilder,
  frame: AxisFrame,
  s0: number,
  s1: number,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  depth: number,
  color: Vec3,
): void {
  let ss0 = s0;
  let ss1 = s1;
  let yy0 = y0;
  let yy1 = y1;
  if (ss0 > ss1) {
    const ts = ss0;
    ss0 = ss1;
    ss1 = ts;
    const ty = yy0;
    yy0 = yy1;
    yy1 = ty;
  }
  let aa0 = a0;
  let aa1 = a1;
  if (aa0 > aa1) {
    const t = aa0;
    aa0 = aa1;
    aa1 = t;
  }
  if (ss1 - ss0 < 1e-6 || aa1 - aa0 < 1e-6 || depth < 1e-6) return;
  const p = (s: number, a: number, y: number): Vec3 => [
    frame.origin[0] + frame.along[0] * s + frame.across[0] * a,
    y,
    frame.origin[1] + frame.along[1] * s + frame.across[1] * a,
  ];
  const bot0 = yy0 - depth;
  const bot1 = yy1 - depth;
  const p000 = p(ss0, aa0, bot0);
  const p100 = p(ss1, aa0, bot1);
  const p110 = p(ss1, aa1, bot1);
  const p010 = p(ss0, aa1, bot0);
  const p001 = p(ss0, aa0, yy0);
  const p101 = p(ss1, aa0, yy1);
  const p111 = p(ss1, aa1, yy1);
  const p011 = p(ss0, aa1, yy0);
  const alongP: Vec3 = [frame.along[0], 0, frame.along[1]];
  const alongM: Vec3 = [-frame.along[0], 0, -frame.along[1]];
  const acrossP: Vec3 = [frame.across[0], 0, frame.across[1]];
  const acrossM: Vec3 = [-frame.across[0], 0, -frame.across[1]];
  const up: Vec3 = [0, 1, 0];
  const down: Vec3 = [0, -1, 0];
  faceToward(mesh, p100, p110, p111, p101, alongP, color);
  faceToward(mesh, p010, p000, p001, p011, alongM, color);
  faceToward(mesh, p110, p010, p011, p111, acrossP, color);
  faceToward(mesh, p000, p100, p101, p001, acrossM, color);
  faceToward(mesh, p001, p101, p111, p011, up, color);
  faceToward(mesh, p000, p010, p110, p100, down, color);
}

/**
 * Oriented square-section beam from `a` to `b`. `lateral` is one cross-section
 * axis (Gram-Schmidt'd against the beam); four sides + two caps.
 */
function beam(a: Vec3, b: Vec3, lateral: Vec3, w: number, h: number, color: Vec3, mesh: MeshBuilder): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  let lx = lateral[0];
  let ly = lateral[1];
  let lz = lateral[2];
  const drop = lx * ux + ly * uy + lz * uz;
  lx -= drop * ux;
  ly -= drop * uy;
  lz -= drop * uz;
  let llen = Math.hypot(lx, ly, lz);
  if (llen < 1e-6) {
    const fb: Vec3 = Math.abs(uy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    lx = fb[1] * uz - fb[2] * uy;
    ly = fb[2] * ux - fb[0] * uz;
    lz = fb[0] * uy - fb[1] * ux;
    llen = Math.hypot(lx, ly, lz);
    if (llen < 1e-6) return;
  }
  lx /= llen;
  ly /= llen;
  lz /= llen;
  let vx = uy * lz - uz * ly;
  let vy = uz * lx - ux * lz;
  let vz = ux * ly - uy * lx;
  const vlen = Math.hypot(vx, vy, vz);
  if (vlen < 1e-6) return;
  vx /= vlen;
  vy /= vlen;
  vz /= vlen;
  const hw = w / 2;
  const hh = h / 2;
  const at = (p: Vec3, sl: number, su: number): Vec3 => [
    p[0] + sl * hw * lx + su * hh * vx,
    p[1] + sl * hw * ly + su * hh * vy,
    p[2] + sl * hw * lz + su * hh * vz,
  ];
  const a00 = at(a, -1, -1);
  const a10 = at(a, 1, -1);
  const a11 = at(a, 1, 1);
  const a01 = at(a, -1, 1);
  const b00 = at(b, -1, -1);
  const b10 = at(b, 1, -1);
  const b11 = at(b, 1, 1);
  const b01 = at(b, -1, 1);
  const latP: Vec3 = [lx, ly, lz];
  const latM: Vec3 = [-lx, -ly, -lz];
  const upP: Vec3 = [vx, vy, vz];
  const upM: Vec3 = [-vx, -vy, -vz];
  const alongP: Vec3 = [ux, uy, uz];
  const alongM: Vec3 = [-ux, -uy, -uz];
  faceToward(mesh, a10, a11, b11, b10, latP, color);
  faceToward(mesh, a00, b00, b01, a01, latM, color);
  faceToward(mesh, a01, b01, b11, a11, upP, color);
  faceToward(mesh, a00, a10, b10, b00, upM, color);
  faceToward(mesh, a00, a01, a11, a10, alongM, color);
  faceToward(mesh, b00, b10, b11, b01, alongP, color);
}

/** Sample along-distances from `from` to `to` inclusive, stepping `STEP`. */
function samples(from: number, to: number): number[] {
  const dir = to >= from ? 1 : -1;
  const out: number[] = [];
  for (let s = from; dir > 0 ? s < to : s > to; s += dir * STEP) out.push(s);
  if (out.length === 0 || Math.abs(out[out.length - 1]! - to) > 1e-6) out.push(to);
  return out;
}

/** World point of a cable at along-distance `s` on `side` (±1). */
function cablePoint(
  frame: Frame,
  spec: SuspensionBridgeSpec,
  s: number,
  side: number,
  heightAt: HeightFn,
): Vec3 {
  const xz = lateralXZ(frame, s, side);
  const dS = deckY(frame, 0, heightAt);
  const dN = deckY(frame, frame.span, heightAt);
  const dMid = deckY(frame, frame.span / 2, heightAt);
  const topS = dS + spec.towerTopAboveDeck;
  const topN = dN + spec.towerTopAboveDeck;
  // 3 m clearance over the deck at mid-span. On a flat deck this is
  // `towerTopAboveDeck − 3`; a hump raises dMid so sag grows with it.
  const sag = (topS + topN) / 2 - dMid - MIDSPAN_CLEAR;
  let y: number;
  if (s >= 0 && s <= frame.span) {
    const u = frame.span > 0 ? s / frame.span : 0;
    const top = topS + (topN - topS) * u;
    y = top - sag * (1 - (2 * u - 1) * (2 * u - 1));
  } else if (s < 0) {
    const t = spec.sideSpan > 0 ? -s / spec.sideSpan : 1;
    const yA = deckY(frame, -spec.sideSpan, heightAt) + 1;
    y = topS + (yA - topS) * t;
  } else {
    const t = spec.sideSpan > 0 ? (s - frame.span) / spec.sideSpan : 1;
    const yA = deckY(frame, frame.span + spec.sideSpan, heightAt) + 1;
    y = topN + (yA - topN) * t;
  }
  return [xz[0], y, xz[1]];
}

/** Emit one tower: two legs with a portal arch and four portal struts. */
function emitTower(
  mesh: MeshBuilder,
  frame: Frame,
  spec: SuspensionBridgeSpec,
  sTower: number,
  heightAt: HeightFn,
  color: Vec3,
): void {
  const dY = deckY(frame, sTower, heightAt);
  const topY = dY + spec.towerTopAboveDeck;
  const halfAlong = LEG_ALONG / 2;
  const halfLeg = LEG_ACROSS / 2;
  for (const side of [-1, 1]) {
    const aC = side * frame.lat;
    const xz = lateralXZ(frame, sTower, side);
    const yBot = heightAt(xz[0], xz[1]) - 2;
    const inner = aC - side * halfLeg;
    const outer = aC + side * halfLeg;
    if (yBot < dY - PORTAL_BELOW - 1e-6) {
      box(
        mesh,
        frame,
        sTower - halfAlong,
        sTower + halfAlong,
        inner,
        outer,
        yBot,
        dY - PORTAL_BELOW,
        color,
      );
    }
    box(mesh, frame, sTower - halfAlong, sTower + halfAlong, inner, outer, dY + PORTAL_ABOVE, topY, color);
    const innerPost0 = inner;
    const innerPost1 = inner + side * POST_THICK;
    const outerPost0 = outer - side * POST_THICK;
    const outerPost1 = outer;
    box(
      mesh,
      frame,
      sTower - halfAlong,
      sTower + halfAlong,
      innerPost0,
      innerPost1,
      dY - PORTAL_BELOW,
      dY + PORTAL_ABOVE,
      color,
    );
    box(
      mesh,
      frame,
      sTower - halfAlong,
      sTower + halfAlong,
      outerPost0,
      outerPost1,
      dY - PORTAL_BELOW,
      dY + PORTAL_ABOVE,
      color,
    );
  }
  const innerE = -frame.lat + halfLeg;
  const innerW = frame.lat - halfLeg;
  const strutHalf = STRUT_ALONG / 2;
  for (const level of STRUT_LEVELS) {
    // NYC towers (43–61 m above deck) are shorter than GGB's 160 m; skip
    // strut levels that would sit above the tower top.
    if (dY + level >= topY - 1e-6) continue;
    box(
      mesh,
      frame,
      sTower - strutHalf,
      sTower + strutHalf,
      innerE,
      innerW,
      dY + level,
      Math.min(dY + level + STRUT_H, topY),
      color,
    );
  }
}

/** Emit cables, hangers, truss, towers and anchorages for one spec. */
function appendSuspensionBridge(
  mesh: MeshBuilder,
  spec: SuspensionBridgeSpec,
  city: CityData,
  heightAt: HeightFn,
): void {
  const frame = makeFrame(spec, city);
  if (!frame) return;
  const color = linearRgb(spec.color);
  const lateral: Vec3 = [frame.across[0], 0, frame.across[1]];

  // Truss deck: sloped prisms whose top tracks the deck profile within each
  // east-sidewalk segment (T-0084). Long OSM segments are subdivided into
  // pieces ≤ DECK_BOX_MAX_PIECE so the top stays within a few cm of the
  // ribbon over the whole span.
  for (let i = 0; i < frame.eastLine.length - 1; i++) {
    const a = frame.eastLine[i]!;
    const b = frame.eastLine[i + 1]!;
    const s0 = alongOf(a, frame.origin, frame.along);
    const s1 = alongOf(b, frame.origin, frame.along);
    const dsSeg = s1 - s0;
    if (Math.abs(dsSeg) < 1e-3) continue;
    const nPieces = Math.max(1, Math.ceil(Math.abs(dsSeg) / DECK_BOX_MAX_PIECE));
    for (let k = 0; k < nPieces; k++) {
      const ps0 = s0 + (dsSeg * k) / nPieces;
      const ps1 = s0 + (dsSeg * (k + 1)) / nPieces;
      const y0 = deckY(frame, ps0, heightAt) - TRUSS_TOP_BELOW_DECK;
      const y1 = deckY(frame, ps1, heightAt) - TRUSS_TOP_BELOW_DECK;
      prism(mesh, frame, ps0, ps1, -frame.halfW, frame.halfW, y0, y1, TRUSS_DEPTH, color);
    }
  }

  emitTower(mesh, frame, spec, 0, heightAt, color);
  emitTower(mesh, frame, spec, frame.span, heightAt, color);

  const chains: number[][] = [
    samples(-spec.sideSpan, 0),
    samples(0, frame.span),
    samples(frame.span, frame.span + spec.sideSpan),
  ];
  for (const side of [-1, 1]) {
    for (const chain of chains) {
      for (let i = 0; i < chain.length - 1; i++) {
        const p0 = cablePoint(frame, spec, chain[i]!, side, heightAt);
        const p1 = cablePoint(frame, spec, chain[i + 1]!, side, heightAt);
        beam(p0, p1, lateral, CABLE_W, CABLE_W, color, mesh);
      }
      for (const s of chain) {
        if (Math.abs(s) < 1e-6 || Math.abs(s - frame.span) < 1e-6) continue;
        const p = cablePoint(frame, spec, s, side, heightAt);
        const yDeck = deckY(frame, s, heightAt) - TRUSS_TOP_BELOW_DECK;
        if (p[1] - yDeck < HANGER_MIN) continue;
        const xz = lateralXZ(frame, s, side);
        beam([xz[0], p[1], xz[1]], [xz[0], yDeck, xz[1]], lateral, HANGER_W, HANGER_W, color, mesh);
      }
    }
  }

  const halfAnchAcross = frame.halfW + 3;
  for (const sAnch of [-spec.sideSpan, frame.span + spec.sideSpan]) {
    const yTop = deckY(frame, sAnch, heightAt) + ANCH_TOP_ABOVE_DECK;
    box(
      mesh,
      frame,
      sAnch - ANCH_ALONG / 2,
      sAnch + ANCH_ALONG / 2,
      -halfAnchAcross,
      halfAnchAcross,
      yTop - ANCH_H,
      yTop,
      color,
    );
  }
}

/** Build one suspension bridge's geometry as a triangle soup. */
export function buildSuspensionBridge(
  spec: SuspensionBridgeSpec,
  city: CityData,
  heightAt: HeightFn = FLAT_HEIGHT,
): MeshData {
  const mesh = new MeshBuilder();
  appendSuspensionBridge(mesh, spec, city, heightAt);
  return mesh.build();
}

/** Tag anchors for the spec's south and north tower tops (`y = topY + 4`). */
export function bridgeAnchors(
  spec: SuspensionBridgeSpec,
  city: CityData,
  heightAt: HeightFn = FLAT_HEIGHT,
): TagAnchor[] {
  const south = project(spec.towers[0][0], spec.towers[0][1], city.origin);
  const north = project(spec.towers[1][0], spec.towers[1][1], city.origin);
  const frame = makeFrame(spec, city);
  const topSouth = frame
    ? deckY(frame, 0, heightAt) + spec.towerTopAboveDeck
    : heightAt(south[0], south[1]) + spec.towerTopAboveDeck;
  const topNorth = frame
    ? deckY(frame, frame.span, heightAt) + spec.towerTopAboveDeck
    : heightAt(north[0], north[1]) + spec.towerTopAboveDeck;
  const southName = `${spec.name} South Tower`;
  const northName = `${spec.name} North Tower`;
  return [
    { name: southName, label: southName, x: south[0], y: topSouth + TAG_LIFT, z: south[1] },
    { name: northName, label: northName, x: north[0], y: topNorth + TAG_LIFT, z: north[1] },
  ];
}

/** Merge every spec for `cityId` into one Lambert mesh (empty when none). */
export function makeBridgesObject(
  cityId: string,
  city: CityData,
  heightAt: HeightFn = FLAT_HEIGHT,
): THREE.Object3D {
  const mesh = new MeshBuilder();
  for (const spec of SUSPENSION_BRIDGES[cityId] ?? []) {
    appendSuspensionBridge(mesh, spec, city, heightAt);
  }
  for (const spec of ARCH_BRIDGES[cityId] ?? []) {
    appendArchBridge(mesh, spec, city, heightAt);
  }
  const geom = toGeometry(mesh.build());
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geom, mat);
}

/**
 * Deck humps for `cityId`: one per spec (suspension + arch), `names =
 * sidewalks ∪ deckRoads`, `apexY = deckApexASL − datum` (flat cities:
 * `apexY = deckApexASL`).
 */
export function deckHumps(cityId: string, city: CityData): DeckHump[] {
  const datum = city.terrain?.datum ?? 0;
  const out: DeckHump[] = [];
  const collect = (
    sidewalks: readonly string[],
    deckRoads: readonly string[],
    apexASL: number,
  ): void => {
    const names: string[] = [];
    for (const n of sidewalks) if (!names.includes(n)) names.push(n);
    for (const n of deckRoads) if (!names.includes(n)) names.push(n);
    out.push({ names, apexY: apexASL - datum });
  };
  for (const spec of SUSPENSION_BRIDGES[cityId] ?? []) {
    collect(spec.sidewalks, spec.deckRoads, spec.deckApexASL);
  }
  for (const spec of ARCH_BRIDGES[cityId] ?? []) {
    collect(spec.sidewalks, spec.deckRoads, spec.deckApexASL);
  }
  return out;
}

// -- Arch bridges (architecture.md §4.16b) ---------------------------------

/** Chord sample spacing (m). */
const ARCH_STEP = 15;
/** Truss vertical spacing along the arch (m). */
const ARCH_TRUSS_STEP = 24;
/** Cross-bracing spacing along the arch (m). */
const ARCH_BRACE_STEP = 48;
/** Chord box-beam square-section side (m). */
const CHORD_W = 2.5;
/** Truss vertical square-section side (m). */
const TRUSS_W = 1.2;
/** Hanger / strut square-section side (m). */
const HANGER_ARCH_W = 0.8;
/** Cross-brace square-section side (m). */
const BRACE_ARCH_W = 0.8;
/** Minimum |bottom-chord − deck| for a hanger or a strut (m). */
const ARCH_CLEAR_MIN = 2;
/** Deck box depth below the deck (m). */
const ARCH_DECK_DEPTH = 6;
/** Max deck-box piece length before sloped subdivision (m; same T-0084 rule). */
const ARCH_DECK_MAX_PIECE = 25;
/** Pylon-to-arch across-clearance (m). */
const PYLON_AXIS_CLEARANCE = 2;
/** Tag lift above the arch crown (m). */
const ARCH_TAG_LIFT = 6;

/** Spec for a synthesised arch bridge (architecture.md §4.16b). */
export interface ArchBridgeSpec {
  /** Display name, e.g. `'Sydney Harbour Bridge'`. */
  name: string;
  /**
   * Exact road names of the deck-edge walkway polylines (`bridge: true`).
   * One name = the walkway IS the deck axis and `deckWidth` is required.
   */
  sidewalks: [string, string] | [string];
  /** Full deck width in metres; required with one walkway. */
  deckWidth?: number;
  /** Deck height at mid-span, metres above sea level. */
  deckApexASL: number;
  /** Other roads riding this deck (humps: sidewalks ∪ deckRoads). */
  deckRoads: string[];
  /** WGS84 `[lon, lat]` arch springing centres (south, then north). */
  ends: [[number, number], [number, number]];
  /** Top-chord crown (m ASL). */
  archTopASL: number;
  /** Bottom-chord crown (m ASL). */
  archBottomASL: number;
  /** Both chords converge to this y (m ASL) at each end. */
  springASL: number;
  /** Two truss ribs at `±ribSep/2` across the axis (m). */
  ribSep: number;
  /** Pylon top y (m ASL). */
  pylonTopASL: number;
  /** Pylon footprint `[across, along]` in metres. */
  pylonSize: [number, number];
  /** Pylon centre offset along the axis, beyond each springing (m). */
  pylonOffset: number;
  /** Hex colour for arch, hangers, truss, deck box. */
  color: number;
  /** Hex colour for the four pylons (granite). */
  pylonColor: number;
}

/** Per-city arch-bridge table (`sydney` only). */
export const ARCH_BRIDGES: Readonly<Record<string, readonly ArchBridgeSpec[]>> = {
  sydney: [
    {
      name: 'Sydney Harbour Bridge',
      // Motorway = deck axis (§4.16b one-walkway mode); deck width 49 m from
      // real-world specs (four traffic lanes + two rail tracks + walkways).
      sidewalks: ['Bradfield Highway'],
      deckWidth: 49,
      deckApexASL: 49,
      deckRoads: ['Harbour Bridge Cycleway', 'Cahill Walk'],
      // Both ends snapped to the chained `Bradfield Highway` bridge polyline
      // (the deck axis is the truth; wave-10 lesson). North: nearest polyline
      // point to the midpoint of OSM `bridge:support` ways 1238822733/34
      // (their footprint centroids (53.5, −1479.0) and (65.5, −1480.6) sit
      // ~90 m WEST of the deck centreline — anomalous OSM data, but their
      // along-station snaps cleanly onto the polyline). South: polyline point
      // at straight-line 503 m from the reconciled north (main-arch span
      // length; no south `bridge:support` footprint exists per T-0110).
      // Deltas from the wave-14 initial values (see docs §4.16b as-built):
      // north +90 m, south +37 m.
      ends: [
        [151.21073, -33.85212],
        [151.21261, -33.84785],
      ],
      archTopASL: 134,
      archBottomASL: 116,
      springASL: 12,
      ribSep: 30,
      pylonTopASL: 89,
      pylonSize: [16, 22],
      pylonOffset: 30,
      color: 0x878c91,
      pylonColor: 0xb5a98f,
    },
  ],
};

/** Deck-axis frame for an arch bridge. */
interface ArchFrame extends AxisFrame {
  /** Straight-line span between the two springings (m). */
  span: number;
  /** Chained walkway polyline, used for deck-height lookup along the axis. */
  deckLine: Vec2[];
  /** Full deck width (m). */
  deckWidth: number;
}

/** Build the arch frame, or `null` when the axis walkway is missing. */
function makeArchFrame(spec: ArchBridgeSpec, city: CityData): ArchFrame | null {
  const south = project(spec.ends[0][0], spec.ends[0][1], city.origin);
  const north = project(spec.ends[1][0], spec.ends[1][1], city.origin);
  const dx = north[0] - south[0];
  const dz = north[1] - south[1];
  const span = Math.hypot(dx, dz);
  if (span < 1) return null;
  const along: Vec2 = [dx / span, dz / span];
  // +across = along rotated +90° ccw (no orientation cue with one walkway).
  const across: Vec2 = [-along[1], along[0]];
  const deckWidth = spec.deckWidth;
  if (deckWidth === undefined || deckWidth < 1) return null;
  const axisName = spec.sidewalks[0];
  const pieces = city.roads.filter((r) => r.name === axisName && r.bridge).map((r) => r.pts);
  const deckLine = concatAlong(pieces, south, along);
  if (deckLine.length < 2) return null;
  return { origin: south, along, across, span, deckLine, deckWidth };
}

/**
 * Deck y at along-distance `s`: `heightAt` of the nearest point on the
 * chained axis walkway to the axis point at `s`. The walkway ride includes
 * the deck hump (§4.9), so hanger/strut/box bottoms track the drape.
 */
function archDeckY(frame: ArchFrame, s: number, heightAt: HeightFn): number {
  const q = axisXZ(frame, s);
  let bestD = Infinity;
  let bestQ: Vec2 = q;
  for (let i = 0; i < frame.deckLine.length - 1; i++) {
    const r = nearestOnSegment(q, frame.deckLine[i]!, frame.deckLine[i + 1]!);
    if (r.d < bestD) {
      bestD = r.d;
      bestQ = r.q;
    }
  }
  return heightAt(bestQ[0], bestQ[1]);
}

/** Emit chords + truss + hangers + struts + bracing + deck box + pylons. */
function appendArchBridge(
  mesh: MeshBuilder,
  spec: ArchBridgeSpec,
  city: CityData,
  heightAt: HeightFn,
): void {
  const frame = makeArchFrame(spec, city);
  if (!frame) return;
  const datum = city.terrain?.datum ?? 0;
  const color = linearRgb(spec.color);
  const pylonColor = linearRgb(spec.pylonColor);
  const yTopCrown = spec.archTopASL - datum;
  const yBotCrown = spec.archBottomASL - datum;
  const yS = spec.springASL - datum;
  const yP = spec.pylonTopASL - datum;

  const chordY = (crown: number, t: number): number =>
    yS + (crown - yS) * 4 * t * (1 - t);

  const lateral: Vec3 = [frame.across[0], 0, frame.across[1]];
  const halfRib = spec.ribSep / 2;

  // Chords: per rib (2), per chord (top/bot), sampled every ≤ ARCH_STEP m.
  const nChord = Math.max(2, Math.ceil(frame.span / ARCH_STEP));
  for (const rib of [-1, 1]) {
    const aC = rib * halfRib;
    for (const crown of [yTopCrown, yBotCrown]) {
      let prev: Vec3 | null = null;
      for (let i = 0; i <= nChord; i++) {
        const s = (frame.span * i) / nChord;
        const t = i / nChord;
        const y = chordY(crown, t);
        const xz = axisXZ(frame, s);
        const pt: Vec3 = [
          xz[0] + aC * frame.across[0],
          y,
          xz[1] + aC * frame.across[1],
        ];
        if (prev) beam(prev, pt, lateral, CHORD_W, CHORD_W, color, mesh);
        prev = pt;
      }
    }
  }

  // Truss verticals per rib, every ~ARCH_TRUSS_STEP m; skip endpoints where
  // the two chords have already met at yS.
  const nTruss = Math.max(2, Math.round(frame.span / ARCH_TRUSS_STEP));
  for (const rib of [-1, 1]) {
    const aC = rib * halfRib;
    for (let i = 1; i < nTruss; i++) {
      const s = (frame.span * i) / nTruss;
      const t = i / nTruss;
      const yT = chordY(yTopCrown, t);
      const yB = chordY(yBotCrown, t);
      if (yT - yB < 0.5) continue;
      box(mesh, frame, s - TRUSS_W / 2, s + TRUSS_W / 2, aC - TRUSS_W / 2, aC + TRUSS_W / 2, yB, yT, color);
    }
  }

  // Hangers where the bottom chord is ≥ 2 m ABOVE the deck; struts where
  // it is ≥ 2 m BELOW. Both are 0.8 m-square posts at each deck edge.
  // `frame.deckWidth` mirrors `spec.deckWidth` after the make-frame check.
  const halfDeck = frame.deckWidth / 2;
  const nHang = Math.max(2, Math.round(frame.span / ARCH_STEP));
  for (let i = 1; i < nHang; i++) {
    const s = (frame.span * i) / nHang;
    const t = i / nHang;
    const yB = chordY(yBotCrown, t);
    const yD = archDeckY(frame, s, heightAt);
    const above = yB - yD;
    if (above >= ARCH_CLEAR_MIN) {
      for (const edge of [-halfDeck, halfDeck]) {
        box(
          mesh,
          frame,
          s - HANGER_ARCH_W / 2,
          s + HANGER_ARCH_W / 2,
          edge - HANGER_ARCH_W / 2,
          edge + HANGER_ARCH_W / 2,
          yD,
          yB,
          color,
        );
      }
    } else if (-above >= ARCH_CLEAR_MIN) {
      for (const edge of [-halfDeck, halfDeck]) {
        box(
          mesh,
          frame,
          s - HANGER_ARCH_W / 2,
          s + HANGER_ARCH_W / 2,
          edge - HANGER_ARCH_W / 2,
          edge + HANGER_ARCH_W / 2,
          yB,
          yD,
          color,
        );
      }
    }
  }

  // Cross-bracing between ribs: transverse posts between top chords and
  // between bottom chords, every ~ARCH_BRACE_STEP m.
  const nBrace = Math.max(2, Math.round(frame.span / ARCH_BRACE_STEP));
  const aInner = -halfRib + TRUSS_W / 2;
  const aOuter = halfRib - TRUSS_W / 2;
  for (let i = 1; i < nBrace; i++) {
    const s = (frame.span * i) / nBrace;
    const t = i / nBrace;
    const yT = chordY(yTopCrown, t);
    const yB = chordY(yBotCrown, t);
    box(
      mesh,
      frame,
      s - BRACE_ARCH_W / 2,
      s + BRACE_ARCH_W / 2,
      aInner,
      aOuter,
      yT - BRACE_ARCH_W,
      yT,
      color,
    );
    box(
      mesh,
      frame,
      s - BRACE_ARCH_W / 2,
      s + BRACE_ARCH_W / 2,
      aInner,
      aOuter,
      yB,
      yB + BRACE_ARCH_W,
      color,
    );
  }

  // Deck box: full deck width, 6 m deep, top at deck level, in ≤ 25 m sloped
  // pieces (T-0084 rule shared with the suspension deck).
  const nDeck = Math.max(1, Math.ceil(frame.span / ARCH_DECK_MAX_PIECE));
  for (let i = 0; i < nDeck; i++) {
    const s0 = (frame.span * i) / nDeck;
    const s1 = (frame.span * (i + 1)) / nDeck;
    const y0 = archDeckY(frame, s0, heightAt);
    const y1 = archDeckY(frame, s1, heightAt);
    prism(mesh, frame, s0, s1, -halfDeck, halfDeck, y0, y1, ARCH_DECK_DEPTH, color);
  }

  // Four granite pylons flanking each end.
  const [pW, pL] = spec.pylonSize;
  const pylonAcross = halfRib + pW / 2 + PYLON_AXIS_CLEARANCE;
  for (const endS of [-spec.pylonOffset, frame.span + spec.pylonOffset]) {
    for (const side of [-1, 1]) {
      const aCentre = side * pylonAcross;
      const xz: Vec2 = [
        frame.origin[0] + frame.along[0] * endS + frame.across[0] * aCentre,
        frame.origin[1] + frame.along[1] * endS + frame.across[1] * aCentre,
      ];
      const yBot = heightAt(xz[0], xz[1]);
      box(
        mesh,
        frame,
        endS - pL / 2,
        endS + pL / 2,
        aCentre - pW / 2,
        aCentre + pW / 2,
        yBot,
        yP,
        pylonColor,
      );
    }
  }
}

/** Build one arch bridge's geometry as a triangle soup. */
export function buildArchBridge(
  spec: ArchBridgeSpec,
  city: CityData,
  heightAt: HeightFn = FLAT_HEIGHT,
): MeshData {
  const mesh = new MeshBuilder();
  appendArchBridge(mesh, spec, city, heightAt);
  return mesh.build();
}

/** ONE tag at mid-span, `y = (archTopASL − datum) + 6`. */
export function archAnchors(
  spec: ArchBridgeSpec,
  city: CityData,
  _heightAt: HeightFn = FLAT_HEIGHT,
): TagAnchor[] {
  const frame = makeArchFrame(spec, city);
  if (!frame) return [];
  const datum = city.terrain?.datum ?? 0;
  const mid = axisXZ(frame, frame.span / 2);
  return [
    {
      name: spec.name,
      label: spec.name,
      x: mid[0],
      y: spec.archTopASL - datum + ARCH_TAG_LIFT,
      z: mid[1],
    },
  ];
}
