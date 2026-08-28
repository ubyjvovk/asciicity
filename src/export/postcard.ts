/**
 * Postcard capture (docs/architecture.md §4.15): after each frame a fresh
 * copy of the WebGL canvas is available, so `afterRender()` copies it onto an
 * offscreen 2d canvas and appends a 28-px caption bar, producing a PNG. The
 * pure filename / layout helpers are unit-tested in node; the capture itself
 * is browser-only.
 */

/** Height in px of the caption bar appended below the frame. */
export const CAPTION_HEIGHT = 28;

/** Horizontal padding between the caption text and the bar edges. */
export const CAPTION_PAD_X = 8;

/** Text baseline y within the caption bar. */
export const CAPTION_TEXT_Y = 20;

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
 * Postcard PNG filename: `asciicity-<cityId>-<yyyymmdd-hhmmss>.png` in the
 * viewer's local time. `cityId` is lower-cased; never pass the display label
 * (labels contain spaces).
 */
export function postcardFilename(cityId: string, date: Date): string {
  const ymd = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
  const hms = `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `asciicity-${cityId.toLowerCase()}-${ymd}-${hms}.png`;
}

/** Left caption text: `ASCIICITY · <CITY LABEL>`. */
export function captionLeft(cityLabel: string): string {
  return `ASCIICITY · ${cityLabel}`;
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

class PostcardImpl implements Postcard {
  private pending: Pending | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly meta: () => PostcardMeta,
    private readonly toast: (msg: string) => void,
  ) {}

  afterRender(): void {
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

  snapPng(download = true): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      if (this.pending) {
        this.pending.waiters.push({ resolve, reject, download });
        return;
      }
      this.pending = { waiters: [{ resolve, reject, download }] };
    });
  }
}

/**
 * Create a `Postcard` bound to the given WebGL canvas. `meta` is called when a
 * capture lands to label the frame's city; `toast` reports `POSTCARD SAVED`
 * only when at least one waiter requested a download.
 */
export function createPostcard(
  canvas: HTMLCanvasElement,
  meta: () => PostcardMeta,
  toast: (msg: string) => void,
): Postcard {
  return new PostcardImpl(canvas, meta, toast);
}
