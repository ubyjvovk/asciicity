/**
 * Unit tests for the Golden Gate Bridge structure (`src/world/bridge.ts`,
 * architecture.md §4.16). Case names match the ticket fixtures verbatim.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLAT_HEIGHT, type CityData, type HeightFn, type Vec2 } from '../src/data/types';
import { project } from '../src/geo';
import {
  SUSPENSION_BRIDGES,
  bridgeAnchors,
  buildSuspensionBridge,
  deckHumps,
  makeBridgesObject,
  type SuspensionBridgeSpec,
} from '../src/world/bridge';
import type { MeshData } from '../src/world/mesh';
import { BridgeDecks, Terrain, chainBridgeRoads, makeGroundAt } from '../src/world/terrain';
import { loadSfGlobals } from './sfCity';

const SF: CityData = loadSfGlobals();
const NYC: CityData = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'nyc.json'), 'utf8'),
);

const SPEC = SUSPENSION_BRIDGES.sf[0]!;

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
  lat: number;
  east: Seg[];
  west: Seg[];
}

function namedSegs(city: CityData, name: string | undefined): Seg[] {
  const segs: Seg[] = [];
  if (name === undefined) return segs;
  for (const r of city.roads) {
    if (r.name !== name || !r.bridge) continue;
    for (let i = 0; i < r.pts.length - 1; i++) segs.push({ a: r.pts[i]!, b: r.pts[i + 1]! });
  }
  return segs;
}

function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; d: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  let t = len2 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q: Vec2 = [a[0] + t * abx, a[1] + t * aby];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

function nearestOnPoly(p: Vec2, segs: readonly Seg[]): { q: Vec2; d: number } | null {
  let best: { q: Vec2; d: number } | null = null;
  for (const s of segs) {
    const r = nearestOnSegment(p, s.a, s.b);
    if (!best || r.d < best.d) best = r;
  }
  return best;
}

function alongOf(p: Vec2, origin: Vec2, along: Vec2): number {
  return (p[0] - origin[0]) * along[0] + (p[1] - origin[1]) * along[1];
}

function acrossOf(p: Vec2, origin: Vec2, across: Vec2): number {
  return (p[0] - origin[0]) * across[0] + (p[1] - origin[1]) * across[1];
}

/** Mean of walkway stations at along `s` (wraps on both sides cancel). */
function meanStation(segs: readonly Seg[], frame: Frame, s: number): Vec2 | null {
  const hits: Vec2[] = [];
  for (const seg of segs) {
    const s0 = alongOf(seg.a, frame.origin, frame.along);
    const s1 = alongOf(seg.b, frame.origin, frame.along);
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    if (s < lo - 2 || s > hi + 2) continue;
    const t = Math.abs(s1 - s0) < 1e-9 ? 0 : (s - s0) / (s1 - s0);
    const tt = Math.max(0, Math.min(1, t));
    hits.push([
      seg.a[0] + tt * (seg.b[0] - seg.a[0]),
      seg.a[1] + tt * (seg.b[1] - seg.a[1]),
    ]);
  }
  if (hits.length === 0) {
    const n = nearestOnPoly(axisXZ(frame, s), segs);
    return n ? n.q : null;
  }
  let sx = 0;
  let sz = 0;
  for (const h of hits) {
    sx += h[0];
    sz += h[1];
  }
  return [sx / hits.length, sz / hits.length];
}

/** Deck frame matching architecture.md §4.16 (east→west = +across). */
function ggbFrame(city: CityData): Frame {
  const origin = project(SPEC.towers[0][0], SPEC.towers[0][1], city.origin);
  const north = project(SPEC.towers[1][0], SPEC.towers[1][1], city.origin);
  const dx = north[0] - origin[0];
  const dz = north[1] - origin[1];
  const span = Math.hypot(dx, dz);
  const along: Vec2 = [dx / span, dz / span];
  const east = namedSegs(city, SPEC.sidewalks[0]);
  const west = namedSegs(city, SPEC.sidewalks[1]);
  const westHint = nearestOnPoly(origin, west)!;
  const hx = westHint.q[0] - origin[0];
  const hz = westHint.q[1] - origin[1];
  const cw: Vec2 = [along[1], -along[0]];
  const ccw: Vec2 = [-along[1], along[0]];
  const across: Vec2 = hx * cw[0] + hz * cw[1] > 0 ? cw : ccw;
  const dists: number[] = [];
  for (const r of city.roads) {
    if (r.name !== SPEC.sidewalks[0] || !r.bridge) continue;
    for (const p of r.pts) {
      const n = nearestOnPoly(p, west);
      if (n) dists.push(n.d);
    }
  }
  dists.sort((a, b) => a - b);
  const sep = dists[dists.length >> 1]!;
  return { origin, along, across, span, sep, lat: sep / 2 + 1.4, east, west };
}

function axisXZ(frame: Frame, s: number): Vec2 {
  return [frame.origin[0] + frame.along[0] * s, frame.origin[1] + frame.along[1] * s];
}

function deckY(frame: Frame, s: number, heightAt: HeightFn): number {
  const q = axisXZ(frame, s);
  const n = nearestOnPoly(q, frame.east);
  return n ? heightAt(n.q[0], n.q[1]) : heightAt(q[0], q[1]);
}

/** `heightAt` is 35 on the east sidewalk corridor, 0 elsewhere. */
function deck35(city: CityData): HeightFn {
  const east = namedSegs(city, SPEC.sidewalks[0]);
  return (x, z) => {
    const n = nearestOnPoly([x, z], east);
    return n && n.d < 6 ? 35 : 0;
  };
}

function stationOnPoly(segs: readonly Seg[], frame: Frame, s: number): Vec2 {
  let best: Vec2 | null = null;
  let bestDs = Infinity;
  for (const seg of segs) {
    const s0 = alongOf(seg.a, frame.origin, frame.along);
    const s1 = alongOf(seg.b, frame.origin, frame.along);
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    if (s < lo - 2 || s > hi + 2) continue;
    const t = Math.abs(s1 - s0) < 1e-9 ? 0 : (s - s0) / (s1 - s0);
    const tt = Math.max(0, Math.min(1, t));
    const q: Vec2 = [seg.a[0] + tt * (seg.b[0] - seg.a[0]), seg.a[1] + tt * (seg.b[1] - seg.a[1])];
    const ds = Math.abs(alongOf(q, frame.origin, frame.along) - s);
    if (ds < bestDs) {
      bestDs = ds;
      best = q;
    }
  }
  if (best) return best;
  return nearestOnPoly(axisXZ(frame, s), segs)!.q;
}

function vertexCount(m: MeshData): number {
  return m.positions.length / 3;
}

const BOX_VERTS = 36;

interface BoxExt {
  minS: number;
  maxS: number;
  minA: number;
  maxA: number;
  minY: number;
  maxY: number;
  cx: number;
  cy: number;
  cz: number;
}

function eachBox(m: MeshData, frame: Frame): BoxExt[] {
  const out: BoxExt[] = [];
  const n = vertexCount(m);
  const p = m.positions;
  for (let i = 0; i + BOX_VERTS <= n; i += BOX_VERTS) {
    let minS = Infinity;
    let maxS = -Infinity;
    let minA = Infinity;
    let maxA = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let j = 0; j < BOX_VERTS; j++) {
      const x = p[(i + j) * 3]!;
      const y = p[(i + j) * 3 + 1]!;
      const z = p[(i + j) * 3 + 2]!;
      const s = (x - frame.origin[0]) * frame.along[0] + (z - frame.origin[1]) * frame.along[1];
      const a = (x - frame.origin[0]) * frame.across[0] + (z - frame.origin[1]) * frame.across[1];
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sx += x;
      sy += y;
      sz += z;
    }
    out.push({
      minS,
      maxS,
      minA,
      maxA,
      minY,
      maxY,
      cx: sx / BOX_VERTS,
      cy: sy / BOX_VERTS,
      cz: sz / BOX_VERTS,
    });
  }
  return out;
}

function stubCity(): CityData {
  return {
    v: 1,
    origin: { lat: 0, lon: 0 },
    bbox: [0, 0, 0, 0],
    buildings: [],
    roads: [],
    places: [],
  };
}

/** Mean y of vertices within `radius` of `(x,z)` and `expectedY ± band`. */
function meanYNear(
  m: MeshData,
  x: number,
  z: number,
  radius: number,
  expectedY: number,
  band: number,
): number | null {
  const p = m.positions;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < p.length; i += 3) {
    const dx = p[i]! - x;
    const dy = p[i + 1]! - expectedY;
    const dz = p[i + 2]! - z;
    if (dx * dx + dz * dz <= radius * radius && Math.abs(dy) <= band) {
      sum += p[i + 1]!;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

function distPointToRect(s: number, a: number, b: BoxExt): number {
  const cs = Math.max(b.minS, Math.min(b.maxS, s));
  const ca = Math.max(b.minA, Math.min(b.maxA, a));
  return Math.hypot(s - cs, a - ca);
}

describe('src/world/bridge.ts', () => {
  it('projected GGB tower centres lie within 2 m of the sidewalk mid-line', () => {
    const frame = ggbFrame(SF);
    for (const s of [0, frame.span]) {
      const tower = axisXZ(frame, s);
      const e = stationOnPoly(frame.east, frame, s);
      const w = stationOnPoly(frame.west, frame, s);
      const mid: Vec2 = [(e[0] + w[0]) / 2, (e[1] + w[1]) / 2];
      expect(Math.hypot(tower[0] - mid[0], tower[1] - mid[1])).toBeLessThan(2);
    }
  });

  it('west sidewalk lies on the +across side of the deck axis', () => {
    const frame = ggbFrame(SF);
    const lo = -SPEC.sideSpan;
    const hi = frame.span + SPEC.sideSpan;
    for (const s of [0, frame.span / 2, frame.span]) {
      const w = stationOnPoly(frame.west, frame, s);
      const e = stationOnPoly(frame.east, frame, s);
      expect(acrossOf(w, frame.origin, frame.across)).toBeGreaterThan(0);
      expect(acrossOf(e, frame.origin, frame.across)).toBeLessThan(0);
    }
    for (const r of SF.roads) {
      if (r.name !== SPEC.sidewalks[1] || !r.bridge) continue;
      for (const p of r.pts) {
        const s = alongOf(p, frame.origin, frame.along);
        if (s < lo || s > hi) continue;
        expect(acrossOf(p, frame.origin, frame.across)).toBeGreaterThan(0);
      }
    }
  });

  it('main cable sits deckY + 3 at mid-span and topY at the towers', () => {
    const frame = ggbFrame(SF);
    const heightFns: HeightFn[] = [FLAT_HEIGHT, deck35(SF)];
    for (const heightAt of heightFns) {
      const mesh = buildSuspensionBridge(SPEC, SF, heightAt);
      for (const side of [-1, 1] as const) {
        const stations: { s: number; y: number }[] = [
          { s: 0, y: deckY(frame, 0, heightAt) + SPEC.towerTopAboveDeck },
          { s: frame.span / 2, y: deckY(frame, frame.span / 2, heightAt) + 3 },
          { s: frame.span, y: deckY(frame, frame.span, heightAt) + SPEC.towerTopAboveDeck },
        ];
        for (const st of stations) {
          const xz: Vec2 = [
            frame.origin[0] + frame.along[0] * st.s + side * frame.lat * frame.across[0],
            frame.origin[1] + frame.along[1] * st.s + side * frame.lat * frame.across[1],
          ];
          const y = meanYNear(mesh, xz[0], xz[1], 1.5, st.y, 1.2);
          expect(y, `no cable verts at s=${st.s} side=${side}`).not.toBeNull();
          expect(Math.abs(y! - st.y)).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it('portal posts stay ≥ 1.5 m clear of the east sidewalk line', () => {
    const frame = ggbFrame(SF);
    const mesh = buildSuspensionBridge(SPEC, SF, FLAT_HEIGHT);
    const dY = deckY(frame, 0, FLAT_HEIGHT);
    const posts = eachBox(mesh, frame).filter((b) => {
      const ds = b.maxS - b.minS;
      const da = b.maxA - b.minA;
      const dy = b.maxY - b.minY;
      return Math.abs(ds - 12) < 0.6 && Math.abs(da - 2) < 0.6 && Math.abs(dy - 8) < 0.6;
    });
    expect(posts.length).toBe(8);
    // OSM sidewalks wrap around the real pylons (~20 m across); the portal is
    // designed so the through-line at ±sep/2 walks through the opening. Measure
    // posts against east-sidewalk vertices on that through-line, not the wrap.
    const through: Vec2[] = [];
    for (const r of SF.roads) {
      if (r.name !== SPEC.sidewalks[0] || !r.bridge) continue;
      for (const p of r.pts) {
        if (Math.abs(acrossOf(p, frame.origin, frame.across)) <= frame.sep / 2 + 4) {
          through.push(p);
        }
      }
    }
    expect(through.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(post.minY).toBeLessThanOrEqual(dY - 1 + 0.2);
      expect(post.maxY).toBeGreaterThanOrEqual(dY + 7 - 0.2);
      for (const v of through) {
        const s = alongOf(v, frame.origin, frame.along);
        const a = acrossOf(v, frame.origin, frame.across);
        expect(distPointToRect(s, a, post)).toBeGreaterThanOrEqual(1.5);
      }
    }
  });

  it('hanger count per cable ≈ span / 16', () => {
    const frame = ggbFrame(SF);
    const mesh = buildSuspensionBridge(SPEC, SF, FLAT_HEIGHT);
    const hangers = eachBox(mesh, frame).filter((b) => {
      const dx = b.maxS - b.minS;
      const da = b.maxA - b.minA;
      const dy = b.maxY - b.minY;
      return dx < 1.1 && da < 1.1 && dy >= 2;
    });
    const expected = frame.span / 16;
    for (const side of [-1, 1]) {
      const n = hangers.filter((h) => {
        const a = ((h.minA + h.maxA) / 2) * Math.sign(side);
        const s = (h.minS + h.maxS) / 2;
        return a > 0 && s > 1 && s < frame.span - 1;
      }).length;
      expect(Math.abs(n - expected)).toBeLessThanOrEqual(2);
    }
  });

  it('no NaN in bridge positions', () => {
    for (const heightAt of [FLAT_HEIGHT, deck35(SF)]) {
      const mesh = buildSuspensionBridge(SPEC, SF, heightAt);
      const n = vertexCount(mesh);
      expect(n, `SF bridge vertices=${n}`).toBeGreaterThan(0);
      expect(n, `SF bridge vertices=${n}`).toBeLessThan(25000);
      for (let i = 0; i < mesh.positions.length; i++) {
        expect(Number.isFinite(mesh.positions[i])).toBe(true);
      }
      for (let i = 0; i < mesh.normals.length; i++) {
        expect(Number.isFinite(mesh.normals[i])).toBe(true);
      }
    }
  });

  it('London and Kyiv produce an empty mesh and no anchors', () => {
    const city = stubCity();
    for (const id of ['london', 'kyiv'] as const) {
      expect(SUSPENSION_BRIDGES[id] ?? []).toEqual([]);
      const obj = makeBridgesObject(id, city, FLAT_HEIGHT);
      expect(obj).toBeInstanceOf(THREE.Mesh);
      const geom = (obj as THREE.Mesh).geometry;
      const attr = geom.getAttribute('position');
      expect(attr.count).toBe(0);
      const anchors = (SUSPENSION_BRIDGES[id] ?? []).flatMap((s) =>
        bridgeAnchors(s, city, FLAT_HEIGHT),
      );
      expect(anchors).toHaveLength(0);
    }
  });

  it('deck box top tracks the deck profile within 0.1 m every 25 m along the east sidewalk', () => {
    // Wire up terrain + bridge decks + groundAt exactly as src/main.ts does
    // so the ribbons see the same walking surface (chainBridgeRoads lives
    // inside BridgeDecks; the East Sidewalk is a chained polyline).
    if (!SF.terrain) throw new Error('sf.json has no terrain');
    const terrain = new Terrain(SF.terrain);
    const decks = new BridgeDecks(SF.roads, terrain.heightAt);
    const groundAt = makeGroundAt(terrain, decks);
    const mesh = buildSuspensionBridge(SPEC, SF, groundAt);
    const frame = ggbFrame(SF);

    // Chained east sidewalk polyline, joint-deduped just like BridgeDecks does;
    // take the LONGEST chained road with that name.
    const eastChains = chainBridgeRoads(SF.roads).filter(
      (r) => r.name === SPEC.sidewalks[0] && r.bridge === true,
    );
    expect(eastChains.length, 'east sidewalk chain missing').toBeGreaterThan(0);
    const polylineLength = (pts: Vec2[]): number => {
      let sum = 0;
      for (let i = 1; i < pts.length; i++)
        sum += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
      return sum;
    };
    const poly = eastChains
      .slice()
      .sort((a, b) => polylineLength(b.pts) - polylineLength(a.pts))[0]!.pts;
    expect(poly.length).toBeGreaterThan(1);

    // Cumulative arc-length along the chain.
    const cum: number[] = [0];
    for (let i = 1; i < poly.length; i++) {
      cum.push(
        cum[i - 1]! + Math.hypot(poly[i]![0] - poly[i - 1]![0], poly[i]![1] - poly[i - 1]![1]),
      );
    }
    const total = cum[cum.length - 1]!;
    expect(total, 'east sidewalk chain shorter than main span').toBeGreaterThan(500);

    // Extract deck-box prisms (the WIDE boxes = 2·halfW across, ~7.6 m deep).
    // Each prism carries y at minS and y at maxS separately because the top
    // is sloped. Rebuild those per-end tops from the raw vertices.
    const targetAcross = 2 * (frame.sep / 2 + 2);
    interface Prism {
      minS: number;
      maxS: number;
      minA: number;
      maxA: number;
      yAtMinS: number;
      yAtMaxS: number;
    }
    const prisms: Prism[] = [];
    const p3d = mesh.positions;
    const BOX = 36;
    for (let i = 0; i + BOX <= p3d.length / 3; i += BOX) {
      const svals: number[] = [];
      const avals: number[] = [];
      const yvals: number[] = [];
      for (let j = 0; j < BOX; j++) {
        const x = p3d[(i + j) * 3]!;
        const y = p3d[(i + j) * 3 + 1]!;
        const z = p3d[(i + j) * 3 + 2]!;
        svals.push(
          (x - frame.origin[0]) * frame.along[0] + (z - frame.origin[1]) * frame.along[1],
        );
        avals.push(
          (x - frame.origin[0]) * frame.across[0] + (z - frame.origin[1]) * frame.across[1],
        );
        yvals.push(y);
      }
      const minS = Math.min(...svals);
      const maxS = Math.max(...svals);
      const minA = Math.min(...avals);
      const maxA = Math.max(...avals);
      const dy = Math.max(...yvals) - Math.min(...yvals);
      if (Math.abs(maxA - minA - targetAcross) > 0.5 || Math.abs(dy - 7.6) > 0.6) continue;
      // Top vertices are the highest y at each S end.
      let yAtMinS = -Infinity;
      let yAtMaxS = -Infinity;
      for (let j = 0; j < BOX; j++) {
        if (Math.abs(svals[j]! - minS) < 1e-3 && yvals[j]! > yAtMinS) yAtMinS = yvals[j]!;
        if (Math.abs(svals[j]! - maxS) < 1e-3 && yvals[j]! > yAtMaxS) yAtMaxS = yvals[j]!;
      }
      prisms.push({ minS, maxS, minA, maxA, yAtMinS, yAtMaxS });
    }
    expect(prisms.length, 'expected many deck-box prisms').toBeGreaterThan(20);

    // Walk the chained sidewalk every 25 m. At each sample, find the deck-box
    // prism whose deck-frame footprint contains the sample point (in axis
    // frame) and interpolate the top y at that s. Skip samples where no
    // prism covers them (approach ramps whose sidewalks curve away from the
    // straight deck axis) — those are outside the box's footprint by design.
    let checked = 0;
    for (let s = 25; s < total - 25; s += 25) {
      let seg = 0;
      while (seg < poly.length - 2 && cum[seg + 1]! < s) seg++;
      const t = (s - cum[seg]!) / (cum[seg + 1]! - cum[seg]!);
      const px = poly[seg]![0] + t * (poly[seg + 1]![0] - poly[seg]![0]);
      const pz = poly[seg]![1] + t * (poly[seg + 1]![1] - poly[seg]![1]);
      const sAxis =
        (px - frame.origin[0]) * frame.along[0] + (pz - frame.origin[1]) * frame.along[1];
      const aAxis =
        (px - frame.origin[0]) * frame.across[0] + (pz - frame.origin[1]) * frame.across[1];
      const prism = prisms.find(
        (b) =>
          sAxis >= b.minS - 1e-3 &&
          sAxis <= b.maxS + 1e-3 &&
          aAxis >= b.minA - 0.5 &&
          aAxis <= b.maxA + 0.5,
      );
      if (!prism) continue;
      const walking = groundAt(px, pz);
      const alpha =
        prism.maxS > prism.minS ? (sAxis - prism.minS) / (prism.maxS - prism.minS) : 0;
      const topY = prism.yAtMinS + alpha * (prism.yAtMaxS - prism.yAtMinS);
      expect(
        Math.abs(topY - (walking - 0.4)),
        `s=${s.toFixed(1)}: top=${topY.toFixed(3)} walking=${walking.toFixed(3)}`,
      ).toBeLessThanOrEqual(0.1);
      checked++;
    }
    // Enough samples in the main-span region to catch the sMid regression.
    expect(checked, 'expected many prism-covered samples').toBeGreaterThan(30);
  });

  it('no deck-box piece is longer than 50 m', () => {
    const frame = ggbFrame(SF);
    const mesh = buildSuspensionBridge(SPEC, SF, FLAT_HEIGHT);
    // Deck-box prisms are emitted first (appendSuspensionBridge order) and
    // are the wide boxes: `2·halfW` across, ~7.6 m deep. Their along extent
    // is the piece length under test.
    const targetAcross = 2 * (frame.sep / 2 + 2);
    const deckPieces = eachBox(mesh, frame).filter((b) => {
      const da = b.maxA - b.minA;
      const dy = b.maxY - b.minY;
      return Math.abs(da - targetAcross) < 0.5 && Math.abs(dy - 7.6) < 0.5;
    });
    expect(deckPieces.length).toBeGreaterThan(0);
    for (const b of deckPieces) {
      expect(b.maxS - b.minS).toBeLessThanOrEqual(50 + 1e-6);
    }
  });

  it('bridgeAnchors names South and North towers at topY + 4', () => {
    const frame = ggbFrame(SF);
    for (const heightAt of [FLAT_HEIGHT, deck35(SF)]) {
      const anchors = bridgeAnchors(SPEC, SF, heightAt);
      expect(anchors.map((a) => a.name)).toEqual([
        'Golden Gate Bridge South Tower',
        'Golden Gate Bridge North Tower',
      ]);
      expect(anchors.map((a) => a.label)).toEqual([
        'Golden Gate Bridge South Tower',
        'Golden Gate Bridge North Tower',
      ]);
      const south = project(SPEC.towers[0][0], SPEC.towers[0][1], SF.origin);
      const north = project(SPEC.towers[1][0], SPEC.towers[1][1], SF.origin);
      expect(anchors[0]!.x).toBeCloseTo(south[0], 5);
      expect(anchors[0]!.z).toBeCloseTo(south[1], 5);
      expect(anchors[1]!.x).toBeCloseTo(north[0], 5);
      expect(anchors[1]!.z).toBeCloseTo(north[1], 5);
      const topS = deckY(frame, 0, heightAt) + SPEC.towerTopAboveDeck;
      const topN = deckY(frame, frame.span, heightAt) + SPEC.towerTopAboveDeck;
      expect(anchors[0]!.y).toBeCloseTo(topS + 4, 5);
      expect(anchors[1]!.y).toBeCloseTo(topN + 4, 5);
    }
  });

  it('one-walkway spec builds a deck deckWidth wide centred on the walkway', () => {
    const origin = { lat: 0, lon: 0 };
    const southLat = -200 / 110_574;
    const northLat = 200 / 110_574;
    const spec: SuspensionBridgeSpec = {
      name: 'Test Bridge',
      sidewalks: ['Test Promenade'],
      deckWidth: 20,
      deckApexASL: 10,
      deckRoads: [],
      towers: [
        [0, southLat],
        [0, northLat],
      ],
      towerTopAboveDeck: 40,
      sideSpan: 80,
      color: 0x888888,
    };
    const city: CityData = {
      v: 1,
      origin,
      bbox: [0, 0, 0, 0],
      buildings: [],
      roads: [
        {
          id: 1,
          name: 'Test Promenade',
          cls: 'pedestrian',
          bridge: true,
          pts: [
            [0, 300],
            [0, -300],
          ],
        },
      ],
      places: [],
    };
    const south = project(spec.towers[0][0], spec.towers[0][1], origin);
    const north = project(spec.towers[1][0], spec.towers[1][1], origin);
    expect(south[0]).toBeCloseTo(0, 5);
    expect(south[1]).toBeCloseTo(200, 1);
    expect(north[1]).toBeCloseTo(-200, 1);
    const dx = north[0] - south[0];
    const dz = north[1] - south[1];
    const span = Math.hypot(dx, dz);
    const along: Vec2 = [dx / span, dz / span];
    const across: Vec2 = [-along[1], along[0]];
    const frame: Frame = {
      origin: south,
      along,
      across,
      span,
      sep: 20,
      lat: 20 / 2 + 1.4,
      east: namedSegs(city, 'Test Promenade'),
      west: [],
    };
    const mesh = buildSuspensionBridge(spec, city, FLAT_HEIGHT);
    expect(vertexCount(mesh)).toBeGreaterThan(0);
    const targetAcross = 2 * (20 / 2 + 2);
    const deckPieces = eachBox(mesh, frame).filter((b) => {
      const da = b.maxA - b.minA;
      const dy = b.maxY - b.minY;
      return Math.abs(da - targetAcross) < 0.5 && Math.abs(dy - 7.6) < 0.8;
    });
    expect(deckPieces.length).toBeGreaterThan(0);
    for (const b of deckPieces) {
      expect(b.maxA - b.minA).toBeCloseTo(targetAcross, 5);
      const midA = (b.minA + b.maxA) / 2;
      expect(Math.abs(midA)).toBeLessThan(0.5);
    }
  });

  it('nyc bridges: tower centres lie within 3 m of their walkway lines', () => {
    expect(NYC.terrain).toBeDefined();
    const specs = SUSPENSION_BRIDGES.nyc;
    expect(specs?.length).toBe(3);
    for (const spec of specs!) {
      const origin = project(spec.towers[0][0], spec.towers[0][1], NYC.origin);
      const north = project(spec.towers[1][0], spec.towers[1][1], NYC.origin);
      const dx = north[0] - origin[0];
      const dz = north[1] - origin[1];
      const span = Math.hypot(dx, dz);
      const along: Vec2 = [dx / span, dz / span];
      const east = namedSegs(NYC, spec.sidewalks[0]);
      const westName = spec.sidewalks[1];
      const west = westName ? namedSegs(NYC, westName) : [];
      const cw: Vec2 = [along[1], -along[0]];
      const ccw: Vec2 = [-along[1], along[0]];
      let across: Vec2 = ccw;
      if (west.length > 0) {
        const westHint = nearestOnPoly(origin, west);
        expect(westHint, spec.name).not.toBeNull();
        const hx = westHint!.q[0] - origin[0];
        const hz = westHint!.q[1] - origin[1];
        across = hx * cw[0] + hz * cw[1] > 0 ? cw : ccw;
      }
      const frame: Frame = {
        origin,
        along,
        across,
        span,
        sep: spec.deckWidth ?? 20,
        lat: (spec.deckWidth ?? 20) / 2 + 1.4,
        east,
        west,
      };
      for (const s of [0, span]) {
        const tower = axisXZ(frame, s);
        let q: Vec2;
        if (west.length > 0) {
          const e = meanStation(east, frame, s);
          const w = meanStation(west, frame, s);
          expect(e, `${spec.name} east s=${s}`).not.toBeNull();
          expect(w, `${spec.name} west s=${s}`).not.toBeNull();
          q = [(e![0] + w![0]) / 2, (e![1] + w![1]) / 2];
        } else {
          const e = meanStation(east, frame, s);
          expect(e, `${spec.name} walkway s=${s}`).not.toBeNull();
          q = e!;
        }
        const d = Math.hypot(tower[0] - q[0], tower[1] - q[1]);
        expect(d, `${spec.name} s=${s} dist=${d.toFixed(3)}`).toBeLessThan(3);
      }
    }
  });

  it('nyc bridge decks reach their apex within 1 m at mid-span', () => {
    expect(NYC.terrain).toBeDefined();
    const humps = deckHumps('nyc', NYC);
    const terrain = new Terrain(NYC.terrain!);
    const decks = new BridgeDecks(NYC.roads, terrain.heightAt, 25, humps);
    const groundAt = makeGroundAt(terrain, decks);
    for (const spec of SUSPENSION_BRIDGES.nyc!) {
      const south = project(spec.towers[0][0], spec.towers[0][1], NYC.origin);
      const north = project(spec.towers[1][0], spec.towers[1][1], NYC.origin);
      const mid: Vec2 = [(south[0] + north[0]) / 2, (south[1] + north[1]) / 2];
      // Approaches make a chained walkway's t = 0.5 miss the tower midpoint
      // (Williamsburg footpath t_mid ≈ 0.44). The deck as a whole still
      // reaches the apex: take the highest of the spec's sidewalk snaps.
      let y = -Infinity;
      for (const name of spec.sidewalks) {
        const snap = nearestOnPoly(mid, namedSegs(NYC, name));
        expect(snap, `${spec.name} ${name}`).not.toBeNull();
        y = Math.max(y, groundAt(snap!.q[0], snap!.q[1]));
      }
      const apexY = spec.deckApexASL - NYC.terrain!.datum;
      expect(
        Math.abs(y - apexY),
        `${spec.name}: y=${y.toFixed(2)} apexY=${apexY.toFixed(2)}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('deckHumps lists sidewalks and deckRoads with apexY = deckApexASL − datum', () => {
    expect(NYC.terrain).toBeDefined();
    const nycHumps = deckHumps('nyc', NYC);
    expect(nycHumps).toHaveLength(3);
    const datum = NYC.terrain!.datum;
    for (let i = 0; i < nycHumps.length; i++) {
      const spec = SUSPENSION_BRIDGES.nyc![i]!;
      const hump = nycHumps[i]!;
      for (const n of spec.sidewalks) expect(hump.names).toContain(n);
      for (const n of spec.deckRoads) expect(hump.names).toContain(n);
      expect(hump.apexY).toBeCloseTo(spec.deckApexASL - datum, 12);
    }
    const sfHumps = deckHumps('sf', SF);
    expect(sfHumps).toHaveLength(1);
    expect(sfHumps[0]!.names).toEqual(
      expect.arrayContaining([
        'Golden Gate Bridge East Sidewalk',
        'Golden Gate Bridge West Sidewalk',
        'Golden Gate Bridge',
      ]),
    );
    expect(sfHumps[0]!.apexY).toBeCloseTo(67 - SF.terrain!.datum, 12);
    expect(deckHumps('london', stubCity())).toEqual([]);
    expect(deckHumps('kyiv', stubCity())).toEqual([]);
    const flatHumps = deckHumps('sf', { ...SF, terrain: undefined });
    expect(flatHumps[0]!.apexY).toBe(67);
  });

  it('SF bridge with the 67 m apex: cable clearance and portal tests still hold', () => {
    if (!SF.terrain) throw new Error('sf.json has no terrain');
    const humps = deckHumps('sf', SF);
    const terrain = new Terrain(SF.terrain);
    const decks = new BridgeDecks(SF.roads, terrain.heightAt, 25, humps);
    const groundAt = makeGroundAt(terrain, decks);
    const frame = ggbFrame(SF);
    const mesh = buildSuspensionBridge(SPEC, SF, groundAt);

    for (const side of [-1, 1] as const) {
      const stations: { s: number; y: number }[] = [
        { s: 0, y: deckY(frame, 0, groundAt) + SPEC.towerTopAboveDeck },
        { s: frame.span / 2, y: deckY(frame, frame.span / 2, groundAt) + 3 },
        { s: frame.span, y: deckY(frame, frame.span, groundAt) + SPEC.towerTopAboveDeck },
      ];
      for (const st of stations) {
        const xz: Vec2 = [
          frame.origin[0] + frame.along[0] * st.s + side * frame.lat * frame.across[0],
          frame.origin[1] + frame.along[1] * st.s + side * frame.lat * frame.across[1],
        ];
        const y = meanYNear(mesh, xz[0], xz[1], 1.5, st.y, 1.2);
        expect(y, `no cable verts at s=${st.s} side=${side}`).not.toBeNull();
        expect(Math.abs(y! - st.y)).toBeLessThanOrEqual(0.5);
      }
    }

    const posts = eachBox(mesh, frame).filter((b) => {
      const ds = b.maxS - b.minS;
      const da = b.maxA - b.minA;
      const dy = b.maxY - b.minY;
      return Math.abs(ds - 12) < 0.6 && Math.abs(da - 2) < 0.6 && Math.abs(dy - 8) < 0.6;
    });
    expect(posts.length).toBe(8);
    const through: Vec2[] = [];
    for (const r of SF.roads) {
      if (r.name !== SPEC.sidewalks[0] || !r.bridge) continue;
      for (const p of r.pts) {
        if (Math.abs(acrossOf(p, frame.origin, frame.across)) <= frame.sep / 2 + 4) {
          through.push(p);
        }
      }
    }
    expect(through.length).toBeGreaterThan(0);
    for (const post of posts) {
      const sPost = (post.minS + post.maxS) / 2;
      const dYlocal = deckY(frame, sPost, groundAt);
      expect(post.minY).toBeLessThanOrEqual(dYlocal - 1 + 0.2);
      expect(post.maxY).toBeGreaterThanOrEqual(dYlocal + 7 - 0.2);
      for (const v of through) {
        const s = alongOf(v, frame.origin, frame.along);
        const a = acrossOf(v, frame.origin, frame.across);
        expect(distPointToRect(s, a, post)).toBeGreaterThanOrEqual(1.5);
      }
    }
  });
});
