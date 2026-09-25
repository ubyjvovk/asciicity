/**
 * Cyberpunk street materials (wave 20b): roads, flat ground, terrain, water.
 * Owned by T-0153 (asphalt + puddles v2) — the body below is the wave-20
 * prototype, which that ticket improves.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Streets".
 */
import * as THREE from 'three/webgpu';
import { float, mix, mx_noise_float, positionWorld, smoothstep, vec3, vertexColor } from 'three/tsl';
import { rippleNormal, type WetUniforms } from './ripples';

/** One material per tagged surface (`userData.surface`). */
export interface StreetMaterials {
  road: THREE.MeshStandardNodeMaterial;
  ground: THREE.MeshStandardNodeMaterial;
  terrain: THREE.MeshStandardNodeMaterial;
  water: THREE.MeshStandardNodeMaterial;
}

/** Build the street materials. Metalness drives the SSR reflection strength (pipeline.ts). */
export function makeStreetMaterials(u: WetUniforms): StreetMaterials {
  // Puddle mask: 0 = damp asphalt, 1 = standing water (world-space noise).
  const puddle = smoothstep(0.05, 0.35, mx_noise_float(positionWorld.xz.mul(0.09)));

  const road = new THREE.MeshStandardNodeMaterial();
  road.colorNode = vertexColor().rgb.mul(mix(float(0.16), float(0.05), puddle));
  road.roughnessNode = mix(float(0.42), float(0.04), puddle);
  road.metalnessNode = mix(float(0.25), float(0.85), puddle);
  road.normalNode = rippleNormal(u, 4.8, mix(float(0.15), float(1.1), puddle));

  const ground = new THREE.MeshStandardNodeMaterial();
  ground.colorNode = vec3(0.022, 0.022, 0.03);
  ground.roughnessNode = mix(float(0.55), float(0.08), puddle);
  ground.metalnessNode = mix(float(0.15), float(0.75), puddle);
  ground.normalNode = rippleNormal(u, 4.8, mix(float(0.1), float(0.9), puddle));

  const terrain = new THREE.MeshStandardNodeMaterial();
  terrain.colorNode = vertexColor().rgb.mul(0.05);
  terrain.roughnessNode = mix(float(0.6), float(0.15), puddle);
  terrain.metalnessNode = mix(float(0.1), float(0.6), puddle);
  terrain.normalNode = rippleNormal(u, 4.8, mix(float(0.1), float(0.8), puddle));

  const water = new THREE.MeshStandardNodeMaterial();
  water.colorNode = vec3(0.006, 0.01, 0.02);
  water.roughnessNode = float(0.03);
  water.metalnessNode = float(0.95);
  water.normalNode = rippleNormal(u, 2.2, float(1.4));

  return { road, ground, terrain, water };
}
