/**
 * Cyberpunk layer `ads` (T-0172): giant animated ad screens on highrise
 * facades, roof billboards, blinking aviation beacons and roofline LED
 * strips — the skyline dressing seen from across the city. Emissive only (no
 * lights); every material is created and warmed at attach (§4.11 "Stutter
 * rules"). Placement + meshes: `megaadsplace.ts`; content: `megaadsatlas.ts`.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  float,
  floor,
  fract,
  hash,
  length,
  mix,
  mod,
  positionView,
  select,
  sin,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { CellStreamer, type CellData } from './cells';
import type { PunkLayer, PunkLayerContext } from './layer';
import { disposeMegaAdsAtlas, megaAdsAtlasTexture } from './megaadsatlas';
import {
  MEGA_ATLAS_SIZE,
  MEGA_LANDSCAPE_H,
  MEGA_LANDSCAPE_SLOTS,
  MEGA_LANDSCAPE_W,
  MEGA_LANDSCAPE_Y,
  MEGA_PORTRAIT_H,
  MEGA_PORTRAIT_SLOTS,
  MEGA_PORTRAIT_W,
  MEGA_SCREEN_GAIN,
  buildMegaAdMeshes,
  countMegaAds,
  placeMegaAds,
  type MegaMesh,
} from './megaadsplace';

/** Glitch transition length at each slot switch, seconds. */
const GLITCH_S = 0.3;
/** Slot stride per switch (coprime with 16 and 8, so every slot comes round). */
const SLOT_STRIDE = 5;
/** Portrait marquee speed, slot heights per second. */
const MARQUEE = 0.022;
/** Scanlines / subpixel grid fade out beyond this distance, metres. */
const DETAIL_REACH = 60;
/** Frames the warm-up meshes are drawn before the first cell is built. */
const WARM_FRAMES = 2;

type Kind = 'screens' | 'frames' | 'lights';

/** BufferGeometry from one pure {@link MegaMesh}; a fixed attribute set per kind (stable pipeline keys). */
function toGeometry(m: MegaMesh, kind: Kind): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  if (kind === 'screens') {
    g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    g.setAttribute('adInfo', new THREE.BufferAttribute(m.info, 4));
  } else if (kind === 'lights') {
    g.setAttribute('glow', new THREE.BufferAttribute(m.glow, 3));
    g.setAttribute('blink', new THREE.BufferAttribute(m.blink, 1));
  }
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}

/** One degenerate (zero-area) triangle with the attribute layout of `kind` — the warm-up draw. */
function warmGeometry(kind: Kind): THREE.BufferGeometry {
  return toGeometry(
    {
      position: new Float32Array(9),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array(6),
      info: new Float32Array(12).fill(1),
      glow: new Float32Array(9),
      blink: new Float32Array(3),
      index: new Uint32Array([0, 1, 2]),
    },
    kind,
  );
}

interface Mats {
  screens: THREE.MeshStandardNodeMaterial;
  frames: THREE.MeshStandardNodeMaterial;
  lights: THREE.MeshStandardNodeMaterial;
  time: { value: number };
}

/** Screen / frame / light node materials sampling `atlas`. */
function createMaterials(atlas: THREE.Texture): Mats {
  const time = uniform(0);
  const info = attribute<'vec4'>('adInfo', 'vec4');
  const slot0 = info.x;
  const phase = info.y;
  const period = info.z;
  const land = info.w;
  const t = time.add(phase);
  const cycle = floor(t.div(period));
  const local = t.sub(cycle.mul(period));
  const count = mix(float(MEGA_PORTRAIT_SLOTS), float(MEGA_LANDSCAPE_SLOTS), land);
  const cur = mod(slot0.add(cycle.mul(SLOT_STRIDE)), count);
  const prev = mod(slot0.add(cycle.sub(1).mul(SLOT_STRIDE)).add(count.mul(64)), count);
  // Glitch 1 → 0 over the first 0.3 s of a cycle; the old slot shows for its first half.
  const g = clamp(float(1).sub(local.div(GLITCH_S)), 0, 1);
  const slot = select(local.lessThan(GLITCH_S * 0.5), prev, cur);
  const p = uv();
  // Slow vertical marquee on portrait slots only.
  const v = fract(p.y.add(t.mul(MARQUEE).mul(float(1).sub(land))));
  const band = floor(p.y.mul(18));
  const jitter = hash(band.add(floor(time.mul(40)).mul(31)).add(slot0.mul(7))).sub(0.5);
  const u = fract(p.x.add(jitter.mul(0.3).mul(g)));
  // Slot rect (texture v up, canvas row 0 at v = 1).
  const pw = MEGA_PORTRAIT_W / MEGA_ATLAS_SIZE;
  const ph = MEGA_PORTRAIT_H / MEGA_ATLAS_SIZE;
  const lw = MEGA_LANDSCAPE_W / MEGA_ATLAS_SIZE;
  const lh = MEGA_LANDSCAPE_H / MEGA_ATLAS_SIZE;
  const cols = mix(float(MEGA_ATLAS_SIZE / MEGA_PORTRAIT_W), float(MEGA_ATLAS_SIZE / MEGA_LANDSCAPE_W), land);
  const sw = mix(float(pw), float(lw), land);
  const sh = mix(float(ph), float(lh), land);
  const y0 = mix(float(0), float(MEGA_LANDSCAPE_Y / MEGA_ATLAS_SIZE), land);
  const col = mod(slot, cols);
  const row = floor(slot.div(cols));
  const vTop = float(1).sub(y0).sub(row.mul(sh));
  const inset = (x: typeof u): typeof u => clamp(x, 0.004, 0.996);
  const at = (du: number): ReturnType<typeof vec2> =>
    vec2(col.mul(sw).add(inset(u.add(g.mul(du))).mul(sw)), vTop.sub(sh).add(inset(v).mul(sh)));
  const r = texture(atlas, at(0.012)).r;
  const gg = texture(atlas, at(0)).g;
  const b = texture(atlas, at(-0.012)).b;
  // Scanlines + RGB subpixel grid, faded in within ~60 m.
  const near = clamp(float(1).sub(length(positionView).div(DETAIL_REACH)), 0, 1);
  const pxH = mix(float(MEGA_PORTRAIT_H), float(MEGA_LANDSCAPE_H), land);
  const pxW = mix(float(MEGA_PORTRAIT_W), float(MEGA_LANDSCAPE_W), land);
  const scan = mix(float(1), float(0.62).add(abs(sin(v.mul(pxH).mul(Math.PI))).mul(0.38)), near);
  const sub = mod(floor(u.mul(pxW).mul(3)), 3);
  const onehot = vec3(select(sub.lessThan(0.5), 1, 0), select(sub.greaterThan(0.5).and(sub.lessThan(1.5)), 1, 0), select(sub.greaterThan(1.5), 1, 0));
  const mask = mix(vec3(1, 1, 1), vec3(0.35, 0.35, 0.35).add(onehot.mul(1.1)), near.mul(0.8));
  const pulse = float(1).add(sin(time.mul(1.7).add(phase.mul(3.1))).mul(0.1));
  const flash = float(1).add(g.mul(0.35));

  const screens = new THREE.MeshStandardNodeMaterial();
  screens.colorNode = vec3(0.015, 0.015, 0.02);
  screens.roughnessNode = float(0.35);
  screens.metalnessNode = float(0.05);
  screens.emissiveNode = vec3(r, gg, b).mul(mask).mul(scan).mul(pulse).mul(flash).mul(MEGA_SCREEN_GAIN);
  screens.fog = true;

  const frames = new THREE.MeshStandardNodeMaterial();
  frames.colorNode = vec3(0.012, 0.012, 0.015);
  frames.roughnessNode = float(0.5);
  frames.metalnessNode = float(0.5);
  frames.fog = true;

  // Beacons blink at 1 Hz (on 35 % of the second, per-building phase); strips (blink < 0) stay on.
  const blink = attribute<'float'>('blink', 'float');
  const on = select(blink.lessThan(0), float(1), select(fract(time.add(blink)).lessThan(0.35), float(1), float(0.04)));
  const lights = new THREE.MeshStandardNodeMaterial();
  lights.colorNode = vec3(0.02, 0.02, 0.02);
  lights.roughnessNode = float(0.4);
  lights.metalnessNode = float(0);
  lights.emissiveNode = attribute<'vec3'>('glow', 'vec3').mul(on);
  lights.fog = true;

  return { screens, frames, lights, time };
}

/** Create the `ads` layer (mega screens, billboards, beacons, roofline strips). */
export function createMegaAdsLayer(): PunkLayer {
  let root: THREE.Group | null = null;
  let ctx: PunkLayerContext | null = null;
  let streamer: CellStreamer | null = null;
  let mats: Mats | null = null;
  let warm: THREE.Group | null = null;
  let warmLeft = 0;
  const countsByCell = new Map<string, { screens: number; billboards: number; beacons: number; strips: number; tris: number; draws: number }>();
  const totals = { screens: 0, billboards: 0, beacons: 0, strips: 0, triangles: 0, draws: 0 };

  const recount = (): void => {
    totals.screens = totals.billboards = totals.beacons = totals.strips = totals.triangles = totals.draws = 0;
    for (const c of countsByCell.values()) {
      totals.screens += c.screens;
      totals.billboards += c.billboards;
      totals.beacons += c.beacons;
      totals.strips += c.strips;
      totals.triangles += c.tris;
      totals.draws += c.draws;
    }
  };

  const buildCell = (cell: CellData): THREE.Group | null => {
    if (!ctx || !mats) return null;
    const ads = placeMegaAds(cell.buildings, cell.roads, ctx.groundAt, ctx.cityId);
    if (ads.length === 0) return null;
    const meshes = buildMegaAdMeshes(ads);
    const group = new THREE.Group();
    group.name = cell.key;
    let tris = 0;
    let draws = 0;
    for (const kind of ['screens', 'frames', 'lights'] as const) {
      const m = meshes[kind];
      if (m.index.length === 0) continue;
      const mesh = new THREE.Mesh(toGeometry(m, kind), mats[kind]);
      mesh.name = `ads-${kind}`;
      group.add(mesh);
      tris += m.index.length / 3;
      draws++;
    }
    countsByCell.set(cell.key, { ...countMegaAds(ads), tris, draws });
    recount();
    return group;
  };

  const disposeObj = (obj: THREE.Object3D): void => {
    countsByCell.delete(obj.name);
    recount();
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  };

  const dropWarm = (): void => {
    if (!warm) return;
    warm.removeFromParent();
    warm.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    warm = null;
  };

  const clearAll = (): void => {
    if (root && streamer) streamer.clear(root);
    dropWarm();
    countsByCell.clear();
    recount();
  };

  return {
    id: 'ads',
    rainPassThrough: true,
    attach(next, group): void {
      ctx = next;
      root = group;
      const atlas = megaAdsAtlasTexture(next.cityId);
      if (!mats) mats = createMaterials(atlas);
      // Warm-up (Stutter rules): one zero-area draw per material through the
      // real pipeline before any real cell appears.
      dropWarm();
      warm = new THREE.Group();
      warm.name = 'ads-warm';
      for (const kind of ['screens', 'frames', 'lights'] as const) {
        const mesh = new THREE.Mesh(warmGeometry(kind), mats[kind]);
        mesh.frustumCulled = false;
        warm.add(mesh);
      }
      group.add(warm);
      warmLeft = WARM_FRAMES;
      if (!streamer) {
        streamer = new CellStreamer({
          buildRadius: 1600,
          disposeRadius: 1900,
          maxBuildsPerFrame: 1,
          build: (cell) => buildCell(cell),
          dispose: (obj) => disposeObj(obj),
        });
      }
    },
    update(next, timeS): void {
      ctx = next;
      if (!root || !streamer || !mats) return;
      mats.time.value = timeS;
      if (warmLeft > 0) {
        warmLeft--;
        return;
      }
      dropWarm();
      streamer.update(next.sources, next.camera.position.x, next.camera.position.z, root);
    },
    detach(): void {
      clearAll();
      warmLeft = 0;
    },
    dispose(): void {
      clearAll();
      if (mats) {
        mats.screens.dispose();
        mats.frames.dispose();
        mats.lights.dispose();
      }
      mats = null;
      streamer = null;
      root = null;
      ctx = null;
      disposeMegaAdsAtlas();
    },
    stats(): Record<string, number> {
      const s = streamer?.stats() ?? { cells: 0, pending: 0, buildMs: 0 };
      return {
        screens: totals.screens,
        billboards: totals.billboards,
        beacons: totals.beacons,
        strips: totals.strips,
        triangles: totals.triangles,
        draws: totals.draws,
        cells: s.cells,
        pending: s.pending,
        buildMs: s.buildMs,
        warming: warmLeft,
      };
    },
  };
}
