/**
 * Browser-only content atlas for the cyberpunk `ads` layer (T-0172): one
 * 2048² canvas, 16 portrait slots (256 × 512) and 8 landscape slots
 * (512 × 256), drawn once. Invented lore brands only — no real brands or
 * logos. Slot rects: `megaSlotUv` in `megaadsplace.ts`. Not imported by tests.
 */
import * as THREE from 'three/webgpu';
import {
  MEGA_ATLAS_SIZE,
  MEGA_LANDSCAPE_H,
  MEGA_LANDSCAPE_SLOTS,
  MEGA_LANDSCAPE_W,
  MEGA_LANDSCAPE_Y,
  MEGA_PORTRAIT_H,
  MEGA_PORTRAIT_SLOTS,
  MEGA_PORTRAIT_W,
} from './megaadsplace';

/** Invented brands (wordmark, slogan). */
const BRANDS: readonly [string, string][] = [
  ['NEUROCOLA', 'TASTE THE UPGRADE'],
  ['SYNTHLOVE', 'NEVER ALONE AGAIN'],
  ['YUKI-TEC', 'CHROME FOR LIFE'],
  ['ORBITAL AIR', 'LOW ORBIT. LOW FARES.'],
  ['DREAMCHIP', 'SLEEP IS OPTIONAL'],
  ['OMNIHEALTH', 'NEW ORGANS IN 24H'],
  ['KAGE MOTORS', 'DRIVE THE SHADOW'],
  ['HELIX BANK', 'YOUR DATA. OUR VAULT.'],
  ['VOIDWAVE', 'STREAM THE STATIC'],
  ['MIRAI NOODLE', 'EAT THE FUTURE'],
  ['ZEROGRAV', 'FEEL NOTHING'],
  ['PSYCORE', 'THINK FASTER'],
];

/** Katakana / kanji phrases (vertical on portrait slots). */
const CJK: readonly string[] = ['ネオン', '未来', '夢', '愛', '電脳', '光速', '無限'];

/** Per-city flavour lines. */
const FLAVOUR: Readonly<Record<string, readonly string[]>> = {
  kyiv: ['НЕОН', 'МРІЯ', 'СВІТЛО'],
  tokyo: ['新宿', '東京', '渋谷'],
};

/** Saturated palette: magenta, cyan, amber, acid green, hot red, violet, electric blue. */
const PALETTE: readonly string[] = ['#ff2a6d', '#05d9e8', '#ffb000', '#39ff14', '#ff073a', '#b967ff', '#2b6bff'];

const FONT = '"Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", "DejaVu Sans", sans-serif';

type Logo = 'circle' | 'triangle' | 'eye' | 'wave';
const LOGOS: readonly Logo[] = ['circle', 'triangle', 'eye', 'wave'];

let tex: THREE.CanvasTexture | null = null;
let texCity = '';

function col(i: number): string {
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? '#ff2a6d';
}

/** Text squeezed to `maxW` px at `px` size, centred at (x, y). */
function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, maxW: number, color: string, glow: number): void {
  c.font = `800 ${px}px ${FONT}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const w = Math.max(1, c.measureText(s).width);
  c.save();
  c.translate(x, y);
  if (w > maxW) c.scale(maxW / w, 1);
  c.shadowColor = color;
  c.shadowBlur = glow;
  c.fillStyle = color;
  c.fillText(s, 0, 0);
  c.shadowBlur = 0;
  c.fillStyle = '#ffffff';
  c.globalAlpha = 0.55;
  c.fillText(s, 0, 0);
  c.restore();
}

function logo(c: CanvasRenderingContext2D, kind: Logo, x: number, y: number, r: number, color: string): void {
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = Math.max(3, r * 0.14);
  c.shadowColor = color;
  c.shadowBlur = r * 0.5;
  c.beginPath();
  if (kind === 'circle') {
    c.arc(x, y, r, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(x, y, r * 0.45, 0, Math.PI * 2);
    c.fill();
  } else if (kind === 'triangle') {
    c.moveTo(x, y - r);
    c.lineTo(x + r * 0.9, y + r * 0.7);
    c.lineTo(x - r * 0.9, y + r * 0.7);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.moveTo(x, y - r * 0.3);
    c.lineTo(x + r * 0.35, y + r * 0.4);
    c.lineTo(x - r * 0.35, y + r * 0.4);
    c.closePath();
    c.fill();
  } else if (kind === 'eye') {
    c.moveTo(x - r, y);
    c.quadraticCurveTo(x, y - r * 0.9, x + r, y);
    c.quadraticCurveTo(x, y + r * 0.9, x - r, y);
    c.stroke();
    c.beginPath();
    c.arc(x, y, r * 0.3, 0, Math.PI * 2);
    c.fill();
  } else {
    for (let k = 0; k < 3; k++) {
      const yy = y - r * 0.5 + k * r * 0.5;
      c.moveTo(x - r, yy);
      for (let i = 0; i <= 16; i++) c.lineTo(x - r + (i / 16) * 2 * r, yy + Math.sin((i / 16) * Math.PI * 2) * r * 0.18);
    }
    c.stroke();
  }
  c.restore();
}

/** Stylised geometric face silhouette (profile of circles and polygons, nothing photographic). */
function face(c: CanvasRenderingContext2D, x: number, y: number, s: number, color: string): void {
  c.save();
  c.fillStyle = '#05040a';
  c.strokeStyle = color;
  c.lineWidth = 4;
  c.shadowColor = color;
  c.shadowBlur = 18;
  c.beginPath();
  // Head profile facing left: forehead, nose, lips, chin, neck.
  c.moveTo(x + s * 0.35, y - s * 0.9);
  c.lineTo(x - s * 0.15, y - s * 0.85);
  c.lineTo(x - s * 0.3, y - s * 0.35);
  c.lineTo(x - s * 0.45, y - s * 0.1);
  c.lineTo(x - s * 0.3, y + s * 0.02);
  c.lineTo(x - s * 0.36, y + s * 0.18);
  c.lineTo(x - s * 0.28, y + s * 0.3);
  c.lineTo(x - s * 0.1, y + s * 0.5);
  c.lineTo(x + s * 0.05, y + s * 0.95);
  c.lineTo(x + s * 0.6, y + s * 0.95);
  c.lineTo(x + s * 0.5, y + s * 0.3);
  c.lineTo(x + s * 0.6, y - s * 0.4);
  c.closePath();
  c.fill();
  c.stroke();
  // Cyber-eye and circuit lines.
  c.fillStyle = color;
  c.beginPath();
  c.arc(x - s * 0.1, y - s * 0.4, s * 0.05, 0, Math.PI * 2);
  c.fill();
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x - s * 0.05, y - s * 0.4);
  c.lineTo(x + s * 0.3, y - s * 0.4);
  c.lineTo(x + s * 0.4, y - s * 0.2);
  c.moveTo(x + s * 0.1, y + s * 0.1);
  c.lineTo(x + s * 0.45, y + s * 0.1);
  c.stroke();
  c.restore();
}

function background(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, a: string, b: string, vertical: boolean): void {
  c.fillStyle = '#040308';
  c.fillRect(x, y, w, h);
  const g = vertical ? c.createLinearGradient(x, y, x, y + h) : c.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, a);
  g.addColorStop(0.55, '#0a0612');
  g.addColorStop(1, b);
  c.globalAlpha = 0.75;
  c.fillStyle = g;
  // Dark margin all round: the marquee wraps and the glitch shifts within the slot.
  const m = 6;
  c.fillRect(x + m, y + m, w - 2 * m, h - 2 * m);
  c.globalAlpha = 1;
  c.strokeStyle = a;
  c.lineWidth = 4;
  c.strokeRect(x + m + 2, y + m + 2, w - 2 * m - 4, h - 2 * m - 4);
}

function drawPortrait(c: CanvasRenderingContext2D, slot: number, city: string): void {
  const x = (slot % (MEGA_ATLAS_SIZE / MEGA_PORTRAIT_W)) * MEGA_PORTRAIT_W;
  const y = Math.floor(slot / (MEGA_ATLAS_SIZE / MEGA_PORTRAIT_W)) * MEGA_PORTRAIT_H;
  const W = MEGA_PORTRAIT_W;
  const H = MEGA_PORTRAIT_H;
  const a = col(slot);
  const b = col(slot + 3);
  c.save();
  c.beginPath();
  c.rect(x, y, W, H);
  c.clip();
  background(c, x, y, W, H, a, b, true);
  const brand = BRANDS[slot % BRANDS.length] ?? ['NEUROCOLA', ''];
  const flavour = FLAVOUR[city];
  if (slot % 4 === 3) {
    // Vertical CJK / city-flavour column with a face silhouette.
    face(c, x + W * 0.55, y + H * 0.38, W * 0.42, a);
    const word = flavour && slot % 8 === 7 ? (flavour[slot % flavour.length] ?? '夢') : (CJK[slot % CJK.length] ?? '夢');
    const glyphs = Array.from(word);
    const gh = Math.min(70, (H * 0.36) / Math.max(1, glyphs.length));
    glyphs.forEach((g, i) => text(c, g, x + W * 0.16, y + H * 0.1 + (i + 0.5) * gh, gh * 0.9, W * 0.28, b, 14));
    text(c, brand[0], x + W / 2, y + H * 0.83, 40, W * 0.84, '#ffffff', 16);
    text(c, brand[1], x + W / 2, y + H * 0.91, 18, W * 0.84, b, 6);
  } else {
    logo(c, LOGOS[slot % LOGOS.length] ?? 'circle', x + W / 2, y + H * 0.3, W * 0.28, b);
    const words = brand[0].split(/[\s-]/);
    words.forEach((w, i) => text(c, w, x + W / 2, y + H * 0.58 + i * 56, 54, W * 0.86, a, 20));
    text(c, brand[1], x + W / 2, y + H * 0.84, 20, W * 0.84, '#ffffff', 8);
    const tag = flavour ? (flavour[slot % flavour.length] ?? '') : (CJK[(slot * 3) % CJK.length] ?? '');
    text(c, tag, x + W / 2, y + H * 0.92, 26, W * 0.6, b, 10);
  }
  c.restore();
}

function drawLandscape(c: CanvasRenderingContext2D, slot: number, city: string): void {
  const cols = MEGA_ATLAS_SIZE / MEGA_LANDSCAPE_W;
  const x = (slot % cols) * MEGA_LANDSCAPE_W;
  const y = MEGA_LANDSCAPE_Y + Math.floor(slot / cols) * MEGA_LANDSCAPE_H;
  const W = MEGA_LANDSCAPE_W;
  const H = MEGA_LANDSCAPE_H;
  const a = col(slot + 1);
  const b = col(slot + 4);
  c.save();
  c.beginPath();
  c.rect(x, y, W, H);
  c.clip();
  background(c, x, y, W, H, a, b, false);
  const brand = BRANDS[(slot + 5) % BRANDS.length] ?? ['NEUROCOLA', ''];
  if (slot % 4 === 1) face(c, x + W * 0.2, y + H * 0.5, H * 0.38, a);
  else logo(c, LOGOS[(slot + 1) % LOGOS.length] ?? 'eye', x + W * 0.18, y + H * 0.45, H * 0.26, b);
  text(c, brand[0], x + W * 0.6, y + H * 0.4, 72, W * 0.58, a, 22);
  text(c, brand[1], x + W * 0.6, y + H * 0.7, 26, W * 0.58, '#ffffff', 8);
  const flavour = FLAVOUR[city];
  const tag = flavour ? (flavour[slot % flavour.length] ?? '') : (CJK[slot % CJK.length] ?? '');
  text(c, tag, x + W * 0.6, y + H * 0.87, 24, W * 0.4, b, 8);
  c.restore();
}

/** The shared ads atlas for `cityId` (drawn once; redrawn only if the city changes). */
export function megaAdsAtlasTexture(cityId: string): THREE.CanvasTexture {
  if (tex && texCity === cityId) return tex;
  const cnv = tex ? (tex.image as HTMLCanvasElement) : document.createElement('canvas');
  cnv.width = MEGA_ATLAS_SIZE;
  cnv.height = MEGA_ATLAS_SIZE;
  const c = cnv.getContext('2d');
  if (!c) throw new Error('2d canvas context unavailable');
  c.fillStyle = '#040308';
  c.fillRect(0, 0, MEGA_ATLAS_SIZE, MEGA_ATLAS_SIZE);
  for (let i = 0; i < MEGA_PORTRAIT_SLOTS; i++) drawPortrait(c, i, cityId);
  for (let i = 0; i < MEGA_LANDSCAPE_SLOTS; i++) drawLandscape(c, i, cityId);
  if (!tex) {
    const t = new THREE.CanvasTexture(cnv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    // Mipmaps: screens are read from 50 m to across the city.
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    tex = t;
  }
  tex.needsUpdate = true;
  texCity = cityId;
  return tex;
}

/** Drop the atlas texture (layer dispose). */
export function disposeMegaAdsAtlas(): void {
  tex?.dispose();
  tex = null;
  texCity = '';
}
