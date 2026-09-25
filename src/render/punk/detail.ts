/**
 * Cyberpunk layer `detail` (wave 20b): Facade detail geometry (ledges, balconies, AC units, pipes, rooftop clutter) — T-0154.
 * STUB — registered and wired by the PM; the ticket replaces the body.
 * Contract: `layer.ts` and docs/architecture.md §4.11 "cyberpunk v2".
 */
import type * as THREE from 'three/webgpu';
import type { PunkLayer, PunkLayerContext } from './layer';

/** Create the `detail` layer. */
export function createDetailLayer(): PunkLayer {
  return {
    id: 'detail',
    attach(_ctx: PunkLayerContext, _root: THREE.Group): void {},
    update(_ctx: PunkLayerContext, _timeS: number, _dtS: number): void {},
    detach(_ctx: PunkLayerContext): void {},
    dispose(): void {},
    stats: () => ({}),
  };
}
