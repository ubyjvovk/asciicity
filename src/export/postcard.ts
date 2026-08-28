/**
 * Postcard capture (docs/architecture.md §4.15): after each frame a fresh
 * copy of the WebGL canvas is available, so `afterRender()` copies it onto an
 * offscreen 2d canvas and appends a 28-px caption bar, producing a PNG, or
 * samples 36 frames over 3 s into an animated GIF. The pure filename / layout
 * / schedule helpers are unit-tested in node; the capture itself is
 * browser-only.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

/** Height in px of the caption bar appended below the frame. */
export const CAPTION_HEIGHT = 28;

/** Horizontal padding between the caption text and the bar edges. */
export const CAPTION_PAD_X = 8;

/** Text baseline y within the caption bar. */
export const CAPTION_TEXT_Y = 20;

/** Max GIF width in px; wider canvases are scaled down, never up. */
export const GIF_MAX_WIDTH = 960;

/** Per-frame delay written into the GIF, in milliseconds. */
export const GIF_DELAY_MS = 83;

/**
 * City identity for a postcard: the registry id goes in the filename (no
 * spaces), the upper-cased label is painted on the caption bar.
 */
export interface PostcardMeta {
  /** Lower-case registry id used in the filename (e.g. `'sf'`, `'synthetic'`). */
  cityId: string;
  /** Upper-cased city label shown in the caption (e.g. `'SAN FRANCISCO'`). */
  cityLabel: string;
}

/** Axis-aligned rectangle in caption-canvas coordinates. */
export interface CaptionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Left/right caption text anchor (baseline x/y). */
export interface CaptionAnchor {
  x: number;
  y: number;
}

/** Pure caption-bar layout: the bar rect plus the two text anchors. */
export interface CaptionLayout {
  bar: CaptionRect;
  left: CaptionAnchor;
  right: CaptionAnchor;
}

/**
 * Layout the 28-px caption bar and its two text anchors for the given frame
 * width. `rightWidth` is the measured width of the right-hand URL text.
 */
export function captionLayout(width: number, rightWidth: number): CaptionLayout {
  return {
    bar: { x: 0, y: 0, width, height: CAPTION_HEIGHT },
    left: { x: CAPTION_PAD_X, y: CAPTION_TEXT_Y },
    right: { x: width - rightWidth - CAPTION_PAD_X, y: CAPTION_TEXT_Y },
  };
}

/** Zero-pad `n` to at least `len` digits (`toFixed`-style, no rounding). */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Postcard filename: `asciicity-<cityId>-<yyyymmdd-hhmmss>.<ext>` in the
 * viewer's local time. `cityId` is lower-cased; never pass the display label
 * (labels contain spaces). `ext` defaults to `'png'`.
 */
export function postcardFilename(cityId: string, date: Date, ext = 'png'): string {
  const ymd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  const hms = `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `asciicity-${cityId.toLowerCase()}-${ymd}-${hms}.${ext}`;
}

/** Left caption text: `ASCIICITY · <CITY LABEL>`. */
export function captionLeft(cityLabel: string): string {
  return `ASCIICITY · ${cityLabel}`;
}

/**
 * Wall-clock capture timestamps (ms from recording start) for a `durationMs`
 * clip at `fps`. Default 3 s · 12 fps → 36 times, `1000/12` ms apart.
 */
export function gifSchedule(durationMs = 3000, fps = 12): number[] {
  const n = Math.round((durationMs / 1000) * fps);
  const step = 1000 / fps;
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push(i * step);
  return times;
}

/**
 * GIF downscale factor: `min(1, GIF_MAX_WIDTH / canvasWidth)` so 1920 → 0.5
 * and 800 → 1.
 */
export function gifScale(canvasWidth: number): number {
  return Math.min(1, GIF_MAX_WIDTH / canvasWidth);
}

/** Handle returned by `createPostcard`. */
export interface Postcard {
  /**
   * Per-frame hook: copy the rendered canvas now if a capture is pending.
   * Must be called in the same task as the render, because the WebGL canvas
   * is not preserved between frames.
   */
  afterRender(): void;
  /**
   * Capture the next rendered frame as a PNG (optionally downloading it).
   * Resolves from the next `afterRender`; repeated calls before that resolve
   * share the same pending capture.
   */
  snapPng(download?: boolean): Promise<Blob>;
  /**
   * Record 3 s · 12 fps · ≤ 960 px wide animated GIF (optionally downloading
   * it). Re-entrant calls while a recording is in flight resolve the same
   * promise; a new recording can start only after that one settles.
   */
  recordGif(download?: boolean): Promise<Blob>;
}

/** One waiter on a pending capture. */
interface Waiter {
  resolve: (blob: Blob) => void;
  reject: (err: unknown) => void;
  download: boolean;
}

/** A pending capture awaiting the next `afterRender`. */
interface Pending {
  waiters: Waiter[];
}

/** One RGBA frame waiting to be encoded into the GIF. */
interface GifFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** In-flight GIF recording sampled from `afterRender`. */
interface GifRecording {
  t0: number | null;
  schedule: number[];
  next: number;
  frames: GifFrame[];
  download: boolean;
  resolve: (blob: Blob) => void;
  reject: (err: unknown) => void;
}

/** Trigger a browser download of `blob` as `filename` via a temp `<a>`. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke after the current task so the browser has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Paint the caption bar (fill, border, left/right text) onto `ctx` in the
 * current transform. Callers translate to `(0, canvasH)` first so the bar
 * sits below the frame rather than covering its top 28 px.
 */
function paintCaption(ctx: CanvasRenderingContext2D, width: number, meta: PostcardMeta): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, CAPTION_HEIGHT);
  ctx.fillStyle = '#333';
  ctx.fillRect(0, 0, width, 1);
  ctx.font = `14px "DejaVu Sans Mono", monospace`;
  ctx.textBaseline = 'alphabetic';
  const leftText = captionLeft(meta.cityLabel);
  const rightText = 'ubyjvovk.github.io/asciicity';
  const rightWidth = ctx.measureText(rightText).width;
  const layout = captionLayout(width, rightWidth);
  ctx.fillStyle = '#ffb000';
  ctx.fillText(leftText, layout.left.x, layout.left.y);
  ctx.fillStyle = '#7a7a7a';
  ctx.fillText(rightText, layout.right.x, layout.right.y);
}

/** Quantize each captured frame and write an infinite-loop 12 fps GIF. */
function encodeGif(frames: GifFrame[]): Blob {
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const palette = quantize(frame.data, 256, { format: 'rgb565' });
    const index = applyPalette(frame.data, palette);
    gif.writeFrame(index, frame.width, frame.height, {
      palette,
      delay: GIF_DELAY_MS,
      ...(i === 0 ? { repeat: 0 } : {}),
    });
  }
  gif.finish();
  // Copy into a fresh ArrayBuffer-backed view so the Blob constructor's
  // `BlobPart` (ArrayBuffer, not ArrayBufferLike) accepts it under TS 5.9.
  const bytes = gif.bytes();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: 'image/gif' });
}

class PostcardImpl implements Postcard {
  private pending: Pending | null = null;
  private gifRec: GifRecording | null = null;
  private gifPromise: Promise<Blob> | null = null;
  private gifOffscreen: HTMLCanvasElement | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly meta: () => PostcardMeta,
    private readonly toast: (msg: string) => void,
  ) {}

  afterRender(): void {
    this.flushPng();
    this.sampleGif();
  }

  /** Resolve a pending PNG capture from the just-rendered canvas. */
  private flushPng(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const fail = (err: unknown): void => {
      for (const w of p.waiters) w.reject(err);
    };
    const w = this.canvas.width;
    const h = this.canvas.height;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h + CAPTION_HEIGHT;
    const ctx = out.getContext('2d');
    if (!ctx) {
      fail(new Error('postcard: 2d context unavailable'));
      return;
    }
    const info = this.meta();
    ctx.drawImage(this.canvas, 0, 0, w, h);
    // Bar sits BELOW the frame — painting in origin coords would cover the
    // top 28 px and leave the extra rows empty.
    ctx.save();
    ctx.translate(0, h);
    paintCaption(ctx, w, info);
    ctx.restore();
    const wantDownload = p.waiters.some((w) => w.download);
    out.toBlob((blob) => {
      if (!blob) {
        fail(new Error('postcard: toBlob produced no PNG'));
        return;
      }
      if (wantDownload) {
        downloadBlob(blob, postcardFilename(info.cityId, new Date()));
        this.toast('POSTCARD SAVED');
      }
      for (const waiter of p.waiters) waiter.resolve(blob);
    }, 'image/png');
  }

  /**
   * Pull GIF frames on the 83.3 ms wall-clock schedule. A slow machine
   * duplicates the current canvas so the clip still has 36 frames; a fast
   * one skips in-between renders.
   */
  private sampleGif(): void {
    const rec = this.gifRec;
    if (!rec) return;
    if (rec.t0 === null) rec.t0 = performance.now();
    const elapsed = performance.now() - rec.t0;
    while (rec.next < rec.schedule.length && elapsed >= rec.schedule[rec.next]!) {
      const frame = this.grabGifFrame();
      if (!frame) {
        this.gifRec = null;
        rec.reject(new Error('postcard: 2d context unavailable'));
        return;
      }
      rec.frames.push(frame);
      rec.next++;
    }
    if (rec.next < rec.schedule.length) return;
    this.gifRec = null;
    this.toast('ENCODING…');
    try {
      const blob = encodeGif(rec.frames);
      if (rec.download) {
        const info = this.meta();
        downloadBlob(blob, postcardFilename(info.cityId, new Date(), 'gif'));
        this.toast('POSTCARD SAVED');
      }
      rec.resolve(blob);
    } catch (err) {
      rec.reject(err);
    }
  }

  /**
   * Scale the live canvas (never upscale), paint the caption bar below it,
   * and return the RGBA pixels. Reuses one offscreen canvas across frames.
   */
  private grabGifFrame(): GifFrame | null {
    const src = this.canvas;
    const scale = gifScale(src.width);
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const outW = w;
    const outH = h + CAPTION_HEIGHT;
    let off = this.gifOffscreen;
    if (!off || off.width !== outW || off.height !== outH) {
      off = document.createElement('canvas');
      off.width = outW;
      off.height = outH;
      this.gifOffscreen = off;
    }
    const ctx = off.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, w, h);
    ctx.save();
    ctx.translate(0, h);
    paintCaption(ctx, w, this.meta());
    ctx.restore();
    const img = ctx.getImageData(0, 0, outW, outH);
    return { data: img.data, width: outW, height: outH };
  }

  snapPng(download = true): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      if (this.pending) {
        this.pending.waiters.push({ resolve, reject, download });
        return;
      }
      this.pending = { waiters: [{ resolve, reject, download }] };
    });
  }

  recordGif(download = true): Promise<Blob> {
    if (this.gifPromise) return this.gifPromise;
    this.toast('REC ●');
    const promise = new Promise<Blob>((resolve, reject) => {
      this.gifRec = {
        t0: null,
        schedule: gifSchedule(),
        next: 0,
        frames: [],
        download,
        resolve,
        reject,
      };
    });
    this.gifPromise = promise;
    void promise.finally(() => {
      if (this.gifPromise === promise) this.gifPromise = null;
    });
    return promise;
  }
}

/**
 * Create a `Postcard` bound to the given WebGL canvas. `meta` is called when a
 * capture lands to label the frame's city; `toast` reports `POSTCARD SAVED`
 * only when at least one waiter requested a download, plus `REC ●` /
 * `ENCODING…` around a GIF recording.
 */
export function createPostcard(
  canvas: HTMLCanvasElement,
  meta: () => PostcardMeta,
  toast: (msg: string) => void,
): Postcard {
  return new PostcardImpl(canvas, meta, toast);
}
