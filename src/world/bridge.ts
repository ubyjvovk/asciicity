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
  /** Exact road names: `[east, west]` deck-edge polylines (`bridge: true`). */
  sidewalks: [string, string];
  /** WGS84 `[lon, lat]` tower centres (south, then north). */
  towers: [[number, number], [number, number]];
  /** Metres of tower above the deck (GGB: 160). */
  towerTopAboveDeck: number;
  /** Metres from each tower to its anchorage along the axis. */
  sideSpan: number;
  /** Hex colour for every part (GGB: `0xc0362c` international orange). */
  color: number;
}

/** Per-city suspension-bridge table; only `sf` has an entry. */
export const SUSPENSION_BRIDGES: Readonly<Record<string, readonly SuspensionBridgeSpec[]>> = {
  sf: [
    {
      name: 'Golden Gate Bridge',
      sidewalks: ['Golden Gate Bridge East Sidewalk', 'Golden Gate Bridge West Sidewalk'],
      towers: [
        [-122.4779, 37.814],
        [-122.47923, 37.8255],
      ],
      towerTopAboveDeck: 160,
      sideSpan: 343,
      color: 0xc0362c,
    },
  ],
};

interface Seg {
  a: Vec2;
  b: Vec2;
}

interface Frame {
  origin: Vec2;
  along: Vec2;
  across: Vec2;
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
function axisXZ(frame: Frame, s: number): Vec2 {
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
  const east = namedBridgeSegs(city, spec.sidewalks[0]);
  const west = namedBridgeSegs(city, spec.sidewalks[1]);
  if (east.length === 0 || west.length === 0) return null;
  // +across must point from the east sidewalk toward the west one.
  const westHint = nearestOnPoly(south, west);
  if (!westHint) return null;
  const hx = westHint.q[0] - south[0];
  const hz = westHint.q[1] - south[1];
  const cw: Vec2 = [along[1], -along[0]];
  const ccw: Vec2 = [-along[1], along[0]];
  const across: Vec2 = hx * cw[0] + hz * cw[1] > 0 ? cw : ccw;
  const eastPieces = city.roads
    .filter((r) => r.name === spec.sidewalks[0] && r.bridge)
    .map((r) => r.pts);
  const eastLine = concatAlong(eastPieces, south, along);
  const dists: number[] = [];
  for (const r of city.roads) {
    if (r.name !== spec.sidewalks[0] || !r.bridge) continue;
    for (const p of r.pts) {
      const n = nearestOnPoly(p, west);
      if (n) dists.push(n.d);
    }
  }
  const sep = median(dists);
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
  frame: Frame,
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
  const topS = deckY(frame, 0, heightAt) + spec.towerTopAboveDeck;
  const topN = deckY(frame, frame.span, heightAt) + spec.towerTopAboveDeck;
  const sag = spec.towerTopAboveDeck - MIDSPAN_CLEAR;
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
    box(
      mesh,
      frame,
      sTower - strutHalf,
      sTower + strutHalf,
      innerE,
      innerW,
      dY + level,
      dY + level + STRUT_H,
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

  // Truss deck: one box per east-sidewalk segment, full viaduct extent.
  for (let i = 0; i < frame.eastLine.length - 1; i++) {
    const a = frame.eastLine[i]!;
    const b = frame.eastLine[i + 1]!;
    const s0 = alongOf(a, frame.origin, frame.along);
    const s1 = alongOf(b, frame.origin, frame.along);
    if (Math.abs(s1 - s0) < 1e-3) continue;
    const sMid = (s0 + s1) / 2;
    const top = deckY(frame, sMid, heightAt) - TRUSS_TOP_BELOW_DECK;
    box(mesh, frame, s0, s1, -frame.halfW, frame.halfW, top - TRUSS_DEPTH, top, color);
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
  const geom = toGeometry(mesh.build());
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geom, mat);
}
