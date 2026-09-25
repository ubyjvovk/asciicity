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
  clamp,
  dot,
  float,
  fract,
  min,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  smoothstep,
  vec2,
  vec3,
  vertexColor,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { fbm2Node, vnoiseNode } from './noise';
import { rippleNormal, type WetUniforms } from './ripples';
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
  GROUND_BASE,
  GROUND_PUDDLE_E0,
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

/** Build the street materials. Metalness drives the SSR reflection strength (pipeline.ts). */
export function makeStreetMaterials(u: WetUniforms): StreetMaterials {
  // Locked puddle mask on world xz — 0 = damp asphalt, 1 = standing water.
  const puddle = smoothstep(PUDDLE_E0, PUDDLE_E1, fbm2Node(positionWorld.xz.mul(PUDDLE_SCALE)));

  // --- Road: dark grainy asphalt with distinct mirror puddles ---
  const road = new THREE.MeshStandardNodeMaterial();
  // Dry-asphalt albedo (±15 % class tint from vertex colour), puddles go near-black.
  const vc = vertexColor().rgb;
  const luma = dot(vc, vec3(0.299, 0.587, 0.114));
  const asphalt = asphaltAlbedoNode(positionWorld.xz);
  const tinted = asphalt.mul(float(1).add(luma.sub(0.5).mul(0.3)));
  road.colorNode = mix(tinted, vec3(PUDDLE_ALBEDO), puddle);
  road.roughnessNode = mix(float(ASPHALT_DRY_ROUGHNESS), float(PUDDLE_ROUGHNESS), puddle);
  road.metalnessNode = mix(float(ASPHALT_DRY_METALNESS), float(PUDDLE_METALNESS), puddle);
  road.normalNode = rippleNormal(u, ASPHALT_RIPPLE_SCALE, mix(float(ASPHALT_DRY_RIPPLE), float(PUDDLE_RIPPLE), puddle));

  // --- Ground / terrain: concrete pavement tiles with puddles at half coverage ---
  const gp = smoothstep(GROUND_PUDDLE_E0, GROUND_PUDDLE_E1, fbm2Node(positionWorld.xz.mul(PUDDLE_SCALE)));
  const concrete = clamp(float(GROUND_BASE).add(vnoiseNode(positionWorld.xz.mul(2)).sub(0.5).mul(0.02)), float(0.05), float(0.07));
  const pavement = mix(concrete, vec3(PUDDLE_ALBEDO), gp);
  const pavementRough = mix(float(0.55), float(PUDDLE_ROUGHNESS), gp);
  const pavementMetal = mix(float(0.15), float(PUDDLE_METALNESS), gp);
  const ripple = rippleNormal(u, ASPHALT_RIPPLE_SCALE, mix(float(0.1), float(0.7), gp));
  // Tile seams: finite-difference the seam height and nudge the (near-up) normal's xy.
  const e = 0.15;
  const h0 = tileHeight(positionWorld.x, positionWorld.z);
  const hpx = tileHeight(positionWorld.x.add(e), positionWorld.z);
  const hpz = tileHeight(positionWorld.x, positionWorld.z.add(e));
  const tileBump = vec2(hpx.sub(h0).div(e).mul(0.06), hpz.sub(h0).div(e).mul(0.06));
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
  water.roughnessNode = float(WATER_ROUGHNESS);
  water.metalnessNode = float(WATER_METALNESS);
  const wr = rippleNormal(u, WATER_RIPPLE_SCALE, float(WATER_RIPPLE_STRENGTH));
  const wsl = waterWaveSlope(positionWorld.xz, u.uTime);
  water.normalNode = normalize(vec3(wr.x.add(wsl.x), wr.y.add(wsl.y), wr.z));

  return { road, ground, terrain, water };
}
