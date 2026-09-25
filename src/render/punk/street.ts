/**
 * Cyberpunk street materials (wave 20b, T-0153): wet asphalt with distinct
 * mirror puddles, damp asphalt between them, concrete pavement tiles
 * off-road, slope-darkened terrain and slowly waving water. The puddle mask,
 * asphalt albedo and every constant live in the pure `streetmath.ts` so the
 * shader and the unit tests share numbers. Contract: docs/architecture.md
 * §4.11 "cyberpunk v2" → "Streets".
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  clamp,
  dot,
  float,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  normalView,
  normalWorld,
  positionView,
  positionWorld,
  smoothstep,
  vec2,
  vec3,
  vertexColor,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { fbm2Node, vnoiseNode } from './noise';
import { rippleNormal, type WetUniforms } from './ripples';
import { horizontalPbrNormal, pbrAlbedoMul, rotate2Node, samplePbr, type PbrSet, type PbrSets } from './pbr';
import { PBR_FADE_FAR_M, PBR_FADE_NEAR_M, PBR_ROUGH_MIX } from './facademath';
import {
  ASPHALT_BASE,
  ASPHALT_DRY_METALNESS,
  ASPHALT_DRY_RIPPLE,
  ASPHALT_DRY_ROUGHNESS,
  ASPHALT_GRAIN_AMP,
  ASPHALT_GRAIN_SCALE,
  ASPHALT_MAX,
  ASPHALT_MIN,
  ASPHALT_PATCH_AMP,
  ASPHALT_PATCH_SCALE,
  ASPHALT_RIPPLE_SCALE,
  GRAZE_HI,
  GRAZE_LO,
  PBR_ASPHALT_M,
  PBR_BLEND_FREQ,
  PBR_PAVING_M,
  PBR_ROT_DEG,
  PBR_ROT_SCALE,
  GROUND_BASE,
  GROUND_PUDDLE_E0,
  DAMP_E0,
  DAMP_ROUGHNESS,
  DAMP_METALNESS,
  DAMP_DARKEN,
  GROUND_PUDDLE_E1,
  GROUND_TILE,
  GROUND_TILE_SEAM,
  PUDDLE_ALBEDO,
  PUDDLE_E0,
  PUDDLE_E1,
  PUDDLE_METALNESS,
  PUDDLE_RIPPLE,
  PUDDLE_ROUGHNESS,
  PUDDLE_SCALE,
  RIPPLE_FADE_FAR,
  RIPPLE_FADE_NEAR,
  ROUGH_FADE_FAR,
  ROUGH_FADE_NEAR,
  ROUGH_FLOOR,
  SLOPE_DARKEN,
  WATER_ALBEDO,
  WATER_METALNESS,
  WATER_RIPPLE_SCALE,
  WATER_RIPPLE_STRENGTH,
  WATER_ROUGHNESS,
  WATER_WAVE_PERIOD,
  WATER_WAVE_SPEED,
} from './streetmath';

/** One material per tagged surface (`userData.surface`). */
export interface StreetMaterials {
  road: THREE.MeshStandardNodeMaterial;
  ground: THREE.MeshStandardNodeMaterial;
  terrain: THREE.MeshStandardNodeMaterial;
  water: THREE.MeshStandardNodeMaterial;
}

/** TSL mirror of `streetmath.asphaltAlbedo` — grain + patch on the asphalt band. */
const asphaltAlbedoNode = Fn(([p]: [Node<'vec2'>]) => {
  const grain = vnoiseNode(p.mul(ASPHALT_GRAIN_SCALE)).sub(0.5).mul(2 * ASPHALT_GRAIN_AMP);
  const patch = vnoiseNode(p.mul(ASPHALT_PATCH_SCALE)).sub(0.5).mul(2 * ASPHALT_PATCH_AMP);
  return clamp(float(ASPHALT_BASE).add(grain).add(patch), float(ASPHALT_MIN), float(ASPHALT_MAX));
});

/** TSL seam-bump height for the concrete pavement: 1 at a tile edge, 0 mid-tile. */
const tileHeight = Fn(([x, z]: [Node<'float'>, Node<'float'>]) => {
  const ux = fract(x.div(GROUND_TILE));
  const uz = fract(z.div(GROUND_TILE));
  const dx = min(ux, float(1).sub(ux));
  const dz = min(uz, float(1).sub(uz));
  const sw = float(GROUND_TILE_SEAM / GROUND_TILE);
  const hx = float(1).sub(smoothstep(float(0), sw, dx));
  const hz = float(1).sub(smoothstep(float(0), sw, dz));
  return hx.add(hz);
});

/** TSL slow 2-octave water-wave world slope (period 6–12 m, drifting at 0.2 m/s). */
const waterWaveSlope = Fn(([p, t]: [Node<'vec2'>, Node<'float'>]) => {
  const s = p.mul(1 / WATER_WAVE_PERIOD).add(t.mul(WATER_WAVE_SPEED));
  const oct = (q: Node<'vec2'>) => vnoiseNode(q).add(vnoiseNode(q.mul(2.03).add(17.1)).mul(0.5));
  const e = 0.5;
  const h = oct(s);
  const hx = oct(s.add(vec2(e, 0)));
  const hz = oct(s.add(vec2(0, e)));
  return vec3(hx.sub(h).div(e).mul(0.35), hz.sub(h).div(e).mul(0.35), 0);
});

/**
 * Specular anti-aliasing fade for wet normal detail (ripples, water waves,
 * tile seams): distance fade × grazing-angle guard, both in [0, 1].
 */
function detailFade(d: Node<'float'>): Node<'float'> {
  const distanceFade = float(1).sub(smoothstep(RIPPLE_FADE_NEAR, RIPPLE_FADE_FAR, d));
  const graze = smoothstep(GRAZE_LO, GRAZE_HI, abs(dot(normalView, normalize(positionView))));
  return distanceFade.mul(graze);
}

/**
 * Anti-tiled horizontal sample of `set` (§4.11 "PBR detail textures"): world
 * xz → uv (u = x, v = −z) at `repeatM`, plus a 37°-rotated ×0.43 copy,
 * blended by `vnoise(xz · 0.05)`. The rotated sample's tangent normal is
 * rotated back so both share the T = +x, B = −z frame.
 */
function antiTiledSample(set: PbrSet, repeatM: number): { col: Node<'vec3'>; rough: Node<'float'>; tn: Node<'vec3'> } {
  const xz = positionWorld.xz;
  const uv1 = vec2(xz.x, xz.y.negate()).div(repeatM);
  const uv2 = rotate2Node(uv1, PBR_ROT_DEG).mul(PBR_ROT_SCALE);
  const a = samplePbr(set, uv1);
  const b = samplePbr(set, uv2);
  const w = vnoiseNode(xz.mul(PBR_BLEND_FREQ));
  const bxy = rotate2Node(b.tn.xy, -PBR_ROT_DEG);
  return {
    col: mix(a.col, b.col, w),
    rough: mix(a.rough, b.rough, w),
    tn: mix(a.tn, vec3(bxy, b.tn.z), w),
  };
}

/**
 * Build the street materials. Metalness drives the SSR reflection strength
 * (pipeline.ts). With `pbr` (wave 23, T-0167) asphalt / paving detail
 * textures modulate the dry surfaces; without it the graphs are unchanged.
 */
export function makeStreetMaterials(u: WetUniforms, pbr?: PbrSets): StreetMaterials {
  // Locked puddle mask on world xz — 0 = damp asphalt, 1 = standing water.
  const wetN = fbm2Node(positionWorld.xz.mul(PUDDLE_SCALE));
  const puddle = smoothstep(PUDDLE_E0, PUDDLE_E1, wetN);
  // Damp halo toward puddles (wave 23b): darker + slicker, below the SSR mask.
  const damp = smoothstep(DAMP_E0, PUDDLE_E0, wetN);
  const dampDark = mix(float(1), float(DAMP_DARKEN), damp);
  const dryRough = mix(float(ASPHALT_DRY_ROUGHNESS), float(DAMP_ROUGHNESS), damp);
  const dryMetal = mix(float(ASPHALT_DRY_METALNESS), float(DAMP_METALNESS), damp);
  // Specular anti-aliasing: fade normal detail with view distance + grazing
  // angle, and raise puddle/water roughness at distance (dry asphalt stays).
  const d = length(positionView);
  const nFade = detailFade(d);
  const roughFade = smoothstep(ROUGH_FADE_NEAR, ROUGH_FADE_FAR, d);
  const puddleRough = mix(float(PUDDLE_ROUGHNESS), max(float(PUDDLE_ROUGHNESS), float(ROUGH_FLOOR)), roughFade);

  // --- Road: dark grainy asphalt with distinct mirror puddles ---
  const road = new THREE.MeshStandardNodeMaterial();
  // Dry-asphalt albedo (±15 % class tint from vertex colour), puddles go near-black.
  const vc = vertexColor().rgb;
  const luma = dot(vc, vec3(0.299, 0.587, 0.114));
  const asphalt = asphaltAlbedoNode(positionWorld.xz);
  const tinted = asphalt.mul(float(1).add(luma.sub(0.5).mul(0.3)));
  road.colorNode = mix(tinted.mul(dampDark), vec3(PUDDLE_ALBEDO), puddle);
  road.roughnessNode = mix(dryRough, puddleRough, puddle);
  road.metalnessNode = mix(dryMetal, float(PUDDLE_METALNESS), puddle);
  const roadRipple = rippleNormal(u, ASPHALT_RIPPLE_SCALE, mix(float(ASPHALT_DRY_RIPPLE), float(PUDDLE_RIPPLE), puddle).mul(nFade));
  road.normalNode = roadRipple;

  // --- Ground / terrain: concrete pavement tiles with puddles at half coverage ---
  const gp = smoothstep(GROUND_PUDDLE_E0, GROUND_PUDDLE_E1, wetN);
  const gDamp = smoothstep(DAMP_E0 + 0.06, GROUND_PUDDLE_E0, wetN);
  const concrete = clamp(float(GROUND_BASE).add(vnoiseNode(positionWorld.xz.mul(2)).sub(0.5).mul(0.02)), float(0.05), float(0.07));
  const gDark = mix(float(1), float(DAMP_DARKEN), gDamp);
  const pavement = mix(concrete.mul(gDark), vec3(PUDDLE_ALBEDO), gp);
  const pavementRough = mix(mix(float(0.55), float(DAMP_ROUGHNESS), gDamp), puddleRough, gp);
  const pavementMetal = mix(mix(float(0.15), float(DAMP_METALNESS), gDamp), float(PUDDLE_METALNESS), gp);
  const ripple = rippleNormal(u, ASPHALT_RIPPLE_SCALE, mix(float(0.1), float(0.7), gp).mul(nFade));
  // Tile seams: finite-difference the seam height and nudge the (near-up) normal's xy.
  const e = 0.15;
  const h0 = tileHeight(positionWorld.x, positionWorld.z);
  const hpx = tileHeight(positionWorld.x.add(e), positionWorld.z);
  const hpz = tileHeight(positionWorld.x, positionWorld.z.add(e));
  const tileBump = vec2(hpx.sub(h0).div(e).mul(0.06), hpz.sub(h0).div(e).mul(0.06)).mul(nFade);
  const pavementNormal = normalize(vec3(ripple.x.add(tileBump.x), ripple.y.add(tileBump.y), ripple.z));

  const ground = new THREE.MeshStandardNodeMaterial();
  ground.colorNode = pavement;
  ground.roughnessNode = pavementRough;
  ground.metalnessNode = pavementMetal;
  ground.normalNode = pavementNormal;

  const terrain = new THREE.MeshStandardNodeMaterial();
  // Pavement look, slope-darkened: `1 − 0.5·(1 − normalWorld.y)`.
  const darken = float(1).sub(float(SLOPE_DARKEN).mul(float(1).sub(normalWorld.y)));
  terrain.colorNode = pavement.mul(darken);
  terrain.roughnessNode = pavementRough;
  terrain.metalnessNode = pavementMetal;
  terrain.normalNode = pavementNormal;

  // --- Water: near-black mirror with ripples plus a slow 2-octave wave ---
  const water = new THREE.MeshStandardNodeMaterial();
  water.colorNode = vec3(WATER_ALBEDO);
  water.roughnessNode = mix(float(WATER_ROUGHNESS), max(float(WATER_ROUGHNESS), float(ROUGH_FLOOR)), roughFade);
  water.metalnessNode = float(WATER_METALNESS);
  const wr = rippleNormal(u, WATER_RIPPLE_SCALE, float(WATER_RIPPLE_STRENGTH).mul(nFade));
  const wsl = waterWaveSlope(positionWorld.xz, u.uTime).mul(nFade);
  water.normalNode = normalize(vec3(wr.x.add(wsl.x), wr.y.add(wsl.y), wr.z));

  if (pbr) {
    // Pattern → mean and normal → flat over 15 → 60 m; puddles stay mirror-smooth.
    const pFade = float(1).sub(smoothstep(PBR_FADE_NEAR_M, PBR_FADE_FAR_M, d));

    const as = pbr.asphalt;
    const at = antiTiledSample(as, PBR_ASPHALT_M);
    const aOn = pFade.mul(as.ready);
    road.colorNode = mix(tinted.mul(dampDark).mul(pbrAlbedoMul(at.col, as.mean, aOn)), vec3(PUDDLE_ALBEDO), puddle);
    road.roughnessNode = mix(mix(dryRough, at.rough, as.ready.mul(PBR_ROUGH_MIX).mul(damp.oneMinus())), puddleRough, puddle);
    road.normalNode = horizontalPbrNormal(roadRipple, at.tn, aOn.mul(puddle.oneMinus()));

    const pv = pbr.paving;
    const pt = antiTiledSample(pv, PBR_PAVING_M);
    const pOn = pFade.mul(pv.ready);
    const paved = mix(concrete.mul(gDark).mul(pbrAlbedoMul(pt.col, pv.mean, pOn)), vec3(PUDDLE_ALBEDO), gp);
    const pavedRough = mix(mix(mix(float(0.55), float(DAMP_ROUGHNESS), gDamp), pt.rough, pv.ready.mul(PBR_ROUGH_MIX).mul(gDamp.oneMinus())), puddleRough, gp);
    const pavedNormal = horizontalPbrNormal(pavementNormal, pt.tn, pOn.mul(gp.oneMinus()));
    ground.colorNode = paved;
    ground.roughnessNode = pavedRough;
    ground.normalNode = pavedNormal;
    terrain.colorNode = paved.mul(darken);
    terrain.roughnessNode = pavedRough;
    terrain.normalNode = pavedNormal;
  }

  return { road, ground, terrain, water };
}
