/**
 * Cyberpunk layer `props` (wave 20b): Street props (lamps with light cones, overhead cables) — T-0155.
 * STUB — registered and wired by the PM; the ticket replaces the body.
 * Contract: `layer.ts` and docs/architecture.md §4.11 "cyberpunk v2".
 */
import type * as THREE from 'three/webgpu';
import type { PunkLayer, PunkLayerContext } from './layer';

/** Create the `props` layer. */
export function createPropsLayer(): PunkLayer {
  return {
    id: 'props',
    attach(_ctx: PunkLayerContext, _root: THREE.Group): void {},
    update(_ctx: PunkLayerContext, _timeS: number, _dtS: number): void {},
    detach(_ctx: PunkLayerContext): void {},
    dispose(): void {},
    stats: () => ({}),
  };
}
