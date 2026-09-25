/**
 * Cyberpunk atmosphere (wave 20b): distance / sky fog and how lights
 * diffuse through it. Owned by T-0157 (fog diffusion) — the body below is
 * the wave-20 upstream fog (`cyberpunkLook.buildComposite`), which that
 * ticket extends with height fog and fog-weighted light halos.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Atmosphere".
 */
import * as THREE from 'three/webgpu';
import { float, max, mix, smoothstep } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';

/** Look-driven fog uniforms (set by `pipeline.applyLook` from `look.ts`). */
export interface FogUniforms {
  fogEnabled: UniformNode<'float', number>;
  fogNear: UniformNode<'float', number>;
  fogFar: UniformNode<'float', number>;
  fogColor: UniformNode<'vec3', THREE.Vector3>;
  fogAmount: UniformNode<'float', number>;
  fogBloomSuppress: UniformNode<'float', number>;
}

/** Everything the atmosphere may read. All texture nodes sample the scene pass at `screenUV`. */
export interface AtmosphereInputs {
  /** Scene colour (+ SSR), linear HDR. */
  beauty: Node<'vec4'>;
  /** Bloom + lens flare of the emissive layer (already blurred). */
  bloom: Node<'vec4'>;
  /** The raw emissive MRT attachment (texture node) — source for wider halos. */
  emissive: Node<'vec4'>;
  /** View-space z of the scene pass (negative in front of the camera). */
  viewZ: Node<'float'>;
  /** Linear depth 0 (near) … 1 (far plane / sky). */
  linearDepth: Node<'float'>;
  /** Raw depth-buffer value (for `getViewPosition`). */
  depth: Node<'float'>;
  /** Camera world matrix (uniform, refreshed every frame by the pipeline). */
  cameraWorld: UniformNode<'mat4', THREE.Matrix4>;
  /** Camera projection-inverse (uniform, refreshed every frame by the pipeline). */
  projectionInverse: UniformNode<'mat4', THREE.Matrix4>;
  fog: FogUniforms;
}

/** The atmosphere's output and its per-frame hook. */
export interface Atmosphere {
  /** Fogged beauty with the bloom composited in (linear HDR, pre-grade). */
  rgb: Node<'vec3'>;
  /** Per-frame hook (animated mist etc.). */
  update(camera: THREE.PerspectiveCamera, timeS: number): void;
  /** Flat numeric stats for `__asciicity.punk.stats()` (prefix `atmosphere.`). */
  stats(): Record<string, number>;
}

/** Build the atmosphere node graph. */
export function createAtmosphere(i: AtmosphereInputs): Atmosphere {
  const u = i.fog;
  const viewDistance = i.viewZ.negate();
  const distanceFog = smoothstep(u.fogNear, u.fogFar, viewDistance);
  const skyFog = smoothstep(float(0.98), float(1.0), i.linearDepth);
  const fogBlend = max(distanceFog, skyFog).mul(u.fogEnabled);
  const rgb = mix(i.beauty.rgb, u.fogColor, fogBlend.mul(u.fogAmount)).add(
    i.bloom.rgb.mul(float(1).sub(fogBlend.mul(u.fogBloomSuppress))),
  );
  return { rgb, update: () => {}, stats: () => ({}) };
}
