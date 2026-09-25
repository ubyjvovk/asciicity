/**
 * Cyberpunk layer `vehicles` (wave 23c, T-0170): draws the live passenger
 * car fleet (`ctx.traffic()`) with real car models from
 * `public/models/cars/` — 11 GLBs × 2 LODs, instanced, with head/tail light
 * quads, lod0 road beams and a forced metallic paint sheen. Contract:
 * `layer.ts` and docs/architecture.md §4.11 "Vehicles". Pure maths lives in
 * `vehiclemath.ts`; notes in docs/styles/cyberpunk-vehicles.md.
 *
 * Each (model, LOD) is merged at load into ≤ 3 geometries: `body` (the
 * largest-area opaque GLB material, kept with its maps, paint forced to
 * metalness ≥ 0.4 / roughness ≤ 0.45), `rest` (every other opaque material
 * baked to vertex colours: base colour × its texture sampled at the vertex
 * UV) and `glass` (transparent / transmissive materials → one tinted glass).
 * Per frame the fleet's instance matrices are copied (y lowered to the
 * ground) into one shared instance buffer per (model, LOD) — no allocation,
 * hidden cars cost one distance test.
 */
import * as THREE from 'three/webgpu';
import { float, uv, vec3 } from 'three/tsl';
import { GLTFLoader, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import type { PunkLayer, PunkLayerContext } from './layer';
import {
  FLEET_YAW,
  LOD_HIDDEN,
  lightAnchors,
  lodFor,
  normalisePoint,
  normaliseTransform,
  parseManifest,
  pickModel,
  type Box3Like,
  type CarModelEntry,
} from './vehiclemath';

/** Largest texture edge sampled when baking `rest` vertex colours. */
const SAMPLE_EDGE = 64;
/** Headlight quad (w × h, m), warm white, emissive 6. */
const HEAD_W = 0.26;
const HEAD_H = 0.12;
/** Taillight quad (w × h, m), red, emissive 4. */
const TAIL_W = 0.3;
const TAIL_H = 0.1;
/** Light quads sit this far outside the bbox end (no z-fighting with the body). */
const LIGHT_OUT = 0.02;
/** Road beam ahead of lod0 cars: length × width (m), height above the ground, opacity. */
const BEAM_LEN = 4;
const BEAM_W = 1.6;
const BEAM_Y = 0.04;
const BEAM_OPACITY = 0.15;

type Kind = 'body' | 'rest' | 'glass';

/** One merged geometry of a (model, LOD) with its material. */
interface Part {
  kind: Kind;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  tris: number;
}

/** A loaded, normalised (model, LOD) in fleet space (travel along −z, origin bottom-centre). */
interface Prepared {
  parts: Part[];
  box: Box3Like;
  tris: number;
}

/** A fully loaded model. */
interface Asset {
  entry: CarModelEntry;
  lods: [Prepared, Prepared];
  /** Head L, head R, tail L, tail R anchors (xyz × 4), fleet space, pushed out of the bbox. */
  anchors: Float32Array;
  /** Fleet-space z of the front bumper (min z). */
  frontZ: number;
}

/** Per-activation instancing for one (model, LOD). */
interface Bucket {
  attr: THREE.InstancedBufferAttribute;
  meshes: THREE.InstancedMesh[];
  tris: number;
}

/**
 * GLTFLoader plugin for the legacy `KHR_materials_pbrSpecularGlossiness`
 * (the Century uses it; three dropped support): diffuse → base colour/map,
 * glossiness → roughness, metalness 0. Keeps the loader from warning.
 */
function specGlossPlugin(parser: GLTFParser): {
  name: string;
  extendMaterialParams: (i: number, p: Record<string, unknown>) => Promise<unknown> | null;
} {
  const name = 'KHR_materials_pbrSpecularGlossiness';
  return {
    name,
    extendMaterialParams(i: number, p: Record<string, unknown>): Promise<unknown> | null {
      const json = parser.json as { materials?: { extensions?: Record<string, unknown> }[] };
      const ext = json.materials?.[i]?.extensions?.[name] as
        | { diffuseFactor?: number[]; diffuseTexture?: { index: number }; glossinessFactor?: number }
        | undefined;
      if (!ext) return null;
      const d = ext.diffuseFactor;
      if (Array.isArray(d) && d.length >= 3) {
        p.color = new THREE.Color().setRGB(d[0], d[1], d[2], THREE.LinearSRGBColorSpace);
        p.opacity = d.length > 3 ? d[3] : 1;
      }
      p.metalness = 0;
      p.roughness = Math.max(0.05, 1 - (ext.glossinessFactor ?? 1));
      return ext.diffuseTexture
        ? parser.assignTexture(p, 'map', ext.diffuseTexture, THREE.SRGBColorSpace)
        : Promise.resolve();
    },
  };
}

/** Downsampled RGBA pixels of a texture image (null when it cannot be read). */
interface Pixels {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

function readPixels(tex: THREE.Texture): Pixels | null {
  const img = tex.image as { width?: number; height?: number } | null;
  if (!img || !img.width || !img.height) return null;
  const w = Math.max(1, Math.min(SAMPLE_EDGE, img.width));
  const h = Math.max(1, Math.min(SAMPLE_EDGE, img.height));
  try {
    const canvas = new OffscreenCanvas(w, h);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    if (!c) return null;
    c.drawImage(img as CanvasImageSource, 0, 0, w, h);
    return { w, h, data: c.getImageData(0, 0, w, h).data };
  } catch {
    return null;
  }
}

function isGlass(m: THREE.Material): boolean {
  const t = (m as { transmission?: number }).transmission ?? 0;
  return t > 0 || (m.transparent && m.opacity < 0.9);
}

/** Growable float/int arrays for one merged part. */
class Acc {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
}

/**
 * Normalise and merge one loaded GLB into fleet-space parts (see the file
 * header). `body` is chosen by triangle area among opaque materials.
 */
function prepare(root: THREE.Object3D, entry: CarModelEntry, glass: THREE.Material, rest: THREE.Material): Prepared {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) meshes.push(o);
  });
  if (meshes.length === 0) throw new Error('no triangle meshes');
  const raw = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) raw.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
  }
  const yaw = entry.yaw + FLEET_YAW;
  const t = normaliseTransform({ min: raw.min.toArray(), max: raw.max.toArray() }, yaw, entry.length);
  const norm = new THREE.Matrix4()
    .makeTranslation(t.offset[0], t.offset[1], t.offset[2])
    .multiply(new THREE.Matrix4().makeScale(t.scale, t.scale, t.scale))
    .multiply(new THREE.Matrix4().makeRotationY(yaw));

  // Pick the body: largest transformed triangle area among opaque materials.
  const area = new Map<THREE.Material, number>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const mw = new THREE.Matrix4();
  for (const m of meshes) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!mat || isGlass(mat)) continue;
    mw.multiplyMatrices(norm, m.matrixWorld);
    const p = m.geometry.getAttribute('position');
    const ix = m.geometry.getIndex();
    const n = ix ? ix.count : p.count;
    let s = 0;
    for (let k = 0; k + 2 < n; k += 3) {
      const i0 = ix ? ix.getX(k) : k;
      const i1 = ix ? ix.getX(k + 1) : k + 1;
      const i2 = ix ? ix.getX(k + 2) : k + 2;
      a.fromBufferAttribute(p, i0).applyMatrix4(mw);
      b.fromBufferAttribute(p, i1).applyMatrix4(mw);
      c.fromBufferAttribute(p, i2).applyMatrix4(mw);
      s += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    area.set(mat, (area.get(mat) ?? 0) + s);
  }
  let bodySrc: THREE.Material | null = null;
  let best = -1;
  for (const [mat, s] of area) {
    if (s > best) {
      best = s;
      bodySrc = mat;
    }
  }
  const bodyMat = bodySrc ? makeBody(bodySrc) : null;
  const bodyUv = !!bodyMat && hasMaps(bodyMat);

  const acc: Record<Kind, Acc> = { body: new Acc(), rest: new Acc(), glass: new Acc() };
  const pixels = new Map<THREE.Texture, Pixels | null>();
  const nm = new THREE.Matrix3();
  const uv2 = new THREE.Vector2();
  const col = new THREE.Color();
  const tc = new THREE.Color();
  for (const m of meshes) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!mat) continue;
    const kind: Kind = isGlass(mat) ? 'glass' : mat === bodySrc ? 'body' : 'rest';
    const out = acc[kind];
    const g = m.geometry;
    const hadNormals = g.hasAttribute('normal');
    mw.multiplyMatrices(norm, m.matrixWorld);
    nm.getNormalMatrix(mw);
    const p = g.getAttribute('position');
    const nAttr = hadNormals ? g.getAttribute('normal') : null;
    const uvAttr = g.hasAttribute('uv') ? g.getAttribute('uv') : null;
    const cAttr = g.hasAttribute('color') ? g.getAttribute('color') : null;
    const base = out.pos.length / 3;

    // Local copy so missing normals can be computed on the transformed piece.
    const lp = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mw);
      lp[i * 3] = v.x;
      lp[i * 3 + 1] = v.y;
      lp[i * 3 + 2] = v.z;
    }
    const ix = g.getIndex();
    const idx: number[] = [];
    const n = ix ? ix.count : p.count;
    const flip = mw.determinant() < 0;
    for (let k = 0; k + 2 < n; k += 3) {
      const i0 = ix ? ix.getX(k) : k;
      const i1 = ix ? ix.getX(k + 1) : k + 1;
      const i2 = ix ? ix.getX(k + 2) : k + 2;
      if (flip) idx.push(i0, i2, i1);
      else idx.push(i0, i1, i2);
    }
    let ln: Float32Array;
    if (nAttr) {
      ln = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(nAttr, i).applyMatrix3(nm).normalize();
        ln[i * 3] = v.x;
        ln[i * 3 + 1] = v.y;
        ln[i * 3 + 2] = v.z;
      }
    } else {
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', new THREE.BufferAttribute(lp, 3));
      tmp.setIndex(idx);
      tmp.computeVertexNormals();
      ln = tmp.getAttribute('normal').array as Float32Array;
      tmp.dispose();
    }
    for (let i = 0; i < lp.length; i++) out.pos.push(lp[i]);
    for (let i = 0; i < ln.length; i++) out.nrm.push(ln[i]);
    for (const i of idx) out.idx.push(base + i);

    if (kind === 'body' && bodyUv) {
      for (let i = 0; i < p.count; i++) out.uv.push(uvAttr ? uvAttr.getX(i) : 0, uvAttr ? uvAttr.getY(i) : 0);
    } else if (kind === 'rest') {
      const std = mat as THREE.MeshStandardMaterial;
      const baseCol = std.color instanceof THREE.Color ? std.color : col.setRGB(1, 1, 1);
      const map = std.map ?? null;
      let px: Pixels | null = null;
      if (map && uvAttr) {
        if (!pixels.has(map)) pixels.set(map, readPixels(map));
        px = pixels.get(map) ?? null;
        map.updateMatrix();
      }
      for (let i = 0; i < p.count; i++) {
        let r = baseCol.r;
        let gg = baseCol.g;
        let bb = baseCol.b;
        if (px && map && uvAttr) {
          uv2.set(uvAttr.getX(i), uvAttr.getY(i));
          map.transformUv(uv2);
          const x = Math.min(px.w - 1, Math.max(0, Math.floor(uv2.x * px.w)));
          const y = Math.min(px.h - 1, Math.max(0, Math.floor(uv2.y * px.h)));
          const o = (y * px.w + x) * 4;
          tc.setRGB(px.data[o] / 255, px.data[o + 1] / 255, px.data[o + 2] / 255, THREE.SRGBColorSpace);
          r *= tc.r;
          gg *= tc.g;
          bb *= tc.b;
        }
        if (cAttr && std.vertexColors) {
          r *= cAttr.getX(i);
          gg *= cAttr.getY(i);
          bb *= cAttr.getZ(i);
        }
        out.col.push(r, gg, bb);
      }
    }
  }

  const parts: Part[] = [];
  let tris = 0;
  for (const kind of ['body', 'rest', 'glass'] as const) {
    const o = acc[kind];
    if (o.idx.length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.nrm, 3));
    if (o.uv.length > 0) geo.setAttribute('uv', new THREE.Float32BufferAttribute(o.uv, 2));
    if (o.col.length > 0) geo.setAttribute('color', new THREE.Float32BufferAttribute(o.col, 3));
    geo.setIndex(o.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(o.idx, 1) : new THREE.Uint16BufferAttribute(o.idx, 1));
    geo.computeBoundingSphere();
    const material = kind === 'body' ? (bodyMat as THREE.Material) : kind === 'rest' ? rest : glass;
    const n = o.idx.length / 3;
    parts.push({ kind, geometry: geo, material, tris: n });
    tris += n;
  }
  if (bodyMat && !parts.some((q) => q.kind === 'body')) bodyMat.dispose();

  const box = new THREE.Box3();
  for (const q of parts) {
    q.geometry.computeBoundingBox();
    if (q.geometry.boundingBox) box.union(q.geometry.boundingBox);
  }
  // Source materials are not used any more (the body is a clone; textures it
  // references stay alive through the clone).
  for (const m of meshes) {
    m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) mat.dispose();
  }
  return { parts, box: { min: box.min.toArray(), max: box.max.toArray() }, tris };
}

function hasMaps(m: THREE.Material): boolean {
  const s = m as THREE.MeshStandardMaterial;
  return !!(s.map || s.normalMap || s.roughnessMap || s.metalnessMap || s.emissiveMap || s.alphaMap || s.bumpMap);
}

/** Clone the body material and force the paint sheen (§4.11 "Paint"). */
function makeBody(src: THREE.Material): THREE.Material {
  const m = src.clone();
  if (m instanceof THREE.MeshStandardMaterial) {
    m.metalness = Math.max(m.metalness, 0.4);
    m.roughness = Math.min(m.roughness, 0.45);
    // Only uv (channel 0) survives the merge.
    m.aoMap = null;
    m.lightMap = null;
    m.vertexColors = false;
  }
  m.side = THREE.DoubleSide;
  return m;
}

/** The `vehicles` layer implementation. */
export class VehiclesLayer implements PunkLayer {
  readonly id = 'vehicles';

  private root: THREE.Group | null = null;
  private loading: Promise<void> | null = null;
  private loadingNow = false;
  private assets: (Asset | null)[] = [];
  private ready = false;

  private readonly glassMat: THREE.MeshStandardMaterial;
  private readonly restMat: THREE.MeshStandardMaterial;
  private headMat: THREE.MeshStandardNodeMaterial | null = null;
  private tailMat: THREE.MeshStandardNodeMaterial | null = null;
  private beamMat: THREE.MeshBasicNodeMaterial | null = null;
  private readonly headGeo: THREE.BufferGeometry;
  private readonly tailGeo: THREE.BufferGeometry;
  private readonly beamGeo: THREE.BufferGeometry;

  /** Instancing built for `cap` cars (per activation / fleet size). */
  private buckets: (Bucket | null)[] = [];
  private head: THREE.InstancedMesh | null = null;
  private tail: THREE.InstancedMesh | null = null;
  private beam: THREE.InstancedMesh | null = null;
  private cap = 0;
  private counts = new Int32Array(0);
  private pick = new Int16Array(0);
  private pickFor: THREE.InstancedMesh | null = null;

  /** Fleet mesh whose boxes we hid, and the material visibility to restore. */
  private hidden: { mesh: THREE.InstancedMesh; vis: boolean[] } | null = null;

  private nLod0 = 0;
  private nLod1 = 0;
  private nHidden = 0;
  private triangles = 0;
  /** Load wall time and summed synchronous `prepare` time (ms), for the stats. */
  private loadMs = 0;
  private prepMs = 0;

  /** Create the `vehicles` layer (models load on first attach). */
  constructor() {
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0a0e16,
      metalness: 0.2,
      roughness: 0.05,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    glass.name = 'punk:vehicles:glass';
    this.glassMat = glass;
    const rest = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.6, side: THREE.DoubleSide });
    rest.name = 'punk:vehicles:rest';
    this.restMat = rest;
    this.headGeo = new THREE.PlaneGeometry(HEAD_W, HEAD_H).rotateY(Math.PI); // faces −z (forward)
    this.tailGeo = new THREE.PlaneGeometry(TAIL_W, TAIL_H); // faces +z (backward)
    // Flat on the road, reaching from the bumper (uv.y 0) to BEAM_LEN ahead (−z, uv.y 1).
    this.beamGeo = new THREE.PlaneGeometry(BEAM_W, BEAM_LEN).rotateX(-Math.PI / 2).translate(0, 0, -BEAM_LEN / 2);
  }

  /** Create the light materials and start loading the models (first time only). */
  attach(_ctx: PunkLayerContext, root: THREE.Group): void {
    this.root = root;
    if (!this.headMat) {
      const head = new THREE.MeshStandardNodeMaterial();
      head.colorNode = vec3(0, 0, 0);
      head.emissiveNode = vec3(1.0, 0.9, 0.75).mul(6);
      head.roughness = 1;
      head.metalness = 0;
      head.side = THREE.DoubleSide;
      head.fog = true;
      this.headMat = head;
      const tail = new THREE.MeshStandardNodeMaterial();
      tail.colorNode = vec3(0, 0, 0);
      tail.emissiveNode = vec3(1.0, 0.04, 0.03).mul(4);
      tail.roughness = 1;
      tail.metalness = 0;
      tail.side = THREE.DoubleSide;
      tail.fog = true;
      this.tailMat = tail;
      const beam = new THREE.MeshBasicNodeMaterial();
      beam.transparent = true;
      beam.depthWrite = false;
      beam.blending = THREE.AdditiveBlending;
      beam.colorNode = vec3(1.0, 0.9, 0.75);
      beam.opacityNode = float(BEAM_OPACITY).mul(float(1).sub(uv().y));
      beam.fog = true;
      this.beamMat = beam;
    }
    if (!this.loading) this.loading = this.load();
  }

  /** Copy the fleet's matrices into the per-(model, LOD) instance buffers and place the lights. */
  update(ctx: PunkLayerContext, _timeS: number, _dtS: number): void {
    const root = this.root;
    if (!root) return;
    const fleet = this.ready ? ctx.traffic() : null;
    if (!fleet || fleet.count === 0) {
      this.restoreFleet();
      this.hideAll();
      return;
    }
    if (this.hidden?.mesh !== fleet) {
      this.restoreFleet();
      this.hideFleet(fleet);
    }
    if (fleet.count > this.cap) this.build(fleet.count, root);
    if (this.pickFor !== fleet) {
      const weights = this.assets.map((a) => (a ? a.entry.weight : 0));
      for (let i = 0; i < fleet.count; i++) this.pick[i] = pickModel(i, weights);
      this.pickFor = fleet;
    }
    const halfH = fleetHalfHeight(fleet);
    const src = fleet.instanceMatrix.array as Float32Array;
    const cam = ctx.camera.matrixWorld.elements;
    const cx = cam[12];
    const cy = cam[13];
    const cz = cam[14];
    const counts = this.counts;
    counts.fill(0);
    const head = this.head as THREE.InstancedMesh;
    const tail = this.tail as THREE.InstancedMesh;
    const beam = this.beam as THREE.InstancedMesh;
    const hd = head.instanceMatrix.array as Float32Array;
    const td = tail.instanceMatrix.array as Float32Array;
    const bd = beam.instanceMatrix.array as Float32Array;
    let nh = 0;
    let nt = 0;
    let nb = 0;
    let l0 = 0;
    let l1 = 0;
    let hid = 0;
    let tris = 0;
    for (let i = 0; i < fleet.count; i++) {
      const o = i * 16;
      const tx = src[o + 12];
      const ty = src[o + 13] - halfH;
      const tz = src[o + 14];
      const dx = tx - cx;
      const dy = ty - cy;
      const dz = tz - cz;
      const lod = lodFor(Math.sqrt(dx * dx + dy * dy + dz * dz));
      const m = this.pick[i];
      const asset = m >= 0 ? this.assets[m] : null;
      if (lod === LOD_HIDDEN || !asset) {
        hid++;
        continue;
      }
      const bi = m * 2 + lod;
      const bucket = this.buckets[bi];
      if (!bucket) {
        hid++;
        continue;
      }
      const k = counts[bi]++;
      const dst = bucket.attr.array as Float32Array;
      const d = k * 16;
      for (let j = 0; j < 16; j++) dst[d + j] = src[o + j];
      dst[d + 13] = ty;
      tris += bucket.tris;
      if (lod === 0) l0++;
      else l1++;

      // Lights: world = R · anchor + t (the fleet matrix has no scale).
      const an = asset.anchors;
      for (let q = 0; q < 4; q++) {
        const ax = an[q * 3];
        const ay = an[q * 3 + 1];
        const az = an[q * 3 + 2];
        const out = q < 2 ? hd : td;
        const w = (q < 2 ? nh++ : nt++) * 16;
        for (let j = 0; j < 12; j++) out[w + j] = src[o + j];
        out[w + 12] = src[o] * ax + src[o + 4] * ay + src[o + 8] * az + tx;
        out[w + 13] = src[o + 1] * ax + src[o + 5] * ay + src[o + 9] * az + ty;
        out[w + 14] = src[o + 2] * ax + src[o + 6] * ay + src[o + 10] * az + tz;
        out[w + 15] = 1;
      }
      if (lod === 0) {
        const w = nb++ * 16;
        const az = asset.frontZ;
        for (let j = 0; j < 12; j++) bd[w + j] = src[o + j];
        bd[w + 12] = src[o + 4] * BEAM_Y + src[o + 8] * az + tx;
        bd[w + 13] = src[o + 5] * BEAM_Y + src[o + 9] * az + ty;
        bd[w + 14] = src[o + 6] * BEAM_Y + src[o + 10] * az + tz;
        bd[w + 15] = 1;
      }
    }
    for (let bi = 0; bi < this.buckets.length; bi++) {
      const bucket = this.buckets[bi];
      if (!bucket) continue;
      const n = counts[bi];
      for (const mesh of bucket.meshes) {
        mesh.count = n;
        mesh.visible = n > 0;
      }
      if (n > 0) markUpdated(bucket.attr, n * 16);
    }
    setInstances(head, nh);
    setInstances(tail, nt);
    setInstances(beam, nb);
    this.nLod0 = l0;
    this.nLod1 = l1;
    this.nHidden = hid;
    this.triangles = tris + (nh + nt + nb) * 2;
  }

  /** Give the fleet its boxes back; the instanced meshes stay in the (detached) root for reuse. */
  detach(_ctx: PunkLayerContext): void {
    this.restoreFleet();
    this.hideAll();
    this.root = null;
  }

  /** Free every geometry, material and instance buffer. */
  dispose(): void {
    this.restoreFleet();
    this.freeInstancing();
    for (const a of this.assets) {
      if (!a) continue;
      for (const p of a.lods) {
        for (const part of p.parts) {
          part.geometry.dispose();
          if (part.kind === 'body') disposeMaterial(part.material);
        }
      }
    }
    this.assets = [];
    this.ready = false;
    this.glassMat.dispose();
    this.restMat.dispose();
    this.headMat?.dispose();
    this.tailMat?.dispose();
    this.beamMat?.dispose();
    this.headMat = this.tailMat = this.beamMat = null;
    this.headGeo.dispose();
    this.tailGeo.dispose();
    this.beamGeo.dispose();
  }

  /** Flat debug stats: LOD counts, drawn triangles, models loaded, draws. */
  stats(): Record<string, number> {
    let draws = 0;
    this.root?.traverse((o) => {
      if (o instanceof THREE.Mesh && o.visible) draws++;
    });
    return {
      lod0: this.nLod0,
      lod1: this.nLod1,
      hidden: this.nHidden,
      triangles: this.triangles,
      models: this.assets.filter((a) => a !== null).length,
      loading: this.loadingNow ? 1 : 0,
      ready: this.ready ? 1 : 0,
      loadMs: Math.round(this.loadMs),
      prepMs: Math.round(this.prepMs),
      draws: this.root ? draws : 0,
    };
  }

  /** Fetch the manifest and every GLB; a model that fails to load is left out (warned). */
  private async load(): Promise<void> {
    this.loadingNow = true;
    const t0 = performance.now();
    const base = `${import.meta.env.BASE_URL}models/cars/`;
    try {
      const res = await fetch(`${base}manifest.json`);
      if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
      const manifest = parseManifest((await res.json()) as unknown);
      const loader = new GLTFLoader();
      loader.register((parser) => specGlossPlugin(parser));
      const assets = await Promise.all(
        manifest.models.map(async (entry): Promise<Asset | null> => {
          try {
            const [g0, g1] = await Promise.all([
              loader.loadAsync(base + entry.lod0),
              loader.loadAsync(base + entry.lod1),
            ]);
            const t0 = performance.now();
            const p0 = prepare(g0.scene, entry, this.glassMat, this.restMat);
            const p1 = prepare(g1.scene, entry, this.glassMat, this.restMat);
            this.prepMs += performance.now() - t0;
            return makeAsset(entry, p0, p1);
          } catch (e) {
            console.warn(`[punk:vehicles] ${entry.id}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          }
        }),
      );
      this.assets = assets;
      this.ready = assets.some((a) => a !== null);
    } catch (e) {
      console.warn(`[punk:vehicles] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.loadMs = performance.now() - t0;
      this.loadingNow = false;
    }
  }

  /** (Re)create the instanced meshes for a fleet of `cap` cars under `root`. */
  private build(cap: number, root: THREE.Group): void {
    this.freeInstancing();
    this.cap = cap;
    this.counts = new Int32Array(this.assets.length * 2);
    this.pick = new Int16Array(cap);
    this.pickFor = null;
    this.buckets = [];
    for (let m = 0; m < this.assets.length; m++) {
      const a = this.assets[m];
      for (let lod = 0; lod < 2; lod++) {
        if (!a) {
          this.buckets.push(null);
          continue;
        }
        const p = a.lods[lod];
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
        attr.setUsage(THREE.DynamicDrawUsage);
        const meshes = p.parts.map((part) => {
          const mesh = new THREE.InstancedMesh(part.geometry, part.material, cap);
          mesh.instanceMatrix = attr;
          mesh.count = 0;
          mesh.visible = false;
          mesh.frustumCulled = false;
          mesh.name = `punk:vehicles:${a.entry.id}:lod${lod}:${part.kind}`;
          root.add(mesh);
          return mesh;
        });
        this.buckets.push({ attr, meshes, tris: p.tris });
      }
    }
    this.head = lightMesh(this.headGeo, this.headMat as THREE.Material, cap * 2, 'head', root);
    this.tail = lightMesh(this.tailGeo, this.tailMat as THREE.Material, cap * 2, 'tail', root);
    this.beam = lightMesh(this.beamGeo, this.beamMat as THREE.Material, cap, 'beam', root);
  }

  private freeInstancing(): void {
    for (const b of this.buckets) {
      if (!b) continue;
      for (const m of b.meshes) {
        m.removeFromParent();
        m.dispose();
      }
    }
    for (const m of [this.head, this.tail, this.beam]) {
      if (!m) continue;
      m.removeFromParent();
      m.dispose();
    }
    this.buckets = [];
    this.head = this.tail = this.beam = null;
    this.cap = 0;
    this.pickFor = null;
  }

  private hideAll(): void {
    for (const b of this.buckets) if (b) for (const m of b.meshes) m.visible = false;
    for (const m of [this.head, this.tail, this.beam]) if (m) m.visible = false;
    this.nLod0 = this.nLod1 = this.triangles = 0;
    this.nHidden = 0;
  }

  /**
   * Hide the fleet's boxes by switching their material(s) invisible. Not
   * `mesh.visible`: main.ts only advances the fleet while its object is
   * visible, and we need the matrices to keep moving.
   */
  private hideFleet(fleet: THREE.InstancedMesh): void {
    const mats = Array.isArray(fleet.material) ? fleet.material : [fleet.material];
    this.hidden = { mesh: fleet, vis: mats.map((m) => m.visible) };
    for (const m of mats) m.visible = false;
  }

  private restoreFleet(): void {
    const h = this.hidden;
    if (!h) return;
    const mats = Array.isArray(h.mesh.material) ? h.mesh.material : [h.mesh.material];
    mats.forEach((m, i) => {
      m.visible = h.vis[i] ?? true;
    });
    this.hidden = null;
  }
}

/** Build the `Asset` (anchors from the lod0 box, or the manifest's own lights). */
function makeAsset(entry: CarModelEntry, p0: Prepared, p1: Prepared): Asset {
  const box = p0.box;
  // Manifest lights are in model space with the front at +z; the fleet frame
  // is that rotated by FLEET_YAW (π): x → −x, z → −z.
  const src = entry.lights
    ? {
        front: entry.lights.front.map((p) => normalisePoint(p, FLEET_YAW, { scale: 1, offset: [0, 0, 0] })),
        rear: entry.lights.rear.map((p) => normalisePoint(p, FLEET_YAW, { scale: 1, offset: [0, 0, 0] })),
      }
    : lightAnchors(box, -1);
  const anchors = new Float32Array(12);
  const pts = [src.front[0], src.front[1] ?? src.front[0], src.rear[0], src.rear[1] ?? src.rear[0]];
  pts.forEach((p, q) => {
    anchors[q * 3] = p[0];
    anchors[q * 3 + 1] = p[1];
    anchors[q * 3 + 2] = p[2] + (q < 2 ? -LIGHT_OUT : LIGHT_OUT);
  });
  return { entry, lods: [p0, p1], anchors, frontZ: box.min[2] };
}

function lightMesh(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string, root: THREE.Group): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.name = `punk:vehicles:${name}`;
  root.add(mesh);
  return mesh;
}

function markUpdated(attr: THREE.InstancedBufferAttribute, floats: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, floats);
  attr.needsUpdate = true;
}

function setInstances(mesh: THREE.InstancedMesh, n: number): void {
  mesh.count = n;
  mesh.visible = n > 0;
  if (n > 0) markUpdated(mesh.instanceMatrix, n * 16);
}

/** Half the fleet box height: its instances are centred, our models sit on the ground. */
function fleetHalfHeight(fleet: THREE.InstancedMesh): number {
  const g = fleet.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox ? -g.boundingBox.min.y : 0;
}

function disposeMaterial(m: THREE.Material): void {
  const s = m as THREE.MeshStandardMaterial;
  for (const t of [s.map, s.normalMap, s.roughnessMap, s.metalnessMap, s.emissiveMap, s.alphaMap, s.bumpMap]) t?.dispose();
  m.dispose();
}

/** Create the `vehicles` layer. */
export function createVehiclesLayer(): PunkLayer {
  return new VehiclesLayer();
}
