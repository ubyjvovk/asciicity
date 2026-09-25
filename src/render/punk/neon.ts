/**
 * Cyberpunk layer `neon` (wave 20b): street-facing blade and panel signs,
 * glyph atlas, tube glow, flicker, coloured spill. Experimental (`N` toggles).
 * Contract: `layer.ts` and docs/architecture.md §4.11 "Neon signs".
 */
import * as THREE from 'three/webgpu';
import { attribute, float, floor, hash, select, texture, uniform, vec3 } from 'three/tsl';
import { CellStreamer, type CellData } from './cells';
import type { PunkLayer, PunkLayerContext } from './layer';
import { disposeNeonAtlas, getSlotUv, neonAtlasKey, neonAtlasSlotCount, neonAtlasTexture } from './neonatlas';
import { placeSigns, type Sign } from './neonplace';

type V3 = [number, number, number];

const LIGHTS = 4;
const LIGHT_INTENSITY = 6;
const LIGHT_DISTANCE = 14;
const ASSIGN_EVERY = 0.25;
const FADE_S = 0.3;
const VISIBLE_REACH = 150;
const FRAME_T = 0.08;
const FRAME_D = 0.08;

function add3(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub3(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function mul3(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function dot3(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len3(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Merged triangle soup. Winding is flipped so each quad faces `n`. */
class Soup {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly flick: number[] = [];
  readonly idx: number[] = [];

  quad(c0: V3, c1: V3, c2: V3, c3: V3, u0: number, v0: number, u1: number, v1: number, n: V3, flick: number): void {
    const b = this.pos.length / 3;
    const corners = [c0, c1, c2, c3];
    const uvs: [number, number][] = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
    for (let i = 0; i < 4; i++) {
      const p = corners[i]!;
      const uv = uvs[i]!;
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.uv.push(uv[0], uv[1]);
      this.flick.push(flick);
    }
    const flip = dot3(cross3(sub3(c1, c0), sub3(c3, c0)), n) < 0;
    if (!flip) this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    else this.idx.push(b, b + 3, b + 2, b, b + 2, b + 1);
  }

  geometry(faces: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (faces) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('flicker', new THREE.Float32BufferAttribute(this.flick, 1));
    }
    g.setIndex(this.idx);
    return g;
  }
}

function box(buf: Soup, center: V3, xu: V3, yu: V3, zu: V3, hx: number, hy: number, hz: number): void {
  const ax = mul3(xu, hx);
  const ay = mul3(yu, hy);
  const az = mul3(zu, hz);
  const c = (sx: number, sy: number, sz: number): V3 => add3(center, add3(mul3(ax, sx), add3(mul3(ay, sy), mul3(az, sz))));
  const q = (a: V3, b: V3, c2: V3, d: V3, n: V3): void => buf.quad(a, b, c2, d, 0, 0, 1, 1, n, 0);
  q(c(1, -1, -1), c(1, -1, 1), c(1, 1, 1), c(1, 1, -1), xu);
  q(c(-1, -1, 1), c(-1, -1, -1), c(-1, 1, -1), c(-1, 1, 1), mul3(xu, -1));
  q(c(-1, 1, -1), c(1, 1, -1), c(1, 1, 1), c(-1, 1, 1), yu);
  q(c(-1, -1, 1), c(1, -1, 1), c(1, -1, -1), c(-1, -1, -1), mul3(yu, -1));
  q(c(-1, -1, 1), c(-1, 1, 1), c(1, 1, 1), c(1, -1, 1), zu);
  q(c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1), c(-1, -1, -1), mul3(zu, -1));
}

function frameAround(buf: Soup, center: V3, axisW: V3, axisH: V3, axisN: V3, width: number, height: number): void {
  const hw = width / 2;
  const hh = height / 2;
  const t = FRAME_T;
  box(buf, add3(center, mul3(axisH, -(hh + t / 2))), axisW, axisH, axisN, hw + t, t / 2, FRAME_D / 2);
  box(buf, add3(center, mul3(axisH, hh + t / 2)), axisW, axisH, axisN, hw + t, t / 2, FRAME_D / 2);
  box(buf, add3(center, mul3(axisW, -(hw + t / 2))), axisW, axisH, axisN, t / 2, hh, FRAME_D / 2);
  box(buf, add3(center, mul3(axisW, hw + t / 2)), axisW, axisH, axisN, t / 2, hh, FRAME_D / 2);
}

function bracket(buf: Soup, from: V3, to: V3): void {
  const span = sub3(to, from);
  const L = len3(span);
  if (L < 1e-3) return;
  const dir = mul3(span, 1 / L);
  let side = cross3(dir, [0, 1, 0]);
  const sl = len3(side);
  side = sl < 1e-4 ? [1, 0, 0] : mul3(side, 1 / sl);
  const lift = cross3(side, dir);
  box(buf, mul3(add3(from, to), 0.5), dir, lift, side, L / 2, 0.04, 0.04);
}

/** Per-sign phase in (0, 1]; 0 means the sign stays on. */
function flickerSeed(sign: Sign): number {
  if (!sign.flicker) return 0;
  let h = (sign.buildingId ^ Math.imul(Math.round(sign.x * 10), 0x45d9f3b)) >>> 0;
  h = Math.imul(h ^ Math.round(sign.z * 10), 0x27d4eb2d) >>> 0;
  return 0.15 + ((h >>> 0) / 4294967296) * 0.85;
}

/**
 * Face quads in world space. Blade faces lie in the normal/up plane (text
 * readable from both street directions); the back face mirrors U. Panels
 * sit on the wall plane, one face, outward.
 */
function addFaces(buf: Soup, sign: Sign, u0: number, v0: number, u1: number, v1: number): void {
  const flick = flickerSeed(sign);
  const C: V3 = [sign.x, sign.y, sign.z];
  const Y: V3 = [0, 1, 0];
  const N: V3 = [sign.nx, 0, sign.nz];
  const T: V3 = [-sign.nz, 0, sign.nx];
  const hw = sign.width / 2;
  const hh = sign.height / 2;
  if (sign.kind === 'panel') {
    const O = add3(C, mul3(N, 0.015));
    buf.quad(
      add3(O, add3(mul3(T, hw), mul3(Y, -hh))),
      add3(O, add3(mul3(T, -hw), mul3(Y, -hh))),
      add3(O, add3(mul3(T, -hw), mul3(Y, hh))),
      add3(O, add3(mul3(T, hw), mul3(Y, hh))),
      u0,
      v0,
      u1,
      v1,
      N,
      flick,
    );
    return;
  }
  const gap = 0.05;
  const front = add3(C, mul3(T, gap));
  buf.quad(
    add3(front, add3(mul3(N, -hw), mul3(Y, -hh))),
    add3(front, add3(mul3(N, hw), mul3(Y, -hh))),
    add3(front, add3(mul3(N, hw), mul3(Y, hh))),
    add3(front, add3(mul3(N, -hw), mul3(Y, hh))),
    u0,
    v0,
    u1,
    v1,
    T,
    flick,
  );
  const back = add3(C, mul3(T, -gap));
  buf.quad(
    add3(back, add3(mul3(N, hw), mul3(Y, -hh))),
    add3(back, add3(mul3(N, -hw), mul3(Y, -hh))),
    add3(back, add3(mul3(N, -hw), mul3(Y, hh))),
    add3(back, add3(mul3(N, hw), mul3(Y, hh))),
    u0,
    v0,
    u1,
    v1,
    mul3(T, -1),
    flick,
  );
}

function addFrame(buf: Soup, sign: Sign): void {
  const C: V3 = [sign.x, sign.y, sign.z];
  const Y: V3 = [0, 1, 0];
  const N: V3 = [sign.nx, 0, sign.nz];
  const T: V3 = [-sign.nz, 0, sign.nx];
  if (sign.kind === 'panel') {
    frameAround(buf, C, T, Y, N, sign.width, sign.height);
    return;
  }
  frameAround(buf, C, N, Y, T, sign.width, sign.height);
  const along = sub3(C, mul3(N, 0.6));
  for (const f of [-0.32, 0.32]) {
    const y = sign.y + sign.height * f;
    bracket(buf, [along[0], y, along[2]], [sign.x, y, sign.z]);
  }
}

function signId(s: Sign | null): string {
  if (!s) return '';
  return `${s.buildingId}:${s.kind}:${s.x.toFixed(2)}:${s.z.toFixed(2)}`;
}

interface Slot {
  light: THREE.PointLight;
  sign: Sign | null;
  queued: Sign | null;
  fading: boolean;
}

/** Create the `neon` layer (experimental, on by default). */
export function createNeonLayer(): PunkLayer {
  let root: THREE.Group | null = null;
  let ctx: PunkLayerContext | null = null;
  let streamer: CellStreamer | null = null;
  let faceMat: THREE.MeshStandardNodeMaterial | null = null;
  let frameMat: THREE.MeshStandardNodeMaterial | null = null;
  let uTime: { value: number } | null = null;
  const slots: Slot[] = [];
  const signsByCell = new Map<string, Sign[]>();
  let signCount = 0;
  let visible = 0;
  let sinceAssign = ASSIGN_EVERY;
  const frustum = new THREE.Frustum();
  const proj = new THREE.Matrix4();
  const tmp = new THREE.Vector3();

  const recount = (): void => {
    let n = 0;
    for (const list of signsByCell.values()) n += list.length;
    signCount = n;
  };

  const ensureMats = (): void => {
    if (faceMat && frameMat && uTime) return;
    const timeU = uniform(0);
    uTime = timeU;
    // three's `attribute()` generic infers the node type from the string arg as `string`.
    const seed = attribute<'float'>('flicker', 'float');
    // Hash of quantized time + per-vertex seed: flickering signs are off ~5 %.
    const h = hash(floor(timeU.mul(6)).mul(1024).add(seed.mul(4096)));
    const on = select(seed.greaterThan(0), h.step(0.05), float(1));
    const face = new THREE.MeshStandardNodeMaterial();
    face.colorNode = vec3(0.02, 0.02, 0.02);
    face.roughnessNode = float(0.45);
    face.metalnessNode = float(0.08);
    face.emissiveNode = texture(neonAtlasTexture()).rgb.mul(4).mul(on);
    const frame = new THREE.MeshStandardNodeMaterial();
    frame.colorNode = vec3(0.012, 0.012, 0.015);
    frame.roughnessNode = float(0.55);
    frame.metalnessNode = float(0.45);
    faceMat = face;
    frameMat = frame;
  };

  const ensureLights = (parent: THREE.Group): void => {
    if (slots.length === 0) {
      for (let i = 0; i < LIGHTS; i++) {
        const light = new THREE.PointLight('#ffffff', 0, LIGHT_DISTANCE, 2);
        slots.push({ light, sign: null, queued: null, fading: false });
      }
    }
    for (const slot of slots) {
      if (slot.light.parent !== parent) parent.add(slot.light);
    }
  };

  const buildCell = (cell: CellData): THREE.Group | null => {
    if (!ctx || !faceMat || !frameMat) return null;
    const signs = placeSigns(cell.buildings, cell.roads, ctx.groundAt, ctx.cityId);
    if (signs.length === 0) return null;
    const faces = new Soup();
    const frames = new Soup();
    for (const sign of signs) {
      const uv = getSlotUv(neonAtlasKey(sign.kind, sign.word, sign.color));
      addFaces(faces, sign, uv.u0, uv.v0, uv.u1, uv.v1);
      addFrame(frames, sign);
    }
    const group = new THREE.Group();
    group.name = cell.key;
    const faceMesh = new THREE.Mesh(faces.geometry(true), faceMat);
    faceMesh.name = 'neon-face';
    const frameMesh = new THREE.Mesh(frames.geometry(false), frameMat);
    frameMesh.name = 'neon-frame';
    group.add(faceMesh, frameMesh);
    signsByCell.set(cell.key, signs);
    recount();
    return group;
  };

  const disposeObj = (obj: THREE.Object3D): void => {
    signsByCell.delete(obj.name);
    recount();
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  };

  const applySign = (slot: Slot, sign: Sign | null): void => {
    slot.sign = sign;
    slot.queued = null;
    slot.fading = false;
    if (!sign) return;
    slot.light.color.set(sign.color);
    slot.light.position.set(sign.x, sign.y, sign.z);
  };

  const retarget = (slot: Slot, want: Sign | null): void => {
    if (slot.fading) {
      if (signId(slot.queued) !== signId(want)) slot.queued = want;
      return;
    }
    if (signId(slot.sign) === signId(want)) return;
    if (!slot.sign || slot.light.intensity <= 0.02) {
      applySign(slot, want);
      return;
    }
    slot.fading = true;
    slot.queued = want;
  };

  const fadeLights = (dt: number): void => {
    const step = (LIGHT_INTENSITY / FADE_S) * dt;
    for (const slot of slots) {
      if (slot.fading) {
        if (slot.sign) slot.light.position.set(slot.sign.x, slot.sign.y, slot.sign.z);
        slot.light.intensity = Math.max(0, slot.light.intensity - step);
        if (slot.light.intensity <= 0.001) applySign(slot, slot.queued);
      } else if (slot.sign) {
        slot.light.position.set(slot.sign.x, slot.sign.y, slot.sign.z);
        slot.light.intensity = Math.min(LIGHT_INTENSITY, slot.light.intensity + step);
      } else {
        slot.light.intensity = 0;
      }
      slot.light.visible = slot.light.intensity > 0.01;
    }
  };

  const visibleSigns = (camera: THREE.PerspectiveCamera): { sign: Sign; dist: number }[] => {
    proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(proj);
    const cam = camera.position;
    const hits: { sign: Sign; dist: number }[] = [];
    for (const list of signsByCell.values()) {
      for (const sign of list) {
        const dist = Math.hypot(sign.x - cam.x, sign.y - cam.y, sign.z - cam.z);
        if (dist > VISIBLE_REACH) continue;
        tmp.set(sign.x, sign.y, sign.z);
        if (!frustum.containsPoint(tmp)) continue;
        hits.push({ sign, dist });
      }
    }
    visible = hits.length;
    return hits;
  };

  return {
    id: 'neon',
    rainPassThrough: true,
    attach(next, group): void {
      ctx = next;
      root = group;
      ensureMats();
      ensureLights(group);
      if (!streamer) {
        streamer = new CellStreamer({
          buildRadius: 400,
          disposeRadius: 550,
          maxBuildsPerFrame: 1,
          build: (cell) => buildCell(cell),
          dispose: (obj) => disposeObj(obj),
        });
      }
    },
    update(next, timeS, dtS): void {
      ctx = next;
      if (!root || !streamer) return;
      if (uTime) uTime.value = timeS;
      streamer.update(next.sources, next.camera.position.x, next.camera.position.z, root);
      const hits = visibleSigns(next.camera);
      sinceAssign += dtS;
      if (sinceAssign >= ASSIGN_EVERY) {
        sinceAssign = 0;
        hits.sort((a, b) => a.dist - b.dist || a.sign.buildingId - b.sign.buildingId || a.sign.x - b.sign.x);
        for (let i = 0; i < LIGHTS; i++) {
          const slot = slots[i];
          if (slot) retarget(slot, hits[i]?.sign ?? null);
        }
      }
      fadeLights(dtS);
    },
    detach(): void {
      if (root && streamer) streamer.clear(root);
      signsByCell.clear();
      signCount = 0;
      visible = 0;
      sinceAssign = ASSIGN_EVERY;
      for (const slot of slots) {
        slot.light.intensity = 0;
        slot.light.visible = false;
        slot.sign = null;
        slot.queued = null;
        slot.fading = false;
        slot.light.removeFromParent();
      }
    },
    dispose(): void {
      if (root && streamer) streamer.clear(root);
      signsByCell.clear();
      signCount = 0;
      visible = 0;
      for (const slot of slots) slot.light.removeFromParent();
      slots.length = 0;
      faceMat?.dispose();
      frameMat?.dispose();
      faceMat = null;
      frameMat = null;
      uTime = null;
      streamer = null;
      root = null;
      ctx = null;
      disposeNeonAtlas();
    },
    stats(): Record<string, number> {
      const s = streamer?.stats() ?? { cells: 0, pending: 0, buildMs: 0 };
      let lit = 0;
      for (const slot of slots) if (slot.light.intensity > 0.02) lit++;
      return {
        signs: signCount,
        visible,
        lights: lit,
        slots: neonAtlasSlotCount(),
        cells: s.cells,
        pending: s.pending,
        buildMs: s.buildMs,
      };
    },
  };
}
