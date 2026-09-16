/**
 * Browser-only facade textures (window map docs/architecture.md §4.4, stone
 * map §4.23 "Facade"). Safe to import in node: nothing runs at module load;
 * the `make*Texture` builders need `document`, the joint helpers are pure.
 */
import * as THREE from 'three';

const TEX_SIZE = 64;
const GRID = 8;
const CELL = 8;
const WIN_W = 4;
const WIN_H = 5;
/** Inset of the 4×5 window inside each 8×8 cell (centred on x, 1 px extra sill). */
const WIN_OX = 2;
const WIN_OY = 1;
const SEED = 7;
const LIT_PROB = 0.7;

/** Mulberry32: deterministic [0, 1) PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 64×64 nearest-filtered repeating window atlas (8×8 cells, seeded lights). */
export function makeWindowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');

  ctx.fillStyle = '#8c8c8c';
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  const rng = mulberry32(SEED);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      ctx.fillStyle = rng() < LIT_PROB ? '#ffffff' : '#2c2c2c';
      ctx.fillRect(col * CELL + WIN_OX, row * CELL + WIN_OY, WIN_W, WIN_H);
    }
  }

    const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Stone atlas size (px) — one UV unit of the building walls (24 m) spans this. */
const STONE_SIZE = 256;
/** Stone course height (px per `§4.23` running-bond row). */
const STONE_COURSE = 32;
/** Stone tile width (px): vertical joints stagger every 64 px. */
const STONE_TILE = 64;
const STONE_FILL = '#E6E2D8';
const STONE_MORTAR = '#C9C4B8';

/** Running-bond course index for a pixel row `y` (one course = 32 px). */
export function stoneCourseAt(y: number): number {
  return Math.floor(y / STONE_COURSE);
}

/** Horizontal offset (px) of the vertical joints within a course: 0/32 by parity. */
export function stoneJointOffset(course: number): number {
  return course % 2 === 0 ? 0 : STONE_COURSE;
}

/**
 * 256×256 nearest-filtered repeating running-bond stone atlas (§4.23
 * "Facade"): `#E6E2D8` fill, 1-px `#C9C4B8` mortar lines every 32 px
 * horizontally, vertical joints every 64 px staggered by 32 px on alternate
 * courses. Same wrap/filter settings as `makeWindowTexture`. Browser-only.
 */
export function makeStoneTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = STONE_SIZE;
  canvas.height = STONE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');

  ctx.fillStyle = STONE_FILL;
  ctx.fillRect(0, 0, STONE_SIZE, STONE_SIZE);

  ctx.fillStyle = STONE_MORTAR;
  // Horizontal mortar lines: course boundaries every 32 px (incl. row 0).
  for (let y = 0; y < STONE_SIZE; y += STONE_COURSE) {
    ctx.fillRect(0, y, STONE_SIZE, 1);
  }
  // Vertical joints: every 64 px, staggered 32 px on odd courses.
  for (let y = 0; y < STONE_SIZE; y += STONE_COURSE) {
    const offset = stoneJointOffset(stoneCourseAt(y));
    for (let x = offset; x < STONE_SIZE; x += STONE_TILE) {
      ctx.fillRect(x, y, 1, STONE_COURSE);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
