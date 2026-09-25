/**
 * Browser-only glyph atlas for cyberpunk neon signs (wave 20b, v2 wave 23b).
 * One 2048² canvas, 128 landscape slots of 256 × 128 px (8 × 16). Contract:
 * docs/architecture.md §4.11 "Neon signs" / "Neon v2". Slot bookkeeping is
 * the pure {@link NeonSlotTable} in `neonplace.ts`. Not imported by unit tests.
 */
import * as THREE from 'three/webgpu';
import {
  NEON_ATLAS_COLS,
  NEON_ATLAS_SIZE,
  NEON_SLOT_H,
  NEON_SLOT_W,
  NeonSlotTable,
  neonAtlasKey,
  neonSlotRotated,
  neonSlotUv,
  parseNeonAtlasKey,
  type SignKind,
  type SlotUv,
} from './neonplace';

let ctx2d: CanvasRenderingContext2D | null = null;
let tex: THREE.CanvasTexture | null = null;
const table = new NeonSlotTable();

function ensure(): CanvasRenderingContext2D {
  if (ctx2d && tex) return ctx2d;
  const cnv = document.createElement('canvas');
  cnv.width = NEON_ATLAS_SIZE;
  cnv.height = NEON_ATLAS_SIZE;
  const c = cnv.getContext('2d');
  if (!c) throw new Error('2d canvas context unavailable');
  c.fillStyle = '#07060a';
  c.fillRect(0, 0, NEON_ATLAS_SIZE, NEON_ATLAS_SIZE);
  const texture = new THREE.CanvasTexture(cnv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
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

/** Slots actually drawn (≤ 128). Overflow keys alias an existing slot and are not counted twice. */
export function neonAtlasSlotCount(): number {
  return table.drawn;
}

/** Drop the canvas and the slot table (layer dispose). */
export function disposeNeonAtlas(): void {
  tex?.dispose();
  tex = null;
  ctx2d = null;
  table.clear();
}

/** CJK first (generic stack, no bundled font); the last entries still render Latin/Cyrillic and tofu-free fallbacks. */
const FONT = '"Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", "DejaVu Sans", sans-serif';

/**
 * Two-pass tube lettering centred at the current origin: a wide glow in the
 * text colour, then a thin near-white core. `pixelW` is the target width.
 */
function paintText(ctx: CanvasRenderingContext2D, text: string, pixelH: number, pixelW: number, color: string): void {
  ctx.font = `700 ${pixelH}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const natural = Math.max(1, ctx.measureText(text).width);
  ctx.save();
  ctx.scale(pixelW / natural, 1);
  ctx.shadowColor = color;
  ctx.shadowBlur = Math.max(6, pixelH * 0.4);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#f4f7ff';
  ctx.font = `600 ${pixelH * 0.62}px ${FONT}`;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** Nominal face aspect (width / height) per kind — used to pre-squash glyphs so they read upright on the face. */
const NOMINAL: Record<SignKind, number> = { blade: 1 / 5, panel: 3.5, stack: 1.6 / 0.9, screen: 1.5 };

function drawSlot(ctx: CanvasRenderingContext2D, slot: number, key: string): void {
  const x = (slot % NEON_ATLAS_COLS) * NEON_SLOT_W;
  const y = Math.floor(slot / NEON_ATLAS_COLS) * NEON_SLOT_H;
  const W = NEON_SLOT_W;
  const H = NEON_SLOT_H;
  const { kind, word, text, border } = parseNeonAtlasKey(key);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, W, H);
  ctx.clip();
  ctx.fillStyle = '#07060a';
  ctx.fillRect(x, y, W, H);

  const screen = kind === 'screen';
  if (screen) {
    // Static facade screen: a gradient block between the two colours, dimmed so the word reads.
    const g = ctx.createLinearGradient(x, y, x + W, y + H);
    g.addColorStop(0, text);
    g.addColorStop(1, border);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = g;
    ctx.fillRect(x + 6, y + 6, W - 12, H - 12);
    ctx.globalAlpha = 1;
  }

  const inset = screen ? 4 : 10;
  ctx.beginPath();
  ctx.roundRect(x + inset, y + inset, W - inset * 2, H - inset * 2, screen ? 6 : 18);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = border;
  ctx.lineWidth = screen ? 5 : 9;
  ctx.shadowColor = border;
  ctx.shadowBlur = 16;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#f7f8ff';
  ctx.lineWidth = 2;
  ctx.stroke();

  const glyphs = Array.from(word);
  const n = Math.max(1, glyphs.length);
  if (neonSlotRotated(kind)) {
    // Portrait glyph column rotated into the landscape slot: face top → slot
    // left, face right → slot top (see `buildNeonMeshes`). Each glyph is
    // rotated −90° so it reads upright on the face.
    const cellA = W / n;
    const faceScale = (W / H) * NOMINAL.blade; // on-face stretch of slot-a vs slot-b pixels
    for (let i = 0; i < glyphs.length; i++) {
      ctx.save();
      ctx.translate(x + (i + 0.5) * cellA, y + H / 2);
      ctx.rotate(-Math.PI / 2);
      const gh = cellA * 0.8;
      const gw = Math.min(H * 0.8, gh / faceScale);
      paintText(ctx, glyphs[i] ?? '', gh, gw, text);
      ctx.restore();
    }
  } else {
    // A glyph g × g metres on a face of the nominal aspect spans g·W/fw by g·H/fh pixels.
    const pixRatio = (0.85 * (W / H)) / NOMINAL[kind];
    const gh = Math.min(H * (screen ? 0.62 : 0.66), (W * 0.84) / (n * pixRatio));
    ctx.save();
    ctx.translate(x + W / 2, y + H / 2);
    paintText(ctx, word, gh, n * gh * pixRatio, text);
    ctx.restore();
  }
  ctx.restore();
  if (tex) tex.needsUpdate = true;
}

/**
 * UV rect for one sign face. The first 128 distinct `kind|word|text|border`
 * keys each get a slot; later keys reuse `hash(key) % 128` (no eviction).
 */
export function getSlotUv(kind: SignKind, word: string, text: string, border: string): SlotUv {
  const ctx = ensure();
  const key = neonAtlasKey(kind, word, text, border);
  const { slot, fresh } = table.slotFor(key);
  if (fresh) drawSlot(ctx, slot, key);
  return neonSlotUv(slot, neonSlotRotated(kind));
}
