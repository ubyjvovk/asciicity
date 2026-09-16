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
/** The grid texture's background fill colour (see `makeGridTexture`). */
const GRID_FILL = '#07080a';

/** Cache key on `mesh.userData` for the shared grid/plain texture pair. */
const GROUND_TEXTURES = 'asciicityGroundTextures';

/** 256×256 perspective-grid canvas texture; one tile maps to 40 m. */
export function makeGridTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = GRID_CANVAS;
  canvas.height = GRID_CANVAS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.fillStyle = GRID_FILL;
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

/** 1×1 canvas texture of the grid's background fill colour (no lines). */
export function makePlainTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.fillStyle = GRID_FILL;
  ctx.fillRect(0, 0, 1, 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Whether a style wants the perspective floor grid drawn under it
 * (`style.groundGrid ?? true`, per docs/architecture.md §4.11 T-0132).
 */
export function groundGridFor(style: { groundGrid?: boolean }): boolean {
  return style.groundGrid ?? true;
}

/**
 * Show or hide the perspective floor grid on a ground mesh built by
 * `makeGround`. Both textures are built once and cached on `mesh.userData`;
 * `material.map` is swapped between them (docs/architecture.md §4.11).
 */
export function setGroundGrid(mesh: THREE.Mesh, on: boolean): void {
  let pair = mesh.userData[GROUND_TEXTURES] as
    | { grid: THREE.CanvasTexture; plain: THREE.CanvasTexture }
    | undefined;
  const material = mesh.material as THREE.MeshBasicMaterial;
  if (!pair) {
    const grid = makeGridTexture();
    const plain = makePlainTexture();
    // Match the repeat already configured on the live material by `makeGround`
    // (size / TILE_METRES) so the plain fill tiles like the grid would.
    const live = material.map as THREE.Texture | undefined;
    if (live) {
      grid.repeat.copy(live.repeat);
      plain.repeat.copy(live.repeat);
    }
    pair = { grid, plain };
    mesh.userData[GROUND_TEXTURES] = pair;
  }
  const map = on ? pair.grid : pair.plain;
  material.map = map;
  material.needsUpdate = true;
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
