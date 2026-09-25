/**
 * CC0 PBR detail textures for the cyberpunk materials (wave 23, T-0167).
 * Browser-only: loads the six ambientCG sets under
 * `public/textures/cc0/<set>/{color,normal,rough}.jpg` once per view and
 * hands them to `makeFacadeMaterials` / `makeStreetMaterials`. Pure maths
 * (albedo clamp, fade, anti-tiling, TBN, set mapping) lives in
 * `facademath.ts` / `streetmath.ts`. Contract: docs/architecture.md §4.11
 * "PBR detail textures".
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  cameraViewMatrix,
  clamp,
  cos,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  inverseSqrt,
  max,
  mix,
  normalView,
  normalize,
  positionView,
  sin,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import {
  PBR_ALBEDO_MAX,
  PBR_ALBEDO_MIN,
  PBR_NORMAL_STRENGTH,
  PBR_SET_NAMES,
  PBR_WALL_SETS,
  linearMeanRgb,
  type PbrSetName,
} from './facademath';

/** One texture set: three maps plus the uniforms the shader needs. */
export interface PbrSet {
  color: THREE.Texture;
  normal: THREE.Texture;
  rough: THREE.Texture;
  /** Mean linear rgb of the colour map (`TEX_MEAN`), measured once the image loads. */
  mean: THREE.UniformNode<'vec3', THREE.Vector3>;
  /** 0 until all three maps have loaded, then 1 (the procedural look shows meanwhile). */
  ready: THREE.UniformNode<'float', number>;
}

/** All six sets by name. */
export type PbrSets = Record<PbrSetName, PbrSet>;

/** Side of the canvas the colour map is averaged on (mip-like box filter by drawImage). */
const MEAN_PX = 32;

/** Mean linear rgb of an image, or null when the canvas path is unavailable. */
function imageMean(image: CanvasImageSource): [number, number, number] | null {
  const canvas = document.createElement('canvas');
  canvas.width = MEAN_PX;
  canvas.height = MEAN_PX;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return null;
  ctx.drawImage(image, 0, 0, MEAN_PX, MEAN_PX);
  return linearMeanRgb(ctx.getImageData(0, 0, MEAN_PX, MEAN_PX).data);
}

/** Load every set (one cached `THREE.Texture` per map); `renderer` supplies the anisotropy cap. */
export function loadPbrSets(renderer: THREE.WebGPURenderer): PbrSets {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.getMaxAnisotropy());
  const base = `${import.meta.env.BASE_URL}textures/cc0/`;
  const sets: Partial<PbrSets> = {};
  for (const name of PBR_SET_NAMES) {
    const mean = uniform(new THREE.Vector3(1, 1, 1));
    const ready = uniform(0);
    let pending = 3;
    const done = (): void => {
      pending--;
      if (pending === 0) ready.value = 1;
    };
    const load = (map: 'color' | 'normal' | 'rough'): THREE.Texture =>
      loader.load(
        `${base}${name}/${map}.jpg`,
        (tex) => {
          if (map === 'color') {
            const m = tex.image instanceof HTMLImageElement ? imageMean(tex.image) : null;
            if (m !== null) mean.value.set(m[0], m[1], m[2]);
          }
          done();
        },
        undefined,
        // Leave `ready` at 0: the set just stays procedural.
        () => undefined,
      );
    const color = load('color');
    const normal = load('normal');
    const rough = load('rough');
    for (const [tex, srgb] of [
      [color, true],
      [normal, false],
      [rough, false],
    ] as const) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = aniso;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    }
    sets[name] = { color, normal, rough, mean, ready };
  }
  return sets as PbrSets;
}

/** Dispose every texture of `sets` (call with the view's dispose). */
export function disposePbrSets(sets: PbrSets): void {
  for (const name of PBR_SET_NAMES) {
    const s = sets[name];
    s.color.dispose();
    s.normal.dispose();
    s.rough.dispose();
  }
}

// ---------------------------------------------------------------------------
// TSL helpers shared by facade.ts and street.ts (mirrors of the pure maths in
// facademath.ts / streetmath.ts).
// ---------------------------------------------------------------------------

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;

/** Albedo multiplier: `clamp(col / mean, 0.45, 1.8)` pulled toward 1 by `amt` (mirror of `pbrAlbedoMod`). */
export function pbrAlbedoMul(col: V3, mean: V3, amt: F): V3 {
  return mix(vec3(1, 1, 1), clamp(col.div(mean.max(1e-4)), PBR_ALBEDO_MIN, PBR_ALBEDO_MAX), amt);
}

/** Normal-map texel (rgb in [0, 1]) → tangent-space vector in [−1, 1]. */
export function decodeNormal(rgb: V3): V3 {
  return rgb.mul(2).sub(1);
}

/** Rotate a 2-vector by `deg` degrees (mirror of `streetmath.rotate2`). */
export function rotate2Node(p: V2, deg: number): V2 {
  const a = (deg * Math.PI) / 180;
  const c = cos(float(a));
  const s = sin(float(a));
  return vec2(c.mul(p.x).sub(s.mul(p.y)), s.mul(p.x).add(c.mul(p.y)));
}

/**
 * Horizontal-surface detail normal (T = +x, B = −z, N = +y, mirror of
 * `horizontalTbn`): the decoded tangent xy · 0.8 · `k` tilts the view-space
 * `base` normal (e.g. `rippleNormal`), so ripples and texture blend.
 */
export function horizontalPbrNormal(base: V3, tn: V3, k: F): V3 {
  const d = vec3(tn.x, 0, tn.y.negate()).mul(k.mul(PBR_NORMAL_STRENGTH));
  return normalize(base.add(cameraViewMatrix.mul(vec4(d, 0)).xyz));
}

/**
 * Wall detail normal (view space): the tangent xy `txy` (already scaled by
 * strength × fade) on a TBN built from screen derivatives of `uvBase`
 * (cotangent frame, as three's `normalMap`). Must be evaluated outside any
 * branch — it takes derivatives.
 */
export function uvPerturbNormal(txy: V2, uvBase: V2): V3 {
  const q0 = dFdx(positionView);
  const q1 = dFdy(positionView);
  const st0 = dFdx(uvBase);
  const st1 = dFdy(uvBase);
  const n = normalView;
  const q1perp = cross(q1, n);
  const q0perp = cross(n, q0);
  const t = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
  const b = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
  const s = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-24));
  return normalize(t.mul(txy.x.mul(s)).add(b.mul(txy.y.mul(s))).add(n));
}

/**
 * Sample `set` at `uv` (plain, implicit-derivative sampling — uniform control
 * flow) and return `{ col, rough, tn }` with `tn` decoded to [−1, 1].
 */
export function samplePbr(set: PbrSet, uv: V2): { col: V3; rough: F; tn: V3 } {
  return {
    col: texture(set.color, uv).rgb,
    rough: texture(set.rough, uv).r,
    tn: decodeNormal(texture(set.normal, uv).rgb),
  };
}

/** The wall sets in branch order (`PBR_WALL_SETS` without the leading "none"). */
function wallSets(pbr: PbrSets): { i: number; set: PbrSet; iso: boolean }[] {
  const out: { i: number; set: PbrSet; iso: boolean }[] = [];
  PBR_WALL_SETS.forEach((name, i) => {
    if (name !== null) out.push({ i, set: pbr[name], iso: name === 'concrete' || name === 'plaster' });
  });
  return out;
}

/** A wall map: colour (rgb), roughness (r) or normal (rgb). */
type WallMap = 'color' | 'rough' | 'normal';

/**
 * Per-fragment wall set choice without sampling every set: a branch on
 * `idx` (0 none, 1 concrete, 2 brick, 3 metal, 4 plaster — `PBR_WALL_SETS`)
 * with explicit-gradient samples (gradients taken before the branch, so
 * the graph stays valid WGSL). Isotropic sets read `uvIso` (anti-tiling
 * swap), the others `uvAniso`. One function per map, each feeding exactly
 * one material slot, so a fragment samples 3 maps in total.
 */
function wallBranch(pbr: PbrSets, map: WallMap) {
  const sets = wallSets(pbr);
  return Fn(([idx, uvIso, uvAniso]: [F, V2, V2]) => {
    // Explicit assignments: a bare `.toVar()` is emitted lazily at first use,
    // which would put the derivatives inside the branch.
    const ui = vec2(0, 0).toVar();
    const ua = vec2(0, 0).toVar();
    const gix = vec2(0, 0).toVar();
    const giy = vec2(0, 0).toVar();
    const gax = vec2(0, 0).toVar();
    const gay = vec2(0, 0).toVar();
    ui.assign(uvIso);
    ua.assign(uvAniso);
    gix.assign(dFdx(ui));
    giy.assign(dFdy(ui));
    gax.assign(dFdx(ua));
    gay.assign(dFdy(ua));
    // Defaults = "no texture" (the caller also zeroes the weight).
    const out = (map === 'normal' ? vec3(0.5, 0.5, 1) : vec3(1, 1, 1)).toVar();
    const body = (s: { set: PbrSet; iso: boolean }) => () => {
      const tex = map === 'color' ? s.set.color : map === 'rough' ? s.set.rough : s.set.normal;
      out.assign(s.iso ? texture(tex, ui).grad(gix, giy).rgb : texture(tex, ua).grad(gax, gay).rgb);
    };
    const last = sets[sets.length - 1];
    let chain = If(idx.greaterThan(last.i - 0.5), body(last));
    for (let k = sets.length - 2; k >= 0; k--) chain = chain.ElseIf(idx.greaterThan(sets[k].i - 0.5), body(sets[k]));
    return out;
  });
}

/** Wall samplers for one `PbrSets`: `color` / `rough` / `normal` `(idx, uvIso, uvAniso)` → raw texel rgb. */
export function makeWallSamplers(pbr: PbrSets) {
  return { color: wallBranch(pbr, 'color'), rough: wallBranch(pbr, 'rough'), normal: wallBranch(pbr, 'normal') };
}

/** Per-set uniform picked by the wall branch index (`mean` / `ready`); 1 / 0 for "none". */
export function wallSetUniform(pbr: PbrSets, idx: F, key: 'mean'): V3;
export function wallSetUniform(pbr: PbrSets, idx: F, key: 'ready'): F;
export function wallSetUniform(pbr: PbrSets, idx: F, key: 'mean' | 'ready'): V3 | F {
  const sets = wallSets(pbr);
  if (key === 'mean') {
    let v: V3 = vec3(1, 1, 1);
    for (const s of sets) v = mix(v, s.set.mean, idx.sub(s.i).abs().lessThan(0.5).select(float(1), float(0)));
    return v;
  }
  let r: F = float(0);
  for (const s of sets) r = mix(r, s.set.ready, idx.sub(s.i).abs().lessThan(0.5).select(float(1), float(0)));
  return r;
}
