/**
 * Heightfield sampler, slope-shaded geometry, and walkable bridge decks
 * (docs/architecture.md §4.9). Pure except `makeTerrainObject`, which is
 * the only caller of `makeGridTexture`.
 */
import * as THREE from 'three';
import type { HeightFn, Road, TerrainData, Vec2 } from '../data/types';
import { distToSegment } from './collision';
import { makeGridTexture } from './ground';
import { ROAD_WIDTH } from './roads';

/** World metres covered by one grid-texture tile (matches the flat ground). */
const TILE_METRES = 40;

/** Un-normalised slope-shade light; matches architecture.md §4.9. */
const SHADE_L = new THREE.Vector3(1, 2, 0.5).normalize();

/** One corridor segment of a `bridge: true` road, with deck heights. */
interface DeckSeg {
  a: Vec2;
  b: Vec2;
  ya: number;
  yb: number;
  halfWidth: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function nodeHeight(t: TerrainData, c: number, r: number): number {
  return t.heights[r * t.cols + c]!;
}

/**
 * Clamped projection parameter of `p` onto segment `a→b` (same `t` as
 * `distToSegment`).
 */
function projectionT(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 0) return 0;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/**
 * Triangle-interpolating height sampler: the same surface
 * `buildTerrainGeometry` draws. Outside the grid, returns the edge value.
 */
export function terrainHeightAt(t: TerrainData, x: number, z: number): number {
  const u = Math.min(Math.max((x - t.x0) / t.step, 0), t.cols - 1);
  const v = Math.min(Math.max((z - t.z0) / t.step, 0), t.rows - 1);
  const c = Math.min(Math.floor(u), t.cols - 2);
  const r = Math.min(Math.floor(v), t.rows - 2);
  const fu = u - c;
  const fv = v - r;
  const h00 = nodeHeight(t, c, r);
  const h10 = nodeHeight(t, c + 1, r);
  const h01 = nodeHeight(t, c, r + 1);
  const h11 = nodeHeight(t, c + 1, r + 1);
  if (fu >= fv) {
    return h00 + fu * (h10 - h00) + fv * (h11 - h10);
  }
  return h00 + fv * (h01 - h00) + fu * (h11 - h01);
}

/** Height grid wrapper: min/max over nodes and a bound `heightAt`. */
export class Terrain {
  /** Source DEM sample. */
  readonly data: TerrainData;
  /** Minimum of `data.heights`. */
  readonly min: number;
  /** Maximum of `data.heights`. */
  readonly max: number;

  constructor(data: TerrainData) {
    this.data = data;
    let min = Infinity;
    let max = -Infinity;
    for (const h of data.heights) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.min = min;
    this.max = max;
    this.heightAt = this.heightAt.bind(this);
  }

  /** Sample the heightfield at local metres `(x, z)`. */
  heightAt(x: number, z: number): number {
    return terrainHeightAt(this.data, x, z);
  }
}

/**
 * Indexed heightfield: shared vertices, two triangles per cell along the
 * same diagonal as `terrainHeightAt`, then vertex normals and slope shade.
 */
export function buildTerrainGeometry(t: TerrainData): THREE.BufferGeometry {
  const { cols, rows, x0, z0, step } = t;
  const vertexCount = cols * rows;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = x0 + c * step;
      const z = z0 + r * step;
      const y = nodeHeight(t, c, r);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x / TILE_METRES;
      uvs[i * 2 + 1] = z / TILE_METRES;
    }
  }
  const cellCount = (cols - 1) * (rows - 1);
  const indices = new Uint32Array(cellCount * 6);
  let w = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = (r + 1) * cols + c;
      const i11 = i01 + 1;
      indices[w++] = i00;
      indices[w++] = i01;
      indices[w++] = i11;
      indices[w++] = i00;
      indices[w++] = i11;
      indices[w++] = i10;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const normals = geo.getAttribute('normal');
  const colors = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const nx = normals.getX(i);
    const ny = normals.getY(i);
    const nz = normals.getZ(i);
    const ndotl = nx * SHADE_L.x + ny * SHADE_L.y + nz * SHADE_L.z;
    const s = Math.min(1, 0.6 + 0.5 * Math.max(0, ndotl));
    colors[i * 3] = s;
    colors[i * 3 + 1] = s;
    colors[i * 3 + 2] = s;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Browser-only mesh: the heightfield with the same 40 m grid texture as the
 * flat ground, modulated by per-vertex slope shade.
 */
export function makeTerrainObject(t: TerrainData): THREE.Mesh {
  return new THREE.Mesh(
    buildTerrainGeometry(t),
    new THREE.MeshBasicMaterial({ map: makeGridTexture(), vertexColors: true }),
  );
}

/**
 * Straight deck between the abutments, never below the sampled ground at a
 * polyline vertex. A 2-point polyline is `[ya, yb]`.
 */
export function bridgeProfile(pts: Vec2[], heightAt: HeightFn): number[] {
  const n = pts.length;
  const first = pts[0]!;
  const last = pts[n - 1]!;
  const ya = heightAt(first[0], first[1]);
  const yb = heightAt(last[0], last[1]);
  const cum = new Array<number>(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    const p = pts[i]!;
    const q = pts[i - 1]!;
    cum[i] = cum[i - 1]! + Math.hypot(p[0] - q[0], p[1] - q[1]);
  }
  const total = cum[n - 1]!;
  const ys = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const ti = total > 0 ? cum[i]! / total : 0;
    const deck = ya + (yb - ya) * ti;
    ys[i] = Math.max(deck, heightAt(p[0], p[1]));
  }
  return ys;
}

/** Distance between two points, in metres. */
function vdist(p: Vec2, q: Vec2): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

/**
 * Attach `piece` onto `chain` at a coincident endpoint (≤ 0.5 m) in one of
 * the four orientations (forward/reversed × prepend/append), mutating
 * `chain.pts` and dropping the duplicated joint vertex on a match. Returns
 * whether an attachment happened.
 */
function attachBridgePiece(chain: Road, piece: Road): boolean {
  const L = chain.pts;
  const P = piece.pts;
  const cFirst = L[0]!;
  const cLast = L[L.length - 1]!;
  const pFirst = P[0]!;
  const pLast = P[P.length - 1]!;
  if (vdist(cLast, pFirst) <= 0.5) {
    L.push(...P.slice(1));
    return true;
  }
  if (vdist(cFirst, pLast) <= 0.5) {
    L.unshift(...P.slice(0, -1));
    return true;
  }
  if (vdist(cLast, pLast) <= 0.5) {
    L.push(...P.slice(0, -1).reverse());
    return true;
  }
  if (vdist(cFirst, pFirst) <= 0.5) {
    L.unshift(...P.slice(1).reverse());
    return true;
  }
  return false;
}

/**
 * Chain bridge roads that share a non-empty `name` and meet at coincident
 * endpoints (≤ 0.5 m; a piece may be appended or prepended and REVERSED to
 * fit) into single polylines, so `bridgeProfile` runs over the chain's true
 * abutments rather than one piece's own ends (architecture.md §4.9).
 * Non-bridge roads, unnamed bridge roads and pieces that never join pass
 * through untouched. The result is independent of input order (loop to
 * fixpoint); the chained road keeps its first piece's `id`/`cls`/`name`/
 * `bridge` and drops the duplicated joint vertex.
 */
export function chainBridgeRoads(roads: Road[]): Road[] {
  const work: (Road | null)[] = roads.map((r) => ({ ...r, pts: r.pts.slice() }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < work.length; i++) {
      const a = work[i];
      if (a === null) continue;
      if (a.bridge !== true || a.name === undefined || a.name.trim() === '') continue;
      for (let j = 0; j < i; j++) {
        const b = work[j];
        if (b === null) continue;
        if (b.bridge !== true || b.name !== a.name) continue;
        if (attachBridgePiece(b, a)) {
          work[i] = null;
          changed = true;
          break;
        }
      }
    }
  }
  return work.filter((r): r is Road => r !== null);
}

/**
 * Spatial hash of bridge-road corridors. `deckAt` returns the highest deck
 * under `p`, or `undefined` when `p` is outside every corridor.
 */
export class BridgeDecks {
  private readonly cell: number;
  private readonly cells: Map<string, DeckSeg[]> = new Map();

  /**
   * Bucket every segment of every `bridge === true` road. `cell` defaults to
   * 25 m, matching `CollisionGrid` corridors.
   */
  constructor(roads: Road[], heightAt: HeightFn, cell = 25) {
    this.cell = cell;
    // Chain same-name bridge pieces into one polyline first, so a multi-piece
    // bridge (e.g. the Golden Gate Bridge East Sidewalk) is profiled between
    // its true abutments instead of between each piece's own water-level ends.
    for (const road of chainBridgeRoads(roads)) {
      if (road.bridge !== true) continue;
      const pts = road.pts;
      if (pts.length < 2) continue;
      const ys = bridgeProfile(pts, heightAt);
      const halfWidth = ROAD_WIDTH[road.cls] / 2 + 1;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const minX = Math.min(a[0], b[0]) - halfWidth;
        const maxX = Math.max(a[0], b[0]) + halfWidth;
        const minZ = Math.min(a[1], b[1]) - halfWidth;
        const maxZ = Math.max(a[1], b[1]) + halfWidth;
        const seg: DeckSeg = {
          a,
          b,
          ya: ys[i]!,
          yb: ys[i + 1]!,
          halfWidth,
          minX,
          maxX,
          minZ,
          maxZ,
        };
        const cxMin = Math.floor(minX / cell);
        const cxMax = Math.floor(maxX / cell);
        const czMin = Math.floor(minZ / cell);
        const czMax = Math.floor(maxZ / cell);
        for (let cx = cxMin; cx <= cxMax; cx++) {
          for (let cz = czMin; cz <= czMax; cz++) {
            const key = `${cx},${cz}`;
            let bucket = this.cells.get(key);
            if (!bucket) {
              bucket = [];
              this.cells.set(key, bucket);
            }
            bucket.push(seg);
          }
        }
      }
    }
  }

  /** Deck height under `p`, or `undefined` when no corridor contains `p`. */
  deckAt(p: Vec2): number | undefined {
    const cx = Math.floor(p[0] / this.cell);
    const cz = Math.floor(p[1] / this.cell);
    let maxY = -Infinity;
    let hit = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.cells.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          if (
            p[0] >= seg.minX &&
            p[0] <= seg.maxX &&
            p[1] >= seg.minZ &&
            p[1] <= seg.maxZ &&
            distToSegment(p, seg.a, seg.b) <= seg.halfWidth
          ) {
            const t = projectionT(p, seg.a, seg.b);
            const y = seg.ya + (seg.yb - seg.ya) * t;
            if (y > maxY) maxY = y;
            hit = true;
          }
        }
      }
    }
    return hit ? maxY : undefined;
  }
}

/**
 * Walkable ground: the higher of the terrain sample and any bridge deck.
 * With neither argument this is `y = 0` (London / the synthetic city).
 */
export function makeGroundAt(
  terrain: Terrain | undefined,
  decks: BridgeDecks | undefined,
): HeightFn {
  return (x, z) =>
    Math.max(terrain?.heightAt(x, z) ?? 0, decks?.deckAt([x, z]) ?? -Infinity);
}
