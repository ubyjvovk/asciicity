/**
 * Gridded ground plane for the ASCII world (docs/architecture.md §4.4–§4.5).
 * Browser-only: `document` is touched inside the exported functions, never at
 * module load, so node can import this file.
 */
import * as THREE from 'three';

const GRID_CANVAS = 256;
const GRID_STEP_PX = 32;
/** World metres covered by one texture tile (a line every 5 m). */
const TILE_METRES = 40;

/** 256×256 perspective-grid canvas texture; one tile maps to 40 m. */
export function makeGridTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = GRID_CANVAS;
  canvas.height = GRID_CANVAS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.fillStyle = '#07080a';
  ctx.fillRect(0, 0, GRID_CANVAS, GRID_CANVAS);
  ctx.fillStyle = '#2f8a40';
  for (let i = 0; i < GRID_CANVAS; i += GRID_STEP_PX) {
    ctx.fillRect(i, 0, 3, GRID_CANVAS);
    ctx.fillRect(0, i, GRID_CANVAS, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  return tex;
}

/** Horizontal ground plane of `size` metres with a repeating 5 m grid. */
export function makeGround(size = 6000): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  const map = makeGridTexture();
  map.repeat.set(size / TILE_METRES, size / TILE_METRES);
  const material = new THREE.MeshBasicMaterial({ map });
  return new THREE.Mesh(geometry, material);
}
