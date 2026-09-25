/**
 * Cyberpunk layer `detail` (wave 20b): facade detail geometry — T-0154.
 * Contract: `layer.ts` and docs/architecture.md §4.11 "cyberpunk v2".
 */
import * as THREE from 'three/webgpu';
import { float, uniform } from 'three/tsl';
import { toGeometry } from '../../world/mesh';
import { CellStreamer } from './cells';
import { buildDetailMesh } from './detailmesh';
import type { PunkLayer, PunkLayerContext } from './layer';
import { rippleNormal } from './ripples';

/** Create the `detail` layer. */
export function createDetailLayer(): PunkLayer {
  const uTime = uniform(0);
  const uRain = uniform(1);
  const material = new THREE.MeshStandardNodeMaterial();
  material.vertexColors = true;
  material.roughness = 0.55;
  material.metalness = 0.4;
  material.normalNode = rippleNormal({ uTime, uRain }, 4.8, float(0.6));

  let root: THREE.Group | null = null;
  let streamer: CellStreamer | null = null;
  let triangles = 0;

  const makeStreamer = (ctx: PunkLayerContext): CellStreamer =>
    new CellStreamer({
      buildRadius: 450,
      disposeRadius: 600,
      maxBuildsPerFrame: 1,
      build: (cell) => {
        const data = buildDetailMesh(cell.buildings, ctx.groundAt);
        const tris = data.positions.length / 3;
        if (tris === 0) return null;
        const geom = toGeometry(data);
        const mesh = new THREE.Mesh(geom, material);
        mesh.userData.triangles = tris;
        triangles += tris;
        return mesh;
      },
      dispose: (obj) => {
        const mesh = obj as THREE.Mesh;
        const n = mesh.userData.triangles;
        if (typeof n === 'number') triangles -= n;
        mesh.geometry.dispose();
      },
    });

  return {
    id: 'detail',
    attach(ctx: PunkLayerContext, group: THREE.Group): void {
      root = group;
      triangles = 0;
      streamer = makeStreamer(ctx);
      streamer.update(ctx.sources, ctx.camera.position.x, ctx.camera.position.z, group);
    },
    update(ctx: PunkLayerContext, timeS: number, _dtS: number): void {
      uTime.value = timeS;
      if (!root || !streamer) return;
      streamer.update(ctx.sources, ctx.camera.position.x, ctx.camera.position.z, root);
    },
    detach(_ctx: PunkLayerContext): void {
      if (root && streamer) streamer.clear(root);
      streamer = null;
      root = null;
      triangles = 0;
    },
    dispose(): void {
      if (root && streamer) streamer.clear(root);
      streamer = null;
      root = null;
      triangles = 0;
      material.dispose();
    },
    stats: () => {
      const s = streamer ? streamer.stats() : { cells: 0, pending: 0, buildMs: 0 };
      return { cells: s.cells, pending: s.pending, buildMs: s.buildMs, triangles };
    },
  };
}
