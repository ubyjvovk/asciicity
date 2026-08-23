/**
 * Browser-only window texture (docs/architecture.md §4.4). Safe to import in
 * node: nothing runs at module load; `makeWindowTexture` needs `document`.
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

  ctx.fillStyle = '#585858';
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  const rng = mulberry32(SEED);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      ctx.fillStyle = rng() < LIT_PROB ? '#ffffff' : '#404040';
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
