/**
 * Trees — `city.trees` rendered as two instanced meshes (canopies + trunks)
 * seated on the terrain (docs/architecture.md §4.14). `buildTreeInstances`
 * is pure and returns column-major matrices + linear canopy colours so the
 * geometry is unit-testable in node; `TreeField` is the thin browser wrapper
 * that turns those into two `THREE.InstancedMesh`es. The field is static —
 * no per-frame work (no collision, no wind, no LOD).
 */
import * as THREE from 'three';
import { mulberry32 } from '../data/synthetic';
import { FLAT_HEIGHT } from '../data/types';
import type { HeightFn } from '../data/types';

/** Fixed trunk colour (linear RGB is written by the material colour). */
const TRUNK_COLOR = 0x6b4a2e;

/** Canopy radius scaling: an icosahedron of unit radius is squashed to 0.8·r tall. */
const SCALE_Y = 0.8;

/**
 * Pure layout of one tree field.
 *
 * `matrices` holds **both** meshes concatenated, column-major like
 * `THREE.Matrix4`:
 * - indices `[0, 16·count)` — canopy matrices;
 * - indices `[16·count, 32·count)` — trunk matrices.
 * (The §4.14 interface comment read `16·count`; two instanced meshes need
 * `2·16·count` total, and the test contract requires both, so the split above
 * is authoritative.)
 */
export interface TreeInstances {
  /** Number of trees (equals the per-mesh instance count). */
  count: number;
  /** Canopy-then-trunk column-major matrices, `32·count` floats. */
  matrices: Float32Array;
  /** Canopy instance colours as linear rgb triples, `3·count` floats. */
  colors: Float32Array;
}

/**
 * Build the instanced matrices and canopy colours for `trees`.
 * Canopy: unit icosahedron scaled `(r, 0.8·r, r)` centred at
 * `(x, y0 + h − 0.8·r, z)`. Trunk: cylinder scaled to height `h − 0.8·r` with
 * its base at `y0 = heightAt(x, z)`. Canopy colours are a seeded olive/green
 * range (hue 95–130°, saturation 0.45–0.70, lightness 0.22–0.38, converted
 * to linear rgb).
 */
export function buildTreeInstances(
  trees: readonly [number, number, number, number][],
  heightAt: HeightFn = FLAT_HEIGHT,
  seed = 5,
): TreeInstances {
  const count = trees.length;
  const matrices = new Float32Array(2 * 16 * count);
  const colors = new Float32Array(3 * count);
  const rand = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const [x, z, h, r] = trees[i];
    const y0 = heightAt(x, z);
    const trunkH = h - SCALE_Y * r;
    // Canopy matrix: scale (r, 0.8·r, r), translate (x, y0 + h − 0.8·r, z).
    const ci = 16 * i;
    matrices[ci + 0] = r;
    matrices[ci + 5] = SCALE_Y * r;
    matrices[ci + 10] = r;
    matrices[ci + 12] = x;
    matrices[ci + 13] = y0 + h - SCALE_Y * r;
    matrices[ci + 14] = z;
    matrices[ci + 15] = 1;
    // Trunk matrix: scale (1, h − 0.8·r, 1), translate to sit its base at y0.
    const ti = 16 * (count + i);
    matrices[ti + 0] = 1;
    matrices[ti + 5] = trunkH;
    matrices[ti + 10] = 1;
    matrices[ti + 12] = x;
    matrices[ti + 13] = y0 + trunkH / 2;
    matrices[ti + 14] = z;
    matrices[ti + 15] = 1;
    // Seeded olive/green canopy colour → linear rgb. The hue is in degrees
    // (95–130°) but `setHSL` takes it in the 0–1 range, so scale by 1/360.
    const color = new THREE.Color()
      .setHSL((95 + 35 * rand()) / 360, 0.60 + 0.25 * rand(), 0.48 + 0.17 * rand())
      .convertSRGBToLinear();
    colors[3 * i] = color.r;
    colors[3 * i + 1] = color.g;
    colors[3 * i + 2] = color.b;
  }
  return { count, matrices, colors };
}

/**
 * A static tree field: two `InstancedMesh`es (canopies with per-instance
 * colours, trunks in a fixed brown) from `buildTreeInstances`. `object` is a
 * `THREE.Group` (or an empty group when there are no trees) to add to the
 * scene; `count` is the number of trees. No `update` needed.
 */
export class TreeField {
  /** The three.js object to add to the scene (a Group of two InstancedMeshes). */
  readonly object: THREE.Object3D;
  /** Number of trees (0 when the input is empty). */
  readonly count: number;

  /** Build the two instanced meshes for `trees` seated via `heightAt`. */
  constructor(trees: readonly [number, number, number, number][], heightAt: HeightFn = FLAT_HEIGHT) {
    const inst = buildTreeInstances(trees, heightAt);
    this.count = inst.count;
    const group = new THREE.Group();
    if (inst.count === 0) {
      this.object = group;
      return;
    }
    const canopy = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({ vertexColors: false }),
      inst.count,
    );
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.18, 0.28, 1, 5),
      new THREE.MeshLambertMaterial({ color: TRUNK_COLOR, vertexColors: false }),
      inst.count,
    );
    for (let i = 0; i < inst.count; i++) {
      canopy.setMatrixAt(i, new THREE.Matrix4().fromArray(inst.matrices, 16 * i));
      canopy.setColorAt(i, new THREE.Color().fromArray(inst.colors, 3 * i));
      trunk.setMatrixAt(i, new THREE.Matrix4().fromArray(inst.matrices, 16 * (inst.count + i)));
    }
    canopy.instanceMatrix.needsUpdate = true;
    trunk.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    group.add(canopy, trunk);
    this.object = group;
  }
}
