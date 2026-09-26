/**
 * Cyberpunk layer `holo` (wave 25, T-0173): a 50 m dancing anime hologram
 * (Blade Runner 2049 style) near a central preset in every real city —
 * `public/models/holo/mia.glb` (skinned, one Mixamo clip) drawn with one
 * additive TSL hologram material per texture, over a projector disc and a
 * faint light column. No lights. Placement/timing maths live in the pure
 * `hologramplace.ts`; notes in docs/styles/cyberpunk-hologram.md.
 *
 * Lifecycle: the GLB loads lazily on the first attach (cached across
 * activations); the spot is computed once the tiles around the anchor are
 * resident and then stays fixed. Stutter rules (architecture.md §4.11): the
 * first frame after load draws everything at scale ≈ 0 through the real
 * pipeline (compiles every material), the next frame reveals it.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  float,
  floor,
  hash,
  length,
  luminance,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  mrt,
  normalView,
  positionLocal,
  positionViewDirection,
  positionWorld,
  screenCoordinate,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Building } from '../../data/types';
import type { PunkLayer, PunkLayerContext, PunkSource } from './layer';
import {
  HOLO_GLITCH_S,
  HOLO_HEIGHT,
  holoDiscClear,
  holoFlicker,
  holoGlitchGap,
  holoHash,
  holoPlacement,
  holoStart,
  holoSway,
  holoTileKeys,
  type HoloPlacement,
} from './hologramplace';

/** Dance playback speed. */
const DANCE_SPEED = 0.85;
/** Feet → head tint: cyan → magenta. */
const TINT_FEET = new THREE.Color(0x3ef2ff);
const TINT_HEAD = new THREE.Color(0xff3ad8);
/** Scanlines: world-y period (m) and upward scroll (m/s). */
const SCAN_PERIOD = 0.35;
const SCAN_SPEED = 0.6;
/** Glitch bands: height (m) and max x shift (m). */
const GLITCH_BAND = 1.5;
const GLITCH_SHIFT = 0.6;
/** Colour clamp per fragment (additive overdraw stays legible close up). */
const MAX_RGB = 1.4;
/** Projector disc radius (m), light column radius / height (m) / peak opacity. */
const DISC_R = 9;
const COLUMN_R = 7;
const COLUMN_H = 55;
const COLUMN_OPACITY = 0.06;
/** Tiles within this square half-extent (m) of the start must be resident before placing. */
const REQUIRE_R = 400;
/** …or the resident set must have been unchanged this long (s) (tiles beyond the dataset never arrive). */
const SETTLE_S = 2;
/** Warm-up scale: the whole hologram collapses to a point for the compile draw. */
const WARM_SCALE = 1e-4;
/** A `"i_j"` tile key. */
const TILE_KEY = /^-?\d+_-?\d+$/;

/** Shared per-frame uniforms of every hologram material. */
interface HoloUniforms {
  time: UniformNode<'float', number>;
  flicker: UniformNode<'float', number>;
  glitch: UniformNode<'float', number>;
  glitchSeed: UniformNode<'float', number>;
  baseY: UniformNode<'float', number>;
}

/**
 * MRT override for additive hologram parts: `emissive` gets `bloom` (the
 * bloom source) and the normal / metal-rough targets are left untouched
 * (alpha 0 under their normal blending), so SSR under the hologram is unchanged.
 */
function holoMrt(bloom: Node<'vec3'>, alpha: Node<'float'>): ReturnType<typeof mrt> {
  return mrt({
    emissive: vec4(bloom, alpha),
    normal: vec4(0, 0, 0, 0),
    metalrough: vec4(0, 0, 0, 0),
  });
}

/** The common additive, fog-free, depth-tested-but-not-written setup. */
function additive(m: THREE.MeshBasicNodeMaterial, name: string): void {
  m.name = name;
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  m.side = THREE.DoubleSide;
  m.fog = false;
}

/** The hologram body material for one base-colour texture (`null` = untextured part). */
function bodyMaterial(map: THREE.Texture | null, u: HoloUniforms): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  additive(m, `punk:holo:body${map ? '' : ':plain'}`);

  // Glitch: 1.5 m world-y bands shoved ±0.6 m in world x (skinned position → world → back).
  const w = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
  const band = floor(w.y.sub(u.baseY).div(GLITCH_BAND));
  const shift = hash(band.add(u.glitchSeed)).mul(2).sub(1).mul(GLITCH_SHIFT).mul(u.glitch);
  m.positionNode = modelWorldMatrixInverse.mul(vec4(w.add(vec3(shift, 0, 0)), 1)).xyz;

  // Features: texture luminance, contrast kept so face / hair / clothes read.
  const lum = map ? luminance(texture(map, uv()).rgb) : float(0.3);
  const feature = lum.pow(0.8).mul(1.3).add(0.12);
  const h = clamp(positionWorld.y.sub(u.baseY).div(HOLO_HEIGHT), 0, 1);
  const tint = mix(vec3(TINT_FEET.r, TINT_FEET.g, TINT_FEET.b), vec3(TINT_HEAD.r, TINT_HEAD.g, TINT_HEAD.b), smoothstep(0.1, 0.95, h));
  const fres = float(1).sub(abs(normalView.dot(positionViewDirection))).clamp(0, 1).pow(2.5);
  const scan = sin(positionWorld.y.sub(u.time.mul(SCAN_SPEED)).mul((2 * Math.PI) / SCAN_PERIOD)).mul(0.225).add(0.775);
  const shimmer = hash(screenCoordinate.x.add(screenCoordinate.y.mul(1931)).add(floor(u.time.mul(24)).mul(7.13))).mul(0.16).add(0.92);
  // Close up (< 30 m) dimmer so bloom keeps the silhouette; far brighter so she stays visible over the roofs.
  const dist = length(positionWorld.sub(cameraPosition));
  const far = smoothstep(20, 400, dist);
  const glitchDim = float(1).sub(u.glitch.mul(0.55));
  const rim = mix(tint, vec3(1, 1, 1), 0.3).mul(fres).mul(1.4);
  const rgb = tint.mul(feature).mul(scan).add(rim).mul(shimmer).mul(u.flicker).mul(glitchDim);
  const col = rgb.mul(mix(float(0.55), float(1.2), far)).min(vec3(MAX_RGB, MAX_RGB, MAX_RGB));
  const alpha = u.flicker.mul(float(1).sub(u.glitch.mul(0.4)));
  m.colorNode = col;
  m.opacityNode = alpha;
  m.mrtNode = holoMrt(col.mul(mix(float(0.15), float(0.6), far)), alpha);
  return m;
}

/** The projector disc: cyan ring + faint radial glow (uv centre = disc centre). */
function discMaterial(u: HoloUniforms): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  additive(m, 'punk:holo:disc');
  const r = length(uv().sub(vec2(0.5, 0.5))).mul(2);
  const ring = r.sub(0.93).div(0.025).pow(2).negate().exp();
  const inner = r.sub(0.62).div(0.015).pow(2).negate().exp().mul(0.45);
  const glow = float(1).sub(r).clamp(0, 1).pow(2).mul(0.22);
  const k = ring.add(inner).add(glow).mul(u.flicker.div(0.75));
  const col = vec3(TINT_FEET.r, TINT_FEET.g, TINT_FEET.b).mul(k).mul(1.4);
  m.colorNode = col;
  m.opacityNode = float(1);
  m.mrtNode = holoMrt(col.mul(0.5).min(vec3(1, 1, 1)), float(1));
  return m;
}

/** The light column: additive open cylinder fading upward (uv.y 0 bottom → 1 top). */
function columnMaterial(u: HoloUniforms): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  additive(m, 'punk:holo:column');
  const y = uv().y;
  const fade = float(1).sub(y).pow(1.5);
  m.colorNode = mix(vec3(TINT_FEET.r, TINT_FEET.g, TINT_FEET.b), vec3(TINT_HEAD.r, TINT_HEAD.g, TINT_HEAD.b), y);
  m.opacityNode = fade.mul(COLUMN_OPACITY).mul(u.flicker.div(0.75)).min(COLUMN_OPACITY);
  m.mrtNode = holoMrt(vec3(0, 0, 0), float(0));
  return m;
}

/** Projector disc geometry draped on the ground: `rings` × `segs` grid, y = ground + 0.08 relative to `baseY`. */
function discGeometry(cx: number, cz: number, baseY: number, groundAt: (x: number, z: number) => number): THREE.BufferGeometry {
  const rings = 8;
  const segs = 64;
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const rr = (DISC_R * i) / rings;
    for (let j = 0; j <= segs; j++) {
      const a = (2 * Math.PI * j) / segs;
      const x = rr * Math.cos(a);
      const z = rr * Math.sin(a);
      pos.push(x, groundAt(cx + x, cz + z) - baseY + 0.08, z);
      uvs.push(0.5 + (0.5 * x) / DISC_R, 0.5 + (0.5 * z) / DISC_R);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j;
      const b = a + segs + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The loaded, prepared model (cached across activations). */
interface HoloModel {
  scene: THREE.Group;
  mixer: THREE.AnimationMixer;
  /** Posed (clip t = 0) bbox in model units. */
  box: THREE.Box3;
  materials: THREE.MeshBasicNodeMaterial[];
  textures: THREE.Texture[];
  triangles: number;
  meshes: number;
}

/** The `holo` layer implementation. */
export class HologramLayer implements PunkLayer {
  readonly id = 'holo';
  readonly rainPassThrough = true;

  private root: THREE.Group | null = null;
  private readonly u: HoloUniforms = {
    time: uniform(0),
    flicker: uniform(0.75),
    glitch: uniform(0),
    glitchSeed: uniform(0),
    baseY: uniform(0),
  };
  private loading: Promise<void> | null = null;
  private model: HoloModel | null = null;
  private loadMs = 0;
  /** Placement: undefined = not yet, null = no spot / no anchor. */
  private place: HoloPlacement | null | undefined = undefined;
  private groundY = 0;
  private lastKeys = -1;
  private settleSince = 0;
  /** holder (world spot, warm scale) → base (disc + column) / turn (yaw + sway) → model. */
  private holder: THREE.Group | null = null;
  private turn: THREE.Group | null = null;
  private discMat: THREE.MeshBasicNodeMaterial | null = null;
  private columnMat: THREE.MeshBasicNodeMaterial | null = null;
  private discGeo: THREE.BufferGeometry | null = null;
  private columnGeo: THREE.BufferGeometry | null = null;
  /** 0 = not built, 1 = warm frame drawn (collapsed), 2 = revealed. */
  private phase = 0;
  private scale = 1;
  private glitchK = 0;
  private nextGlitch = -1;
  private glitchEnd = -1;
  private glitches = 0;
  /** Anchor tiles (tiled cities), those not resident when placed, and re-placements since. */
  private need: string[] = [];
  private missing: string[] = [];
  private moves = 0;

  /** Start loading the model (first time, anchored cities only) and re-hang the built hologram under `root`. */
  attach(ctx: PunkLayerContext, root: THREE.Group): void {
    this.root = root;
    if (this.holder && this.holder.parent !== root) root.add(this.holder);
    if (!this.loading && holoStart(ctx.cityId)) this.loading = this.load();
  }

  /** Place once the anchor tiles are resident, build + warm once loaded, then animate. */
  update(ctx: PunkLayerContext, timeS: number, dtS: number): void {
    if (!this.root) return;
    if (this.place === undefined) this.tryPlace(ctx, timeS);
    else if (this.place && this.missing.length > 0) this.checkLateTiles(ctx, this.place);
    const place = this.place;
    const model = this.model;
    if (!place || !model) return;
    if (this.phase === 0) {
      this.build(ctx, place, model);
      return;
    }
    const holder = this.holder;
    const turn = this.turn;
    if (!holder || !turn) return;
    if (this.phase === 1) {
      holder.scale.setScalar(1);
      this.phase = 2;
      this.nextGlitch = timeS + holoGlitchGap(this.glitchK++);
    }
    // Glitch schedule: 0.15 s every 6–14 s (hashed gaps).
    if (timeS >= this.nextGlitch && this.glitchEnd < this.nextGlitch) {
      this.glitchEnd = timeS + HOLO_GLITCH_S;
      this.u.glitchSeed.value = Math.floor(holoHash(this.glitchK + 0.5) * 997);
      this.nextGlitch = timeS + holoGlitchGap(this.glitchK++);
      this.glitches++;
    }
    this.u.glitch.value = timeS < this.glitchEnd ? 1 : 0;
    this.u.time.value = timeS;
    this.u.flicker.value = holoFlicker(timeS);
    turn.rotation.y = Math.PI - place.yaw + holoSway(timeS);
    model.mixer.update(dtS);
  }

  /** Deactivation: the hologram stays built (and fixed) for the next activation. */
  detach(): void {
    this.root = null;
  }

  /** Free the model, materials and geometry. */
  dispose(): void {
    this.holder?.removeFromParent();
    this.holder = null;
    this.turn = null;
    const m = this.model;
    if (m) {
      m.mixer.stopAllAction();
      m.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const mat of m.materials) mat.dispose();
      for (const t of m.textures) t.dispose();
    }
    this.model = null;
    this.discMat?.dispose();
    this.columnMat?.dispose();
    this.discGeo?.dispose();
    this.columnGeo?.dispose();
    this.discMat = this.columnMat = null;
    this.discGeo = this.columnGeo = null;
    this.phase = 0;
    this.loading = null;
    this.root = null;
  }

  /** Flat debug stats: ready, spot, measured height, triangles, draws, load time, glitches. */
  stats(): Record<string, number> {
    const p = this.place;
    let draws = 0;
    this.holder?.traverse((o) => {
      if (o instanceof THREE.Mesh && o.visible) draws++;
    });
    const m = this.model;
    return {
      ready: this.phase === 2 ? 1 : 0,
      loaded: m ? 1 : 0,
      placed: p ? 1 : p === null ? -1 : 0,
      x: p ? Math.round(p.x * 10) / 10 : 0,
      z: p ? Math.round(p.z * 10) / 10 : 0,
      y: Math.round(this.groundY * 10) / 10,
      yawDeg: p ? Math.round((p.yaw * 180) / Math.PI) : 0,
      height: m ? Math.round((m.box.max.y - m.box.min.y) * this.scale * 10) / 10 : 0,
      triangles: m ? m.triangles : 0,
      draws: this.phase > 0 ? draws : 0,
      loadMs: Math.round(this.loadMs),
      glitches: this.glitches,
      moves: this.moves,
      missing: this.missing.length,
    };
  }

  /**
   * Compute the spot once the anchor's own tile is resident and either every
   * anchor tile is too or the resident set has been unchanged for 2 s (tiles
   * outside the player's streaming range, or beyond the dataset, never come).
   */
  private tryPlace(ctx: PunkLayerContext, timeS: number): void {
    const s = holoStart(ctx.cityId);
    if (!s) {
      this.place = null;
      return;
    }
    const keys = [...ctx.sources.keys()];
    if (keys.length !== this.lastKeys) {
      this.lastKeys = keys.length;
      this.settleSince = timeS;
    }
    const tiled = keys.some((k) => TILE_KEY.test(k));
    const need = holoTileKeys(s.start.x, s.start.z, REQUIRE_R);
    const own = holoTileKeys(s.start.x, s.start.z, 0)[0] ?? '';
    const settled = timeS - this.settleSince >= SETTLE_S;
    if (tiled ? !ctx.sources.has(own) : !settled) return;
    if (!settled && need.some((k) => !ctx.sources.has(k))) return;
    this.need = tiled ? need : [];
    this.missing = this.need.filter((k) => !ctx.sources.has(k));
    this.place = holoPlacement(ctx.cityId, this.gather(ctx, tiled ? ['base', ...need] : keys));
    if (this.place) this.groundY = ctx.groundAt(this.place.x, this.place.z);
  }

  /** Buildings of the given resident source keys. */
  private gather(ctx: PunkLayerContext, keys: readonly string[]): Building[] {
    const out: Building[] = [];
    for (const k of keys) {
      const src: PunkSource | undefined = ctx.sources.get(k);
      if (src) out.push(...src.buildings);
    }
    return out;
  }

  /**
   * A tile that was missing at placement time (out of streaming range) has
   * arrived: keep the spot unless its disc now hits one of the new
   * footprints, in which case re-place over all anchor tiles and move.
   */
  private checkLateTiles(ctx: PunkLayerContext, place: HoloPlacement): void {
    const arrived = this.missing.filter((k) => ctx.sources.has(k));
    if (arrived.length === 0) return;
    this.missing = this.missing.filter((k) => !ctx.sources.has(k));
    if (holoDiscClear(place.x, place.z, this.gather(ctx, arrived))) return;
    const next = holoPlacement(ctx.cityId, this.gather(ctx, ['base', ...this.need]));
    if (!next) return;
    this.place = next;
    this.moves++;
    this.groundY = ctx.groundAt(next.x, next.z);
    this.u.baseY.value = this.groundY;
    if (this.holder) {
      this.holder.position.set(next.x, this.groundY, next.z);
      const disc = this.holder.getObjectByName('holo-disc');
      if (disc instanceof THREE.Mesh) {
        this.discGeo?.dispose();
        this.discGeo = discGeometry(next.x, next.z, this.groundY, ctx.groundAt);
        disc.geometry = this.discGeo;
      }
    }
  }

  /** Assemble holder / base / turn / model at the spot, collapsed for the warm-up draw. */
  private build(ctx: PunkLayerContext, place: HoloPlacement, model: HoloModel): void {
    const root = this.root;
    if (!root) return;
    const holder = new THREE.Group();
    holder.name = 'holo';
    holder.position.set(place.x, this.groundY, place.z);
    this.u.baseY.value = this.groundY;

    this.discMat = discMaterial(this.u);
    this.columnMat = columnMaterial(this.u);
    this.discGeo = discGeometry(place.x, place.z, this.groundY, ctx.groundAt);
    this.columnGeo = new THREE.CylinderGeometry(COLUMN_R, COLUMN_R, COLUMN_H, 48, 1, true).translate(0, COLUMN_H / 2, 0);
    const disc = new THREE.Mesh(this.discGeo, this.discMat);
    disc.name = 'holo-disc';
    const column = new THREE.Mesh(this.columnGeo, this.columnMat);
    column.name = 'holo-column';
    column.renderOrder = 2;
    disc.renderOrder = 1;

    const turn = new THREE.Group();
    turn.rotation.y = Math.PI - place.yaw;
    const b = model.box;
    const s = HOLO_HEIGHT / Math.max(1e-6, b.max.y - b.min.y);
    this.scale = s;
    const c = b.getCenter(new THREE.Vector3());
    model.scene.scale.setScalar(s);
    model.scene.position.set(-c.x * s, -b.min.y * s, -c.z * s);
    turn.add(model.scene);
    holder.add(disc, column, turn);
    // Warm-up: this frame draws everything collapsed to a point (compiles
    // every material through the real MRT pipeline); the next frame reveals.
    holder.scale.setScalar(WARM_SCALE);
    root.add(holder);
    this.holder = holder;
    this.turn = turn;
    this.phase = 1;
  }

  /** Load and prepare the GLB: one hologram material per base-colour texture, clip playing at 0.85×. */
  private async load(): Promise<void> {
    const t0 = performance.now();
    try {
      const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/holo/mia.glb`);
      const scene = gltf.scene;
      const byMap = new Map<string, THREE.MeshBasicNodeMaterial>();
      const textures = new Set<THREE.Texture>();
      const old = new Set<THREE.Material>();
      let triangles = 0;
      let meshes = 0;
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const src = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.MeshStandardMaterial | undefined;
        if (src) old.add(src);
        const map = src?.map ?? null;
        const key = map ? map.source.uuid : '-';
        let mat = byMap.get(key);
        if (!mat) {
          mat = bodyMaterial(map, this.u);
          byMap.set(key, mat);
        }
        if (map) textures.add(map);
        o.material = mat;
        o.frustumCulled = false; // bind-pose bounds do not follow the dance
        o.castShadow = false;
        o.receiveShadow = false;
        const g = o.geometry as THREE.BufferGeometry;
        triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        meshes++;
      });
      // Free the GLB's own materials and their unused maps (normal / metal-rough …).
      for (const m of old) {
        const s = m as THREE.MeshStandardMaterial;
        for (const t of [s.normalMap, s.roughnessMap, s.metalnessMap, s.emissiveMap, s.aoMap]) if (t && !textures.has(t)) t.dispose();
        m.dispose();
      }
      const mixer = new THREE.AnimationMixer(scene);
      const clip = gltf.animations[0];
      if (clip) {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.timeScale = DANCE_SPEED;
        action.play();
      }
      mixer.update(0);
      scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(scene);
      this.model = { scene, mixer, box, materials: [...byMap.values()], textures: [...textures], triangles: Math.round(triangles), meshes };
    } catch (e) {
      console.warn(`[punk:holo] ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.loadMs = performance.now() - t0;
    }
  }
}

/** Create the `holo` layer (model loads on first attach). */
export function createHologramLayer(): PunkLayer {
  return new HologramLayer();
}
