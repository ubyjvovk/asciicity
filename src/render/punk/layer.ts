/**
 * Cyberpunk layer plug-in contract (wave 20b, docs/architecture.md §4.11
 * "cyberpunk v2"). PM-owned: do not change shapes without a ticket that
 * says so.
 *
 * A layer is an optional piece of the night city that exists only while the
 * cyberpunk style is active: facade detail geometry, street props, neon
 * signs. `PunkView` owns one `THREE.Group` per layer, adds it to the scene on
 * activate and removes it on deactivate; the layer only fills its group.
 * Layers are registered in `layers.ts` (one line each).
 */
import type * as THREE from 'three/webgpu';
import type { Building, HeightFn, Road } from '../../data/types';

/** One streamed chunk of city data: a tile (key `"i_j"`) or `"base"` (non-tiled city / global extras). */
export interface PunkSource {
  buildings: readonly Building[];
  roads: readonly Road[];
}

/** What every layer can read. Same object for the view's lifetime. */
export interface PunkLayerContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  /** Ground height sampler (terrain + bridge decks); `FLAT_HEIGHT` on flat cities. */
  groundAt: HeightFn;
  /** City id (`'london'`, `'kyiv'`, …, `'synthetic'`) — for per-city word lists etc. */
  cityId: string;
  /**
   * Live resident chunks, keyed as above. The map instance is stable and is
   * mutated by main.ts as tiles stream in/out: diff its keys against what you
   * built (build new keys, dispose vanished keys). Never mutate it.
   */
  sources: ReadonlyMap<string, PunkSource>;
  /**
   * The live passenger-car fleet (wave 23c): the `CarFleet` InstancedMesh
   * (one instance per car, matrices updated every frame by main.ts; its
   * position y = ground + CAR_HALF_HEIGHT, rotation.y = −heading), or null
   * when the city has no cars or the CARS setting is off. A getter because
   * tiled cities rebuild the fleet. Read-only: to hide the boxes a layer
   * toggles its MATERIAL's `visible` (not the mesh's — main.ts only advances
   * the fleet while `object.visible`), only while active, restored on detach.
   */
  traffic(): THREE.InstancedMesh | null;
}

/** A pluggable part of the cyberpunk city. */
export interface PunkLayer {
  /** Short id, lower-case: `'detail'`, `'props'`, `'neon'`. Also the `stats()` key prefix. */
  readonly id: string;
  /**
   * Whether the rain height pass should IGNORE this layer's group (true for
   * glow volumes / light cones / signs that rain must fall through). Default false.
   */
  readonly rainPassThrough?: boolean;
  /** Called once per activation, after `root` is in the scene. Build what is resident now. */
  attach(ctx: PunkLayerContext, root: THREE.Group): void;
  /** Every frame while active: diff `ctx.sources`, animate. Keep it ≤ 1 ms on average. */
  update(ctx: PunkLayerContext, timeS: number, dtS: number): void;
  /** Deactivation: `root` is already out of the scene. Free per-activation GPU objects or keep caches. */
  detach(ctx: PunkLayerContext): void;
  /** Free everything (view disposal). */
  dispose(): void;
  /** Flat numeric debug stats (exposed via `__asciicity.punk.stats()`, prefixed `<id>.`). */
  stats(): Record<string, number>;
}
