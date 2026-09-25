/**
 * Browser-only glyph atlas for cyberpunk neon signs (wave 20b).
 * One 2048² canvas, at most 64 slots. Contract: docs/architecture.md §4.11
 * "Neon signs". Not imported by unit tests.
 */
import * as THREE from 'three/webgpu';

const ATLAS = 2048;
const GRID = 8;
const SLOT = ATLAS / GRID;
const MAX_SLOTS = GRID * GRID;

/** UV rectangle of one atlas slot. `v0` is the bottom, `v1` the top (flipY upload). */
export interface SlotUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Atlas key `kind|word|color`. */
export function neonAtlasKey(kind: string, word: string, color: string): string {
  return `${kind}|${word}|${color}`;
}

let canvas: HTMLCanvasElement | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let tex: THREE.CanvasTexture | null = null;
const keySlot = new Map<string, number>();
let drawn = 0;

function hashKey(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function uvOf(slot: number): SlotUv {
  const col = slot % GRID;
  const row = Math.floor(slot / GRID);
  return {
    u0: col / GRID,
    u1: (col + 1) / GRID,
    v1: 1 - row / GRID,
    v0: 1 - (row + 1) / GRID,
  };
}

function ensure(): CanvasRenderingContext2D {
  if (ctx2d && tex) return ctx2d;
  const cnv = document.createElement('canvas');
  cnv.width = ATLAS;
  cnv.height = ATLAS;
  const c = cnv.getContext('2d');
  if (!c) throw new Error('2d canvas context unavailable');
  c.fillStyle = '#07060a';
  c.fillRect(0, 0, ATLAS, ATLAS);
  const texture = new THREE.CanvasTexture(cnv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  canvas = cnv;
  ctx2d = c;
  tex = texture;
  return c;
}

/** Shared 2048² sign atlas (sRGB). Created on first use. */
export function neonAtlasTexture(): THREE.CanvasTexture {
  ensure();
  if (!tex) throw new Error('neon atlas texture missing');
  return tex;
}

/** Slots actually drawn (≤ 64). Overflow keys alias an existing slot and are not counted twice. */
export function neonAtlasSlotCount(): number {
  return drawn;
}

/** Drop the canvas and the slot table (layer dispose). */
export function disposeNeonAtlas(): void {
  tex?.dispose();
  tex = null;
  canvas = null;
  ctx2d = null;
  keySlot.clear();
  drawn = 0;
}

const FONT = '"DejaVu Sans", "Noto Sans CJK JP", "Noto Sans JP", sans-serif';

function paintText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  pixelH: number,
  pixelW: number,
  color: string,
): void {
  ctx.font = `700 ${pixelH}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const natural = Math.max(1, ctx.measureText(text).width);
  const scaleX = pixelW / natural;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scaleX, 1);
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(8, pixelH * 0.45);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#f4f7ff';
  ctx.font = `600 ${pixelH * 0.62}px ${FONT}`;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawSlot(ctx: CanvasRenderingContext2D, slot: number, key: string): void {
  const col = slot % GRID;
  const row = Math.floor(slot / GRID);
  const x = col * SLOT;
  const y = row * SLOT;
  const parts = key.split('|');
  const kind = parts[0] ?? 'panel';
  const word = parts[1] ?? '';
  const color = parts[2] ?? '#ff2a6d';
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, SLOT, SLOT);
  ctx.clip();
  ctx.fillStyle = '#07060a';
  ctx.fillRect(x, y, SLOT, SLOT);

  const inset = 16;
  ctx.beginPath();
  ctx.roundRect(x + inset, y + inset, SLOT - inset * 2, SLOT - inset * 2, 26);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = 12;
  ctx.shadowColor = color;
  ctx.shadowBlur = 22;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#f7f8ff';
  ctx.lineWidth = 3;
  ctx.stroke();

  const glyphs = Array.from(word);
  if (kind === 'blade') {
    const n = Math.max(1, glyphs.length);
    const rowH = SLOT / n;
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i] ?? '';
      const gh = rowH * 0.78;
      paintText(ctx, glyph, x + SLOT / 2, y + (i + 0.5) * rowH, gh, SLOT * 0.84, color);
    }
  } else {
    // Square slot is stretched onto a wide panel; draw the word tall and narrow
    // so a nominal ~3.5:1 panel keeps letterforms readable.
    const n = Math.max(1, glyphs.length);
    const nominal = 3.5;
    const pixRatio = 0.85 / nominal;
    const gh = Math.min(SLOT * 0.72, (SLOT * 0.88) / (n * pixRatio));
    paintText(ctx, word, x + SLOT / 2, y + SLOT / 2, gh, n * gh * pixRatio, color);
  }
  ctx.restore();
  if (tex) tex.needsUpdate = true;
}

/**
 * UV rect for `kind|word|color`. The first 64 distinct keys each get a slot;
 * later keys reuse `hash(key) % 64` and do not evict the occupant (no LRU).
 */
export function getSlotUv(key: string): SlotUv {
  const ctx = ensure();
  const existing = keySlot.get(key);
  if (existing !== undefined) return uvOf(existing);
  let slot: number;
  if (drawn < MAX_SLOTS) {
    slot = drawn;
    drawn += 1;
    keySlot.set(key, slot);
    drawSlot(ctx, slot, key);
  } else {
    slot = hashKey(key) % MAX_SLOTS;
    keySlot.set(key, slot);
  }
  return uvOf(slot);
}
