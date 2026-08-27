/**
 * Floating landmark labels (docs/architecture.md §4.13): pure anchor/pick
 * helpers plus a thin DOM pool that projects the nearest tags onto the
 * viewport. No per-frame allocation in {@link Tags.update}.
 */
import * as THREE from 'three';
import { FLAT_HEIGHT, type Building, type CityData, type HeightFn } from '../data/types';

/** Max simultaneous on-screen tags (pool size and {@link pickTags} default). */
const TAG_POOL = 8;
/** Metres of 2-D range; tags farther than this are dropped. */
const TAG_MAX_DIST = 600;
/** Metres the tag sits above the roof centroid. */
const TAG_LIFT = 4;

/** A named landmark projected as a floating DOM tag. */
export interface TagAnchor {
  name: string;
  label: string;
  x: number;
  y: number;
  z: number;
}

/**
 * Per-building override consulted for the tag label. Extra fields (`h`,
 * `color`, …) match `LandmarkFix` so the curated table can be passed through.
 */
export interface TagFix {
  label?: string;
  h?: number;
  color?: number;
}

/**
 * Anchors for buildings that carry a landmark fix (exact name in
 * `fixesForCity`) or an extra (`id <= −1000`, appended by `applyLandmarks`).
 * `y` is `roofY + 4` with `roofY = max(heightAt over the ring) + h`.
 */
export function landmarkAnchors(
  city: CityData,
  fixesForCity: Readonly<Record<string, TagFix>>,
  heightAt: HeightFn = FLAT_HEIGHT,
): TagAnchor[] {
  const out: TagAnchor[] = [];
  for (const b of city.buildings) {
    if (!isTaggedBuilding(b, fixesForCity)) continue;
    const name = b.name;
    const { x, z, roofY } = centroidRoof(b, heightAt);
    const fix = fixesForCity[name];
    out.push({
      name,
      label: fix?.label ?? name,
      x,
      y: roofY + TAG_LIFT,
      z,
    });
  }
  return out;
}

/**
 * Nearest `max` anchors within `maxDist` of `(px, pz)`, nearest first.
 * Distances are 2-D (x/z); a point at exactly `maxDist` is kept.
 */
export function pickTags(
  anchors: readonly TagAnchor[],
  px: number,
  pz: number,
  maxDist = TAG_MAX_DIST,
  max = TAG_POOL,
): TagAnchor[] {
  const maxDist2 = maxDist * maxDist;
  const within: { a: TagAnchor; d2: number }[] = [];
  for (const a of anchors) {
    const dx = a.x - px;
    const dz = a.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 <= maxDist2) within.push({ a, d2 });
  }
  within.sort((p, q) => p.d2 - q.d2);
  const n = Math.min(max, within.length);
  const out: TagAnchor[] = [];
  for (let i = 0; i < n; i++) out.push(within[i]!.a);
  return out;
}

/**
 * Fixed pool of 8 `div.tag` elements. `update` projects each anchor with
 * `Vector3.project(camera)` and reuses the pool — no per-frame allocation.
 */
export class Tags {
  private readonly pool: HTMLElement[] = [];
  private readonly scratch = new THREE.Vector3();

  constructor(root: HTMLElement) {
    const doc = root.ownerDocument;
    for (let i = 0; i < TAG_POOL; i++) {
      const el = doc.createElement('div');
      el.className = 'tag';
      el.style.display = 'none';
      root.append(el);
      this.pool.push(el);
    }
  }

  /**
   * Project `anchors` (already picked / capped) into CSS `left`/`top`.
   * Hidden when NDC `z > 1` or the pixel is outside `[0, w] × [0, h]`.
   */
  update(anchors: readonly TagAnchor[], camera: THREE.Camera, w: number, h: number): void {
    camera.updateMatrixWorld();
    for (let i = 0; i < TAG_POOL; i++) {
      const el = this.pool[i]!;
      const a = anchors[i];
      if (a === undefined) {
        el.style.display = 'none';
        continue;
      }
      this.scratch.set(a.x, a.y, a.z).project(camera);
      if (this.scratch.z > 1) {
        el.style.display = 'none';
        continue;
      }
      const left = (this.scratch.x * 0.5 + 0.5) * w;
      const top = (-this.scratch.y * 0.5 + 0.5) * h;
      if (left < 0 || left > w || top < 0 || top > h) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.textContent = a.label;
    }
  }
}

/** True when `b` is a named fix-table building or an extra (`id <= −1000`). */
function isTaggedBuilding(
  b: Building,
  fixesForCity: Readonly<Record<string, TagFix>>,
): b is Building & { name: string } {
  if (b.name === undefined || b.poly.length === 0) return false;
  if (Object.prototype.hasOwnProperty.call(fixesForCity, b.name)) return true;
  return b.id <= -1000;
}

/** Footprint centroid and roof height (max terrain on the ring + `h`). */
function centroidRoof(
  b: Building,
  heightAt: HeightFn,
): { x: number; z: number; roofY: number } {
  let cx = 0;
  let cz = 0;
  let top = -Infinity;
  for (const p of b.poly) {
    cx += p[0];
    cz += p[1];
    const gy = heightAt(p[0], p[1]);
    if (gy > top) top = gy;
  }
  const n = b.poly.length;
  return { x: cx / n, z: cz / n, roofY: top + b.h };
}
