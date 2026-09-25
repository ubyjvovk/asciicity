/**
 * Pure maths for the cyberpunk `vehicles` layer (wave 23c, T-0170;
 * docs/architecture.md §4.11 "Vehicles"): car-model manifest parsing, the
 * stable weighted model pick, distance LODs, model normalisation (yaw +
 * scale-to-length + bottom-centre origin) and headlight / taillight anchors.
 * No three / three/webgpu import — unit-tested in node.
 */

/** Axis-aligned box as plain triples. */
export interface Box3Like {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/** Light anchors in normalised model space: two headlights, two taillights. */
export interface LightAnchors {
  front: [number, number, number][];
  rear: [number, number, number][];
}

/** One car model entry of `public/models/cars/manifest.json`. */
export interface CarModelEntry {
  id: string;
  label: string;
  /** Share of the fleet (relative, ≥ 0). */
  weight: number;
  /** Radians about +y that turn the model so its length runs along z, front at +z. */
  yaw: number;
  /** Real bumper-to-bumper length, metres. */
  length: number;
  /** GLB file names, relative to the manifest. */
  lod0: string;
  lod1: string;
  /** Optional hand-placed anchors (normalised model space, front at +z). */
  lights?: LightAnchors;
}

/** Parsed `manifest.json`. */
export interface CarManifest {
  v: number;
  models: CarModelEntry[];
}

/** Distance (m) below which a car draws its lod0 model. */
export const LOD0_DIST = 45;
/** Distance (m) below which a car draws its lod1 model; beyond it is hidden. */
export const LOD1_DIST = 350;
/** `lodFor` result for a car that is not drawn. */
export const LOD_HIDDEN = -1;
/** Headlight / taillight anchor: fraction of the bbox width off the centre line. */
export const LIGHT_X_FRAC = 0.38;
/** Headlight / taillight anchor: fraction of the bbox height above its bottom. */
export const LIGHT_Y_FRAC = 0.45;
/**
 * Extra yaw between "model faces +z" (the manifest convention) and the fleet
 * instance frame, whose direction of travel is local −z (`rotation.y =
 * −heading`, heading 0 = north = −z). Baked into the geometry.
 */
export const FLEET_YAW = Math.PI;

/** Fractional golden ratio: the Weyl step of the model pick. */
const PHI_FRAC = 0.6180339887498949;

/**
 * Stable weighted model pick for fleet car `i`: a low-discrepancy (Weyl,
 * golden-ratio) sequence mapped through the cumulative weights, so any
 * 20 000 consecutive cars match the weights to well under 1 %. Returns the
 * model index, or −1 when no weight is positive.
 */
export function pickModel(i: number, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) if (w > 0) total += w;
  if (total <= 0) return -1;
  const x = i * PHI_FRAC;
  const u = (x - Math.floor(x)) * total;
  let acc = 0;
  let last = -1;
  for (let k = 0; k < weights.length; k++) {
    const w = weights[k];
    if (!(w > 0)) continue;
    acc += w;
    last = k;
    if (u < acc) return k;
  }
  return last;
}

/** LOD for a car `distance` metres from the camera: 0, 1 or {@link LOD_HIDDEN}. */
export function lodFor(distance: number): number {
  if (distance < LOD0_DIST) return 0;
  if (distance < LOD1_DIST) return 1;
  return LOD_HIDDEN;
}

/** Rotate (x, z) about +y by `yaw` (three.js convention) → [x', z']. */
export function rotateY(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** The bbox of `box` rotated about +y by `yaw` (exact for multiples of π/2). */
export function rotatedBox(box: Box3Like, yaw: number): Box3Like {
  const min: [number, number, number] = [Infinity, box.min[1], Infinity];
  const max: [number, number, number] = [-Infinity, box.max[1], -Infinity];
  for (const x of [box.min[0], box.max[0]]) {
    for (const z of [box.min[2], box.max[2]]) {
      const [rx, rz] = rotateY(x, z, yaw);
      min[0] = Math.min(min[0], rx);
      max[0] = Math.max(max[0], rx);
      min[2] = Math.min(min[2], rz);
      max[2] = Math.max(max[2], rz);
    }
  }
  return { min, max };
}

/**
 * Normalisation of a raw model with bbox `box`: rotate by `yaw`, then scale
 * uniformly so the z extent equals `length`, then translate by `offset` so
 * the bbox bottom-centre sits at the origin. A point maps as
 * `p' = scale · R(yaw) · p + offset`.
 */
export function normaliseTransform(
  box: Box3Like,
  yaw: number,
  length: number,
): { scale: number; offset: [number, number, number] } {
  const r = rotatedBox(box, yaw);
  const zExt = r.max[2] - r.min[2];
  const scale = zExt > 0 ? length / zExt : 1;
  const cx = (r.min[0] + r.max[0]) / 2;
  const cz = (r.min[2] + r.max[2]) / 2;
  return { scale, offset: [-cx * scale, -r.min[1] * scale, -cz * scale] };
}

/** Apply a {@link normaliseTransform} result to one point. */
export function normalisePoint(
  p: readonly [number, number, number],
  yaw: number,
  t: { scale: number; offset: readonly [number, number, number] },
): [number, number, number] {
  const [rx, rz] = rotateY(p[0], p[2], yaw);
  return [rx * t.scale + t.offset[0], p[1] * t.scale + t.offset[1], rz * t.scale + t.offset[2]];
}

/**
 * Head/tail light anchors derived from a normalised bbox: x = centre ±
 * {@link LIGHT_X_FRAC}·width, y = bottom + {@link LIGHT_Y_FRAC}·height, on
 * the front (`forward` = +1 → max z, −1 → min z) and rear bbox ends.
 */
export function lightAnchors(box: Box3Like, forward: 1 | -1 = 1): LightAnchors {
  const w = box.max[0] - box.min[0];
  const h = box.max[1] - box.min[1];
  const cx = (box.min[0] + box.max[0]) / 2;
  const y = box.min[1] + LIGHT_Y_FRAC * h;
  const dx = LIGHT_X_FRAC * w;
  const zf = forward > 0 ? box.max[2] : box.min[2];
  const zr = forward > 0 ? box.min[2] : box.max[2];
  return {
    front: [
      [cx - dx, y, zf],
      [cx + dx, y, zf],
    ],
    rear: [
      [cx - dx, y, zr],
      [cx + dx, y, zr],
    ],
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(o: Record<string, unknown>, k: string, where: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where}: "${k}" must be a finite number`);
  return v;
}

function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${where}: "${k}" must be a non-empty string`);
  return v;
}

function triples(v: unknown, where: string): [number, number, number][] {
  if (!Array.isArray(v)) throw new Error(`${where} must be an array`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`${where}[${i}] must be [x, y, z]`);
    }
    return [p[0] as number, p[1] as number, p[2] as number];
  });
}

/** Validate and parse `manifest.json` (throws with a readable path on bad input). */
export function parseManifest(json: unknown): CarManifest {
  if (!isObj(json)) throw new Error('manifest: not an object');
  const v = num(json, 'v', 'manifest');
  if (!Array.isArray(json.models)) throw new Error('manifest: "models" must be an array');
  const models = json.models.map((m: unknown, i: number): CarModelEntry => {
    const where = `manifest.models[${i}]`;
    if (!isObj(m)) throw new Error(`${where}: not an object`);
    const e: CarModelEntry = {
      id: str(m, 'id', where),
      label: str(m, 'label', where),
      weight: num(m, 'weight', where),
      yaw: num(m, 'yaw', where),
      length: num(m, 'length', where),
      lod0: str(m, 'lod0', where),
      lod1: str(m, 'lod1', where),
    };
    if (e.weight < 0) throw new Error(`${where}: "weight" must be ≥ 0`);
    if (!(e.length > 0)) throw new Error(`${where}: "length" must be > 0`);
    if (m.lights !== undefined) {
      if (!isObj(m.lights)) throw new Error(`${where}.lights: not an object`);
      e.lights = {
        front: triples(m.lights.front, `${where}.lights.front`),
        rear: triples(m.lights.rear, `${where}.lights.rear`),
      };
    }
    return e;
  });
  return { v, models };
}
