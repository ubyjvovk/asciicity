/**
 * Cyberpunk facade materials (wave 20b): building walls + roofs.
 * Owned by T-0152 (facade materials v2) — the body below is the wave-20
 * prototype look (walls of lit windows), which that ticket replaces.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Facades".
 */
import * as THREE from 'three/webgpu';
import { float, floor, fract, hash, mix, mx_noise_float, positionWorld, select, smoothstep, step, texture, uv, vec3, vertexColor } from 'three/tsl';
import { rippleNormal, type WetUniforms } from './ripples';

/** Window light palette (linear RGB): sodium, cool white, cyan, magenta. */
const WARM = vec3(1.0, 0.55, 0.22);
const COOL = vec3(0.62, 0.72, 1.0);
const CYAN = vec3(0.1, 0.85, 1.0);
const MAGENTA = vec3(1.0, 0.12, 0.62);

/** The two building materials, in the `[walls, roof]` group order of `makeBuildingsObject`. */
export interface FacadeMaterials {
  walls: THREE.MeshStandardNodeMaterial;
  roof: THREE.MeshStandardNodeMaterial;
}

/**
 * Build the facade materials. `windowTex` is the 64×64 window atlas
 * (`world/textures.ts`, 8×8 cells per UV unit = 24 m, lit windows are white
 * texels) or null for stone cities (Minas Tirith).
 */
export function makeFacadeMaterials(windowTex: THREE.Texture | null, u: WetUniforms): FacadeMaterials {
  const puddle = smoothstep(0.05, 0.35, mx_noise_float(positionWorld.xz.mul(0.09)));

  const roof = new THREE.MeshStandardNodeMaterial();
  roof.colorNode = vertexColor().rgb.mul(0.07);
  roof.roughnessNode = mix(float(0.4), float(0.1), puddle);
  roof.metalnessNode = mix(float(0.2), float(0.7), puddle);
  roof.normalNode = rippleNormal(u, 4.8, float(0.7));

  const walls = new THREE.MeshStandardNodeMaterial();
  if (windowTex) {
    const tex = texture(windowTex);
    walls.colorNode = tex.rgb.mul(vertexColor().rgb).mul(0.22);
    const cell = floor(uv().mul(8));
    const id = cell.x
      .add(cell.y.mul(131.0))
      .add(floor(positionWorld.x.div(9)).mul(7.3))
      .add(floor(positionWorld.z.div(9)).mul(3.1));
    const h1 = hash(id);
    const h2 = hash(id.add(17.0));
    const lit = step(0.9, tex.r).mul(step(h2, 0.42));
    const tint = select(h1.lessThan(0.5), WARM, select(h1.lessThan(0.72), COOL, select(h1.lessThan(0.87), CYAN, MAGENTA)));
    const flick = select(h2.lessThan(0.03), fract(u.uTime.mul(h1.add(0.5)).mul(3)).step(0.15).oneMinus(), float(1));
    walls.emissiveNode = tint.mul(lit).mul(flick).mul(h2.mul(1.6).add(0.35));
  } else {
    walls.colorNode = vertexColor().rgb.mul(0.2);
  }
  walls.roughnessNode = float(0.5);
  walls.metalnessNode = float(0.1);
  return { walls, roof };
}
