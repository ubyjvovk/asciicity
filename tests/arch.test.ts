/**
 * Unit tests for the Sydney Harbour Bridge arch structure
 * (`src/world/bridge.ts`, architecture.md §4.16b). Case names match the
 * ticket fixtures verbatim. Uses the memoized tiled-dataset helpers so the
 * heavy tile reads happen only once per vitest worker (T-0101 lesson).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLAT_HEIGHT, type CityData, type Vec2 } from '../src/data/types';
import { project } from '../src/geo';
import {
  ARCH_BRIDGES,
  SUSPENSION_BRIDGES,
  archAnchors,
  buildArchBridge,
  deckHumps,
  makeBridgesObject,
} from '../src/world/bridge';
import type { MeshData } from '../src/world/mesh';
import { BridgeDecks, Terrain, chainBridgeRoads, makeGroundAt } from '../src/world/terrain';
import { loadTiledGlobals } from './tiledCity';

const SYD: CityData = loadTiledGlobals('sydney');
const SPEC = ARCH_BRIDGES.sydney![0]!;

interface Seg {
  a: Vec2;
  b: Vec2;
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

function nearestOnPoly(p: Vec2, pts: readonly Vec2[]): { q: Vec2; d: number } {
  let best: { q: Vec2; d: number } = { q: p, d: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const r = nearestOnSegment(p, pts[i]!, pts[i + 1]!);
    if (r.d < best.d) best = r;
  }
  return best;
}

interface AxisFrame {
  origin: Vec2;
  along: Vec2;
  across: Vec2;
  span: number;
}

function makeAxisFrame(city: CityData): AxisFrame {
  const south = project(SPEC.ends[0][0], SPEC.ends[0][1], city.origin);
  const north = project(SPEC.ends[1][0], SPEC.ends[1][1], city.origin);
  const dx = north[0] - south[0];
  const dz = north[1] - south[1];
  const span = Math.hypot(dx, dz);
  const along: Vec2 = [dx / span, dz / span];
  const across: Vec2 = [-along[1], along[0]];
  return { origin: south, along, across, span };
}

function projectAxis(p: Vec2, frame: AxisFrame): { s: number; a: number } {
  const dx = p[0] - frame.origin[0];
  const dz = p[1] - frame.origin[1];
  return {
    s: dx * frame.along[0] + dz * frame.along[1],
    a: dx * frame.across[0] + dz * frame.across[1],
  };
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
}

function eachBox(m: MeshData, frame: AxisFrame): BoxExt[] {
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
    }
    out.push({ minS, maxS, minA, maxA, minY, maxY });
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

/** Chained axis-walkway polyline (single longest chain of `sidewalks[0]`). */
function longestAxisChain(city: CityData): Vec2[] {
  const chains = chainBridgeRoads(city.roads).filter(
    (r) => r.name === SPEC.sidewalks[0] && r.bridge === true,
  );
  const polyLen = (pts: Vec2[]): number => {
    let s = 0;
    for (let i = 1; i < pts.length; i++)
      s += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    return s;
  };
  return chains.slice().sort((a, b) => polyLen(b.pts) - polyLen(a.pts))[0]!.pts;
}

/** Signed area of a ring (shoelace). */
function ringArea(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i]!;
    const [x1, z1] = pts[(i + 1) % pts.length]!;
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** Even-odd point-in-polygon on a single ring. */
function pointInRing(x: number, z: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    const intersect =
      zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Bisection-refined shoreline crossings of `chain` with the largest water
 * ring in `city.water` (by |polygon area|). Returns 0 or more crossing
 * points; the rework rule expects exactly two for the Sydney dataset.
 */
function shorelineCrossings(city: CityData, chain: readonly Vec2[]): Vec2[] {
  if (!city.water || city.water.length === 0) return [];
  const rings = city.water.map((pts) => ({ pts, area: Math.abs(ringArea(pts)) }));
  rings.sort((a, b) => b.area - a.area);
  const ring = rings[0]!.pts;
  const out: Vec2[] = [];
  let prev = pointInRing(chain[0]![0], chain[0]![1], ring);
  for (let i = 1; i < chain.length; i++) {
    const cur = pointInRing(chain[i]![0], chain[i]![1], ring);
    if (cur !== prev) {
      const [x0, z0] = chain[i - 1]!;
      const [x1, z1] = chain[i]!;
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        const px = x0 + (x1 - x0) * mid;
        const pz = z0 + (z1 - z0) * mid;
        if (pointInRing(px, pz, ring) === prev) lo = mid;
        else hi = mid;
      }
      const t = (lo + hi) / 2;
      out.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
    }
    prev = cur;
  }
  return out;
}

/** Cheap deck-y approximation for tests without terrain wiring. */
function flatDeckLookup(): (x: number, z: number) => number {
  return () => 0;
}

/** Terrain + BridgeDecks (with humps) wired the same way main.ts does. */
function groundAtFor(city: CityData): (x: number, z: number) => number {
  if (!city.terrain) throw new Error('sydney tiled globals must have terrain');
  const humps = deckHumps('sydney', city);
  const terrain = new Terrain(city.terrain);
  const decks = new BridgeDecks(city.roads, terrain.heightAt, 25, humps);
  return makeGroundAt(terrain, decks);
}

describe('src/world/bridge.ts arch', () => {
  it('ARCH_BRIDGES has exactly one sydney entry per §4.16b', () => {
    const keys = Object.keys(ARCH_BRIDGES);
    expect(keys).toEqual(['sydney']);
    expect(ARCH_BRIDGES.sydney).toHaveLength(1);
    expect(SPEC.name).toBe('Sydney Harbour Bridge');
    expect(SPEC.sidewalks).toEqual(['Bradfield Highway']);
    expect(SPEC.deckWidth).toBe(49);
    expect(SPEC.deckApexASL).toBe(49);
    expect(SPEC.archTopASL).toBe(134);
    expect(SPEC.archBottomASL).toBe(116);
    expect(SPEC.springASL).toBe(12);
    expect(SPEC.ribSep).toBe(30);
    expect(SPEC.pylonTopASL).toBe(89);
    expect(SPEC.pylonSize).toEqual([16, 22]);
    expect(SPEC.pylonOffset).toBe(30);
    expect(SPEC.color).toBe(0x878c91);
    expect(SPEC.pylonColor).toBe(0xb5a98f);
    expect(SPEC.deckRoads).toEqual(['Harbour Bridge Cycleway', 'Cahill Walk']);
  });

  it('both spec `ends` sit on the polyline AND near the largest-water-ring shoreline crossings; span 503 ± 15 m', () => {
    // Rework rule (T-0112): the arch anchors to where the deck actually
    // crosses the LARGEST water ring by |polygon area| (not the odd-parity
    // test — the shipped dataset has two near-duplicate giant harbour rings
    // per the T-0116 coastline-closure bug, and odd-parity would call their
    // overlap land). Each end sits 21 m LAND-ward of a shoreline crossing;
    // the largest-ring rule stays correct before and after that data fix.
    const chain = longestAxisChain(SYD);
    const crossings = shorelineCrossings(SYD, chain);
    expect(crossings, 'expected exactly two shoreline crossings').toHaveLength(2);
    for (const end of SPEC.ends) {
      const p = project(end[0], end[1], SYD.origin);
      const nearChain = nearestOnPoly(p, chain);
      expect(
        nearChain.d,
        `spec end [${end.join(',')}] proj [${p.map((v) => v.toFixed(2)).join(',')}] chain-dist=${nearChain.d.toFixed(2)}`,
      ).toBeLessThanOrEqual(20);
      let bestShore = Infinity;
      for (const c of crossings) {
        const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
        if (d < bestShore) bestShore = d;
      }
      expect(
        bestShore,
        `spec end [${end.join(',')}] shore-dist=${bestShore.toFixed(2)}`,
      ).toBeLessThanOrEqual(30);
    }
    const [s, n] = SPEC.ends.map((e) => project(e[0], e[1], SYD.origin));
    const span = Math.hypot(n![0] - s![0], n![1] - s![1]);
    expect(Math.abs(span - 503), `span ${span.toFixed(2)} m`).toBeLessThanOrEqual(15);
  });

  it('the top-chord crown vertex (max-y) lies within 30 m (x/z) of the midpoint of ends', () => {
    const mesh = buildArchBridge(SPEC, SYD, FLAT_HEIGHT);
    let maxY = -Infinity;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1]!;
      if (y > maxY) {
        maxY = y;
        cx = mesh.positions[i]!;
        cz = mesh.positions[i + 2]!;
      }
    }
    const s = project(SPEC.ends[0][0], SPEC.ends[0][1], SYD.origin);
    const n = project(SPEC.ends[1][0], SPEC.ends[1][1], SYD.origin);
    const midX = (s[0] + n[0]) / 2;
    const midZ = (s[1] + n[1]) / 2;
    const dxz = Math.hypot(cx - midX, cz - midZ);
    expect(
      dxz,
      `crown vertex at (${cx.toFixed(2)}, ${cz.toFixed(2)}), mid (${midX.toFixed(2)}, ${midZ.toFixed(2)}), dxz=${dxz.toFixed(2)}`,
    ).toBeLessThanOrEqual(30);
  });

  it('top-chord peak y = (archTopASL − datum) ± 1 at mid-span', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const mesh = buildArchBridge(SPEC, SYD, FLAT_HEIGHT);
    const frame = makeAxisFrame(SYD);
    const expectedY = SPEC.archTopASL - datum;
    // Cap vertices of a chord beam sit at the CENTRELINE ± half the beam
    // cross-section, so peak-centerline y = mean(min y, max y) among vertices
    // within a small window around mid-span (near the crown u is horizontal
    // so v is vertical: min y ≈ crown − 1.25, max y ≈ crown + 1.25).
    let peakMin = Infinity;
    let peakMax = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]!;
      const y = mesh.positions[i + 1]!;
      const z = mesh.positions[i + 2]!;
      const s =
        (x - frame.origin[0]) * frame.along[0] + (z - frame.origin[1]) * frame.along[1];
      if (Math.abs(s - frame.span / 2) < 8 && y > expectedY - 3 && y < expectedY + 3) {
        if (y < peakMin) peakMin = y;
        if (y > peakMax) peakMax = y;
      }
    }
    expect(Number.isFinite(peakMin) && Number.isFinite(peakMax)).toBe(true);
    const centerY = (peakMin + peakMax) / 2;
    expect(Math.abs(centerY - expectedY)).toBeLessThanOrEqual(1);
  });

  it('both chords of each rib meet at (springASL − datum) ± 0.5 at both ends', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const yS = SPEC.springASL - datum;
    const mesh = buildArchBridge(SPEC, SYD, FLAT_HEIGHT);
    const frame = makeAxisFrame(SYD);
    const halfRib = SPEC.ribSep / 2;
    // Near a springing the chord slopes steeply, so beam cap verts sit ±(hh *
    // |v_y|) around the endpoint y = yS. Compare the mean of the y extents in
    // a small along/across window against yS ± 0.5 — that's the centerline.
    for (const sTarget of [0, frame.span]) {
      for (const ribSide of [-1, 1]) {
        const aTarget = ribSide * halfRib;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < mesh.positions.length; i += 3) {
          const x = mesh.positions[i]!;
          const y = mesh.positions[i + 1]!;
          const z = mesh.positions[i + 2]!;
          const s =
            (x - frame.origin[0]) * frame.along[0] + (z - frame.origin[1]) * frame.along[1];
          const a =
            (x - frame.origin[0]) * frame.across[0] +
            (z - frame.origin[1]) * frame.across[1];
          if (Math.abs(s - sTarget) > 3) continue;
          if (Math.abs(a - aTarget) > 3) continue;
          if (Math.abs(y - yS) > 3) continue;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        expect(
          Number.isFinite(minY) && Number.isFinite(maxY),
          `rib side=${ribSide} at s=${sTarget}: no chord verts near springing`,
        ).toBe(true);
        const centerY = (minY + maxY) / 2;
        expect(Math.abs(centerY - yS)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('hangers exist only where the bottom chord is ≥ 2 m above deck, struts only where ≥ 2 m below', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const yBotCrown = SPEC.archBottomASL - datum;
    const yS = SPEC.springASL - datum;
    const groundAt = groundAtFor(SYD);
    const mesh = buildArchBridge(SPEC, SYD, groundAt);
    const frame = makeAxisFrame(SYD);
    // Isolate hanger/strut boxes: 0.8 m square in along and across, tall in y.
    const halfDeck = SPEC.deckWidth! / 2;
    const posts = eachBox(mesh, frame).filter((b) => {
      const dS = b.maxS - b.minS;
      const dA = b.maxA - b.minA;
      const midA = (b.minA + b.maxA) / 2;
      return (
        Math.abs(dS - 0.8) < 0.1 &&
        Math.abs(dA - 0.8) < 0.1 &&
        Math.abs(Math.abs(midA) - halfDeck) < 0.5
      );
    });
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      const sMid = (post.minS + post.maxS) / 2;
      const t = sMid / frame.span;
      const yB = yS + (yBotCrown - yS) * 4 * t * (1 - t);
      const yD = groundAt(
        frame.origin[0] + frame.along[0] * sMid,
        frame.origin[1] + frame.along[1] * sMid,
      );
      const above = yB - yD;
      // A hanger has its top at yB (the bottom chord) and its bottom at deck.
      // A strut has its top at deck and its bottom at yB.
      const topIsChord = Math.abs(post.maxY - yB) < Math.abs(post.minY - yB);
      if (topIsChord) {
        expect(above, `hanger at s=${sMid.toFixed(1)} above=${above.toFixed(2)}`).toBeGreaterThanOrEqual(
          2 - 0.05,
        );
      } else {
        expect(-above, `strut at s=${sMid.toFixed(1)} above=${above.toFixed(2)}`).toBeGreaterThanOrEqual(
          2 - 0.05,
        );
      }
    }
  });

  it('4 pylon boxes with top y = (pylonTopASL − datum) ± 0.5', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const yP = SPEC.pylonTopASL - datum;
    const groundAt = groundAtFor(SYD);
    const mesh = buildArchBridge(SPEC, SYD, groundAt);
    const frame = makeAxisFrame(SYD);
    // Pylons are `[pW, pL] = [16, 22]` across × along, centred beyond each
    // springing at s ∈ {−pylonOffset, span + pylonOffset}.
    const [pW, pL] = SPEC.pylonSize;
    const pylons = eachBox(mesh, frame).filter((b) => {
      const dS = b.maxS - b.minS;
      const dA = b.maxA - b.minA;
      return Math.abs(dS - pL) < 0.5 && Math.abs(dA - pW) < 0.5;
    });
    expect(pylons).toHaveLength(4);
    for (const b of pylons) {
      expect(Math.abs(b.maxY - yP)).toBeLessThanOrEqual(0.5);
    }
    // Two south (s ≈ −pylonOffset) and two north (s ≈ span + pylonOffset).
    const south = pylons.filter((b) => (b.minS + b.maxS) / 2 < 0);
    const north = pylons.filter((b) => (b.minS + b.maxS) / 2 > frame.span);
    expect(south).toHaveLength(2);
    expect(north).toHaveLength(2);
  });

  it('vertex count < 25 000 and no NaN in positions or normals', () => {
    for (const heightAt of [FLAT_HEIGHT, groundAtFor(SYD)]) {
      const mesh = buildArchBridge(SPEC, SYD, heightAt);
      const n = vertexCount(mesh);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(25000);
      for (let i = 0; i < mesh.positions.length; i++) {
        expect(Number.isFinite(mesh.positions[i])).toBe(true);
      }
      for (let i = 0; i < mesh.normals.length; i++) {
        expect(Number.isFinite(mesh.normals[i])).toBe(true);
      }
    }
  });

  it('every §4.16b part kind is present in the built mesh', () => {
    const datum = SYD.terrain?.datum ?? 0;
    const groundAt = groundAtFor(SYD);
    const mesh = buildArchBridge(SPEC, SYD, groundAt);
    const frame = makeAxisFrame(SYD);
    const boxes = eachBox(mesh, frame);
    const halfRib = SPEC.ribSep / 2;
    const halfDeck = SPEC.deckWidth! / 2;

    // Truss verticals: 1.2 m square, centred at ±halfRib across, tall in y.
    const trussPosts = boxes.filter((b) => {
      const dS = b.maxS - b.minS;
      const dA = b.maxA - b.minA;
      const dY = b.maxY - b.minY;
      const midA = (b.minA + b.maxA) / 2;
      return (
        Math.abs(dS - 1.2) < 0.1 &&
        Math.abs(dA - 1.2) < 0.1 &&
        dY > 5 &&
        Math.abs(Math.abs(midA) - halfRib) < 0.5
      );
    });
    expect(trussPosts.length, 'truss verticals').toBeGreaterThan(0);

    // Hangers/struts: 0.8 m square, centred at ±halfDeck.
    const posts = boxes.filter((b) => {
      const dS = b.maxS - b.minS;
      const dA = b.maxA - b.minA;
      const midA = (b.minA + b.maxA) / 2;
      return (
        Math.abs(dS - 0.8) < 0.1 &&
        Math.abs(dA - 0.8) < 0.1 &&
        Math.abs(Math.abs(midA) - halfDeck) < 0.5
      );
    });
    const yBotCrown = SPEC.archBottomASL - datum;
    const yS = SPEC.springASL - datum;
    let hangers = 0;
    let struts = 0;
    for (const p of posts) {
      const sMid = (p.minS + p.maxS) / 2;
      const t = sMid / frame.span;
      const yB = yS + (yBotCrown - yS) * 4 * t * (1 - t);
      const yD = groundAt(
        frame.origin[0] + frame.along[0] * sMid,
        frame.origin[1] + frame.along[1] * sMid,
      );
      if (yB - yD >= 2 - 0.05) hangers++;
      else if (yD - yB >= 2 - 0.05) struts++;
    }
    expect(hangers, 'hangers').toBeGreaterThan(0);
    expect(struts, 'struts').toBeGreaterThan(0);

    // Cross-braces: 0.8 m thick, spanning between the two ribs' inner faces.
    const innerSpan = SPEC.ribSep - 1.2; // TRUSS_W = 1.2
    const braces = boxes.filter((b) => {
      const dS = b.maxS - b.minS;
      const dA = b.maxA - b.minA;
      const midA = (b.minA + b.maxA) / 2;
      return (
        Math.abs(dS - 0.8) < 0.1 &&
        Math.abs(dA - innerSpan) < 0.5 &&
        Math.abs(midA) < 0.5
      );
    });
    expect(braces.length, 'cross-braces').toBeGreaterThan(0);

    // Deck box sloped pieces: full deckWidth across, ~6 m deep, along ≤ 25 m.
    const deckPieces = boxes.filter((b) => {
      const dA = b.maxA - b.minA;
      const dY = b.maxY - b.minY;
      return Math.abs(dA - SPEC.deckWidth!) < 0.5 && Math.abs(dY - 6) < 0.8;
    });
    expect(deckPieces.length, 'deck-box sloped pieces').toBeGreaterThan(0);
    for (const b of deckPieces) {
      expect(b.maxS - b.minS).toBeLessThanOrEqual(25 + 1e-6);
    }

    // Chords: 2.5 m square-section beams. Beams write 36 verts per segment.
    // Chord segment count = 2 ribs × 2 chords × ceil(span/15) segments.
    const nChord = Math.max(2, Math.ceil(frame.span / 15));
    const expectedChordSegs = 2 * 2 * nChord;
    // Chord beam vertex count = 36 per segment; we can only assert a floor.
    expect(vertexCount(mesh)).toBeGreaterThan(expectedChordSegs * 36 * 0.5);

    // Tag anchor: exactly one, at mid-span, y = archTopY + 6.
    const anchors = archAnchors(SPEC, SYD, groundAt);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.name).toBe('Sydney Harbour Bridge');
    expect(anchors[0]!.label).toBe('Sydney Harbour Bridge');
    const mid = [
      frame.origin[0] + frame.along[0] * (frame.span / 2),
      frame.origin[1] + frame.along[1] * (frame.span / 2),
    ];
    expect(anchors[0]!.x).toBeCloseTo(mid[0]!, 5);
    expect(anchors[0]!.z).toBeCloseTo(mid[1]!, 5);
    expect(anchors[0]!.y).toBeCloseTo(SPEC.archTopASL - datum + 6, 5);
  });

  it('every non-sydney city id → empty MeshData and zero anchors', () => {
    const city = stubCity();
    for (const id of ['london', 'kyiv', 'sf', 'nyc', 'tokyo', 'synthetic']) {
      expect(ARCH_BRIDGES[id] ?? []).toEqual([]);
      const anchors = (ARCH_BRIDGES[id] ?? []).flatMap((s) => archAnchors(s, city, FLAT_HEIGHT));
      expect(anchors).toHaveLength(0);
      // Round-trip via makeBridgesObject with a stub city (no bridges of any
      // kind) — the returned mesh must be empty for non-arch, non-suspension.
      if (!SUSPENSION_BRIDGES[id]) {
        const obj = makeBridgesObject(id, city, FLAT_HEIGHT);
        expect(obj).toBeInstanceOf(THREE.Mesh);
        const attr = (obj as THREE.Mesh).geometry.getAttribute('position');
        expect(attr.count).toBe(0);
      }
    }
  });

  it("deckHumps('sydney', city) returns one hump with the sidewalks+deckRoads names and apexY = 49 − datum", () => {
    const datum = SYD.terrain?.datum ?? 0;
    const humps = deckHumps('sydney', SYD);
    expect(humps).toHaveLength(1);
    expect(humps[0]!.names).toEqual([
      'Bradfield Highway',
      'Harbour Bridge Cycleway',
      'Cahill Walk',
    ]);
    expect(humps[0]!.apexY).toBeCloseTo(SPEC.deckApexASL - datum, 12);
    // Flat cities (no terrain) fall back to apexY = deckApexASL.
    const flat = deckHumps('sydney', { ...SYD, terrain: undefined });
    expect(flat[0]!.apexY).toBe(SPEC.deckApexASL);
  });

  it('archAnchors on a stub city (no matching walkway) returns []', () => {
    const anchors = archAnchors(SPEC, stubCity(), FLAT_HEIGHT);
    expect(anchors).toEqual([]);
  });

  it('buildArchBridge on a stub city (no matching walkway) returns an empty MeshData', () => {
    const mesh = buildArchBridge(SPEC, stubCity(), flatDeckLookup());
    expect(vertexCount(mesh)).toBe(0);
  });
});
