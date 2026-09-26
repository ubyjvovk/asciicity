/**
 * Cyberpunk layer registry (wave 20b). One line per layer; `PunkView`
 * instantiates them in this order. `EXPERIMENTAL` layers are on by default
 * (main.ts), toggled by a key (`N` → neon), persisted, and announced with an
 * EXPERIMENTAL toast.
 */
import type { PunkLayer } from './layer';
import { createDetailLayer } from './detail';
import { createPropsLayer } from './props';
import { createVehiclesLayer } from './vehicles';
import { createNeonLayer } from './neon';
import { createMegaAdsLayer } from './megaads';

/** Layer factories in draw order. */
export const LAYER_FACTORIES: readonly (() => PunkLayer)[] = [createDetailLayer, createPropsLayer, createVehiclesLayer, createNeonLayer, createMegaAdsLayer];

/** Layers that are experimental: toggled by a key, shown with an EXPERIMENTAL toast. */
export const EXPERIMENTAL: ReadonlySet<string> = new Set(['neon']);
