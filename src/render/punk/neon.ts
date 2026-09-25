/**
 * Cyberpunk layer `neon` (wave 20b; v2 dense profiles wave 23b): street-facing
 * blade, panel, stack and screen signs, glyph atlas, tube glow, flicker, fake
 * glow spill cards and coloured point-light spill. Experimental (`N` toggles).
 * Contract: `layer.ts` and docs/architecture.md §4.11 "Neon signs" / "Neon v2".
 */
import * as THREE from 'three/webgpu';
import { attribute, clamp, float, floor, hash, length, select, texture, uniform, uv, vec2, vec3 } from 'three/tsl';
import { CellStreamer, type CellData } from './cells';
import type { PunkLayer, PunkLayerContext } from './layer';
import { disposeNeonAtlas, getSlotUv, neonAtlasSlotCount, neonAtlasTexture, withDrawnColours } from './neonatlas';
import { buildNeonMeshes, placeSigns, type NeonMesh, type Sign } from './neonplace';

const LIGHTS = 4;
const LIGHT_INTENSITY = 6;
const LIGHT_DISTANCE = 14;
const ASSIGN_EVERY = 0.25;
const FADE_S = 0.3;
const VISIBLE_REACH = 150;

/** BufferGeometry from one pure {@link NeonMesh}; empty attributes are skipped. */
function toGeometry(m: NeonMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  if (m.uv.length > 0) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
  if (m.flicker.length > 0) g.setAttribute('flicker', new THREE.BufferAttribute(m.flicker, 1));
  if (m.gain.length > 0) g.setAttribute('gain', new THREE.BufferAttribute(m.gain, 1));
  if (m.color.length > 0) g.setAttribute('glow', new THREE.BufferAttribute(m.color, 3));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
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
  let glowMat: THREE.MeshBasicNodeMaterial | null = null;
  let uTime: { value: number } | null = null;
  const slots: Slot[] = [];
  const signsByCell = new Map<string, Sign[]>();
  const trisByCell = new Map<string, number>();
  let signCount = 0;
  let triCount = 0;
  let visible = 0;
  let sinceAssign = ASSIGN_EVERY;
  const frustum = new THREE.Frustum();
  const proj = new THREE.Matrix4();
  const tmp = new THREE.Vector3();

  const recount = (): void => {
    let n = 0;
    for (const list of signsByCell.values()) n += list.length;
    signCount = n;
    let t = 0;
    for (const v of trisByCell.values()) t += v;
    triCount = t;
  };

  const ensureMats = (): void => {
    if (faceMat && frameMat && glowMat && uTime) return;
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
    // PM tune (wave 20b): ×7 — with the v2 dark facades the signs must be the brightest light in the street, as in the reference.
    // v2: per-vertex gain — tube faces ×7, facade screens ×3.
    const gain = attribute<'float'>('gain', 'float');
    face.emissiveNode = texture(neonAtlasTexture()).rgb.mul(gain).mul(on);
    const frame = new THREE.MeshStandardNodeMaterial();
    frame.colorNode = vec3(0.012, 0.012, 0.015);
    frame.roughnessNode = float(0.55);
    frame.metalnessNode = float(0.45);
    // Fake spill (v2): additive radial card on the wall, no lighting cost.
    const glow = new THREE.MeshBasicNodeMaterial();
    glow.transparent = true;
    glow.depthWrite = false;
    glow.blending = THREE.AdditiveBlending;
    glow.colorNode = attribute<'vec3'>('glow', 'vec3');
    const d = length(uv().sub(vec2(0.5, 0.5))).mul(2);
    const fall = clamp(float(1).sub(d), 0, 1);
    glow.opacityNode = fall.mul(fall).mul(on);
    glow.fog = true;
    faceMat = face;
    frameMat = frame;
    glowMat = glow;
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
    if (!ctx || !faceMat || !frameMat || !glowMat) return null;
    const signs = placeSigns(cell.buildings, cell.roads, ctx.groundAt, ctx.cityId).map(withDrawnColours);
    if (signs.length === 0) return null;
    const meshes = buildNeonMeshes(signs, getSlotUv);
    const group = new THREE.Group();
    group.name = cell.key;
    const faceMesh = new THREE.Mesh(toGeometry(meshes.faces), faceMat);
    faceMesh.name = 'neon-face';
    const frameMesh = new THREE.Mesh(toGeometry(meshes.frames), frameMat);
    frameMesh.name = 'neon-frame';
    const glowMesh = new THREE.Mesh(toGeometry(meshes.glow), glowMat);
    glowMesh.name = 'neon-glow';
    glowMesh.renderOrder = 1;
    group.add(faceMesh, frameMesh, glowMesh);
    signsByCell.set(cell.key, signs);
    trisByCell.set(cell.key, (meshes.faces.index.length + meshes.frames.index.length + meshes.glow.index.length) / 3);
    recount();
    return group;
  };

  const disposeObj = (obj: THREE.Object3D): void => {
    signsByCell.delete(obj.name);
    trisByCell.delete(obj.name);
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
    slot.light.color.set(sign.text);
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
      trisByCell.clear();
      signCount = 0;
      triCount = 0;
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
      trisByCell.clear();
      signCount = 0;
      triCount = 0;
      visible = 0;
      for (const slot of slots) slot.light.removeFromParent();
      slots.length = 0;
      faceMat?.dispose();
      frameMat?.dispose();
      glowMat?.dispose();
      faceMat = null;
      frameMat = null;
      glowMat = null;
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
        triangles: triCount,
        cells: s.cells,
        pending: s.pending,
        buildMs: s.buildMs,
      };
    },
  };
}
