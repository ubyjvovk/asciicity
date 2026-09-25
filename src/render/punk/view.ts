/**
 * The cyberpunk style's host (wave 20). Browser-only; loaded with a dynamic
 * `import()` by main.ts the first time a `engine: 'webgpu'` style is picked,
 * so the other styles never download the WebGPU build of three.js.
 *
 * A canvas can hold only one context type, so this owns a second canvas laid
 * exactly over `#view` (same CSS box, `pointer-events: none`), a
 * `WebGPURenderer` on it (WebGL2 backend when WebGPU is unavailable), the
 * post pipeline, the collision rain and the wet dressing. The SAME scene and
 * camera are rendered — the city is not rebuilt; while active, the scene's
 * background, fog, lights, sky and tagged materials are swapped for the
 * night look and restored on deactivate.
 */
import * as THREE from 'three/webgpu';
import { createPipeline, type PunkPipeline } from './pipeline';
import { createRain, type Rain } from './rain';
import { WetDressing } from './wet';
import { LOOK_PRESETS, lookPreset, nextLookPreset, type LookPreset } from './look';
import type { PunkLayer, PunkLayerContext, PunkSource } from './layer';
import { EXPERIMENTAL, LAYER_FACTORIES } from './layers';
import { QualityController } from './quality';
import { disposePbrSets, loadPbrSets, type PbrSets } from './pbr';
import type { HeightFn } from '../../data/types';

/** Construction inputs from main.ts. */
export interface PunkViewOptions {
  /** `#view`: the new canvas is inserted right after it and copies its box. */
  anchor: HTMLCanvasElement;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** The facade window atlas (lit windows → neon emissive), or null (stone). */
  windowTex: THREE.Texture | null;
  /** The sky dome group: hidden while active (rain clouds, no sun/stars). */
  sky: THREE.Object3D;
  /** Initial look preset id (persisted by main.ts). */
  look?: string;
  /** Initial lens-rain state. */
  glass?: boolean;
  /** Ground sampler for layers (terrain + decks). */
  groundAt: HeightFn;
  /** City id for layers (`'synthetic'` when none). */
  cityId: string;
  /** Live resident city chunks for layers (mutated by main.ts; see `layer.ts`). */
  sources: ReadonlyMap<string, PunkSource>;
  /** Live car fleet mesh for the vehicles layer (see `PunkLayerContext.traffic`). */
  traffic: () => THREE.InstancedMesh | null;
  /** Experimental layers the user switched on (persisted by main.ts), e.g. `['neon']`. */
  experimental?: readonly string[];
}

/** Saved scene state for {@link PunkView.setActive}. */
interface Saved {
  background: THREE.Scene['background'];
  environment: THREE.Texture | null;
  fog: THREE.Scene['fog'];
  sky: boolean;
  lights: { light: THREE.Light; color: THREE.Color; intensity: number; ground?: THREE.Color }[];
}

const NIGHT_BG = new THREE.Color(0x06050c);
const NIGHT_FOG = 0x0c0b18;

/** Tiny equirect gradient: dark zenith, neon-tinted horizon — what puddles reflect off-screen. */
function makeNightEnv(): THREE.DataTexture {
  const w = 64;
  const h = 32;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 = bottom (nadir) … 1 = top (zenith), flipY off
    const horizon = Math.exp(-Math.pow((v - 0.5) / 0.08, 2));
    for (let x = 0; x < w; x++) {
      const a = (x / w) * Math.PI * 2;
      const mag = 0.5 + 0.5 * Math.sin(a * 2.0);
      const i = (y * w + x) * 4;
      // PM tune (wave 20b review): a dim blue-grey horizon with a faint
      // magenta/teal hint — the saturated magenta band made every puddle and
      // damp pavement glow purple.
      data[i] = Math.min(255, 8 + horizon * (34 + 26 * mag));
      data[i + 1] = Math.min(255, 8 + horizon * (30 + 10 * (1 - mag)));
      data[i + 2] = Math.min(255, 14 + horizon * (46 + 20 * (1 - mag)));
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * three r185 puts `swizzle: 'rgba'` on every texture-view descriptor. Chrome
 * with experimental WebGPU features on (`--enable-unsafe-webgpu`, which
 * Linux needs for WebGPU at all) types that member as a dictionary and
 * throws, so nothing renders. `'rgba'` is the identity swizzle: drop it.
 */
function patchIdentitySwizzle(): void {
  const proto = (globalThis as { GPUTexture?: { prototype: { createView(d?: object): unknown } } }).GPUTexture?.prototype;
  if (!proto || (proto as { __punkSwizzle?: boolean }).__punkSwizzle) return;
  const orig = proto.createView;
  proto.createView = function (this: unknown, desc?: object) {
    if (desc && (desc as { swizzle?: unknown }).swizzle === 'rgba') {
      const { swizzle: _drop, ...rest } = desc as { swizzle?: unknown };
      return orig.call(this, rest);
    }
    return orig.call(this, desc);
  };
  (proto as { __punkSwizzle?: boolean }).__punkSwizzle = true;
}

/**
 * Debug/perf switches from `?punkq=a,b,c` (wave 23 perf pass): `nossr`,
 * `ssrhalf`, `nobloom`, `noflare`, `nosmaa`, `noglass`, `nolights`,
 * `norain`, `nodetail`, `noprops`, `noneon`, `dpr1`, `dpr2`.
 */
export function punkFlags(search: string = typeof location === 'undefined' ? '' : location.search): Set<string> {
  const raw = new URLSearchParams(search).get('punkq') ?? '';
  return new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));
}

/** The running WebGPU view. */
export class PunkView {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGPURenderer;
  private readonly pipeline: PunkPipeline;
  private readonly rain: Rain;
  private readonly wet: WetDressing;
  private readonly scene: THREE.Scene;
  private readonly sky: THREE.Object3D;
  private readonly env: THREE.DataTexture;
  private saved: Saved | null = null;
  private frame = 0;
  private startedAt = performance.now();
  private _look: LookPreset;
  private _glass: boolean;
  private readonly layers: { layer: PunkLayer; root: THREE.Group; on: boolean }[] = [];
  private readonly ctx: PunkLayerContext;
  private lastT = 0;
  private readonly flags: Set<string>;
  private readonly quality: QualityController;
  private readonly pbr: PbrSets | null;
  private lastRaw = performance.now();

  private constructor(opts: PunkViewOptions, canvas: HTMLCanvasElement, renderer: THREE.WebGPURenderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.scene = opts.scene;
    this.sky = opts.sky;
    this.env = makeNightEnv();
    const q = punkFlags();
    this.flags = q;
    // Adaptive quality (wave 23): `?punkq=tierN` pins a tier, `noadapt` pins 0.
    const pinned = [...q].find((f) => /^tier\d$/.test(f));
    this.quality = new QualityController(0, pinned ? Number(pinned.slice(4)) : q.has('noadapt') ? 0 : undefined);
    this.pipeline = createPipeline(renderer, opts.scene, opts.camera, {
      // Build the SSR graph (WebGPU only); the adaptive tier sets its live
      // resolution / quality right after construction (`applyQuality`).
      ssrScale: this.backend !== 'WebGPU' || q.has('nossr') ? 0 : 0.5,
      ssrQuality: 0.5,
      ssrDistance: 120,
      bloom: !q.has('nobloom'),
      flare: !q.has('noflare'),
      smaa: !q.has('nosmaa'),
    });
    this.rain = createRain();
    // CC0 PBR detail maps (wave 23, T-0167); `?punkq=notex` keeps the procedural look.
    this.pbr = punkFlags().has('notex') ? null : loadPbrSets(renderer);
    this.wet = new WetDressing(opts.windowTex, this.pbr ?? undefined);
    this._look = lookPreset(opts.look);
    this.pipeline.applyLook(this._look);
    this._glass = opts.glass ?? true;
    this.pipeline.setGlass(this._glass);
    this.applyQuality();
    this.ctx = {
      scene: opts.scene,
      camera: opts.camera,
      renderer,
      groundAt: opts.groundAt,
      cityId: opts.cityId,
      sources: opts.sources,
      traffic: opts.traffic,
    };
    const expOn = new Set(opts.experimental ?? []);
    for (const make of LAYER_FACTORIES) {
      const layer = make();
      const root = new THREE.Group();
      root.name = `punk:${layer.id}`;
      const off = q.has(`no${layer.id}`);
      this.layers.push({ layer, root, on: !off && (!EXPERIMENTAL.has(layer.id) || expOn.has(layer.id)) });
    }
    if (new URLSearchParams(location.search).get('punkdebug') === 'height') {
      this.pipeline.showHeightMap(this.rain.heightTexture);
    }
  }

  /** Create the canvas + renderer and wait for the backend. Rejects if neither WebGPU nor WebGL2 works. */
  static async create(opts: PunkViewOptions): Promise<PunkView> {
    const canvas = document.createElement('canvas');
    canvas.id = 'punk';
    canvas.style.cssText = [
      'display:none',
      'position:absolute',
      'top:0',
      'left:0',
      'width:100vw',
      'height:calc(100vh - 20px)',
      'z-index:0',
      'pointer-events:none',
    ].join(';');
    opts.anchor.after(canvas);
    patchIdentitySwizzle();
    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    const pf = punkFlags();
    const dprCap = pf.has('dpr1') ? 1 : pf.has('dpr2') ? 2 : 1.25;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    await renderer.init();
    return new PunkView(opts, canvas, renderer);
  }

  /** `'WebGPU'` or `'WebGL2'` (fallback backend). */
  get backend(): string {
    const b = this.renderer.backend as { isWebGPUBackend?: boolean };
    return b.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  /** Active look preset. */
  get look(): LookPreset {
    return this._look;
  }

  /** Whether the lens rain is on. */
  get glass(): boolean {
    return this._glass;
  }

  /** Whether the view is currently showing. */
  get active(): boolean {
    return this.saved !== null;
  }

  /** Show/hide the canvas and swap the scene into / out of the night look. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    const scene = this.scene;
    if (on) {
      const lights: Saved['lights'] = [];
      scene.traverse((o) => {
        if (!(o instanceof THREE.Light)) return;
        const rec: Saved['lights'][number] = { light: o, color: o.color.clone(), intensity: o.intensity };
        if (o instanceof THREE.HemisphereLight) rec.ground = o.groundColor.clone();
        lights.push(rec);
      });
      this.saved = {
        background: scene.background,
        environment: scene.environment,
        fog: scene.fog,
        sky: this.sky.visible,
        lights,
      };
      scene.background = NIGHT_BG;
      scene.environment = this.env;
      scene.environmentIntensity = 0.45;
      scene.fog = new THREE.FogExp2(NIGHT_FOG, 0.0045);
      this.sky.visible = false;
      for (const { light } of lights) {
        if (light instanceof THREE.AmbientLight) {
          light.color.set(0x5a5f9a);
          light.intensity = 0.8;
        } else if (light instanceof THREE.HemisphereLight) {
          light.color.set(0x6a4aa0);
          light.groundColor.set(0x0a0610);
          light.intensity = 1.6;
        } else if (light instanceof THREE.DirectionalLight) {
          light.color.set(0x9fb4ff);
          light.intensity = 1.4;
        }
      }
      if (!this.flags.has('norain')) scene.add(this.rain.group);
      this.wet.apply(scene);
      for (const l of this.layers) if (l.on) this.attachLayer(l);
      this.canvas.style.display = 'block';
    } else {
      const s = this.saved;
      if (!s) return;
      scene.remove(this.rain.group);
      for (const l of this.layers) if (l.on) this.detachLayer(l);
      this.wet.restore();
      scene.background = s.background;
      scene.environment = s.environment;
      scene.fog = s.fog;
      this.sky.visible = s.sky;
      for (const rec of s.lights) {
        rec.light.color.copy(rec.color);
        rec.light.intensity = rec.intensity;
        if (rec.ground && rec.light instanceof THREE.HemisphereLight) rec.light.groundColor.copy(rec.ground);
      }
      this.saved = null;
      this.canvas.style.display = 'none';
    }
  }

  /** Fog density hook: main.ts thins fog with altitude; keep the same ratio. */
  setFogScale(k: number): void {
    const fog = this.scene.fog;
    if (this.active && fog instanceof THREE.FogExp2) fog.density = 0.0045 * k;
  }

  /** Match the WebGL canvas size (CSS pixels). */
  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  /** Cycle the look preset; returns the new one. */
  cycleLook(step = 1): LookPreset {
    this._look = nextLookPreset(this._look.id, step);
    this.pipeline.applyLook(this._look);
    return this._look;
  }

  /** Toggle the lens rain; returns the new state. */
  toggleGlass(): boolean {
    this._glass = !this._glass;
    this.pipeline.setGlass(this._glass);
    return this._glass;
  }

  /** Debug/e2e: surface height the rain collides with at (x, z) (see `Rain.probe`). */
  probeRain(x: number, z: number): Promise<number | null> {
    return this.rain.probe(this.renderer, x, z);
  }

  /** A tile group is about to be disposed: give its meshes their own materials back. */
  release(root: THREE.Object3D): void {
    this.wet.release(root);
  }

  /** Render one frame (call only while active). */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const t = (performance.now() - this.startedAt) / 1000;
    // Streamed tiles arrive with their WebGL materials: dress them.
    if (this.frame++ % 20 === 0) this.wet.apply(scene);
    this.wet.uTime.value = t;
    this.pipeline.glass.time.value = t;
    camera.updateMatrixWorld();
    const dt = Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    for (const l of this.layers) if (l.on) l.layer.update(this.ctx, t, dt);
    const hide = this.layers.filter((l) => l.on && l.layer.rainPassThrough).map((l) => l.root);
    const now = performance.now();
    const raw = (now - this.lastRaw) / 1000;
    this.lastRaw = now;
    if (this.quality.frame(raw)) this.applyQuality();
    if (!this.flags.has('norain')) this.rain.update(this.renderer, scene, camera, t, hide);
    if (this.flags.has('nolights') && this.frame % 30 === 1) {
      scene.traverse((o) => {
        if (o instanceof THREE.PointLight) o.visible = false;
      });
    }
    this.pipeline.render(t);
  }

  /** Push the controller's tier into the renderer (pixel ratio) and the SSR pass. */
  private applyQuality(): void {
    const tier = this.quality.settings;
    const cap = this.flags.has('dpr1') ? 1 : this.flags.has('dpr2') ? 2 : tier.dpr;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.pipeline.setReflections(tier.ssrScale, tier.ssrQuality, tier.ssrDistance);
  }

  private attachLayer(l: { layer: PunkLayer; root: THREE.Group }): void {
    this.scene.add(l.root);
    l.layer.attach(this.ctx, l.root);
  }

  private detachLayer(l: { layer: PunkLayer; root: THREE.Group }): void {
    this.scene.remove(l.root);
    l.layer.detach(this.ctx);
  }

  /** Experimental layer ids currently on (persist these). */
  get experimental(): string[] {
    return this.layers.filter((l) => l.on && EXPERIMENTAL.has(l.layer.id)).map((l) => l.layer.id);
  }

  /**
   * Toggle a layer by id (`N` → `'neon'`). Returns the new state, or `null`
   * for an unknown id.
   */
  toggleLayer(id: string): boolean | null {
    const l = this.layers.find((x) => x.layer.id === id);
    if (!l) return null;
    l.on = !l.on;
    if (this.active) {
      if (l.on) this.attachLayer(l);
      else this.detachLayer(l);
    }
    return l.on;
  }

  /**
   * Flat debug stats: every layer's `stats()` prefixed `<id>.`, plus
   * `<id>.on` (0/1), `<id>.objects` (meshes under its root), the
   * atmosphere's stats, and `renderer.calls` / `renderer.triangles` of the
   * last frame.
   */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of this.layers) {
      out[`${l.layer.id}.on`] = l.on ? 1 : 0;
      let n = 0;
      l.root.traverse((o) => {
        if (o instanceof THREE.Mesh) n++;
      });
      out[`${l.layer.id}.objects`] = n;
      for (const [k, v] of Object.entries(l.layer.stats())) out[`${l.layer.id}.${k}`] = v;
    }
    for (const [k, v] of Object.entries(this.pipeline.stats())) out[`atmosphere.${k}`] = v;
    out['quality.tier'] = this.quality.tier;
    out['quality.fps'] = Math.round(this.quality.lastFps);
    out['quality.dpr'] = this.renderer.getPixelRatio();
    const info = this.renderer.info.render as { calls?: number; triangles?: number };
    out['renderer.calls'] = info.calls ?? 0;
    out['renderer.triangles'] = info.triangles ?? 0;
    return out;
  }

  /** Every look preset id (for the menu / tests). */
  static get looks(): readonly LookPreset[] {
    return LOOK_PRESETS;
  }

  /** Free everything and drop the canvas. */
  dispose(): void {
    this.setActive(false);
    for (const l of this.layers) l.layer.dispose();
    this.pipeline.dispose();
    this.rain.dispose();
    this.wet.dispose();
    if (this.pbr) disposePbrSets(this.pbr);
    this.env.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/** Entry point for main.ts's dynamic import. */
export function createPunkView(opts: PunkViewOptions): Promise<PunkView> {
  return PunkView.create(opts);
}
