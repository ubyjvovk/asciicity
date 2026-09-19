/**
 * NOSEVIEW HUD skin for the `retrocgi` render style (docs/architecture.md
 * §4.11 "`retrocgi` (wave 19)"): title, reticle and the `ALT.` / `AIR..`
 * readouts of a 1981 glider display. Browser-only (imports CSS). Visibility
 * is pure CSS, keyed on `body[data-render="retrocgi"]` (main.ts keeps that
 * attribute equal to the active style id).
 */
import './noseview.css';

/** Per-update inputs; main.ts reuses one object (no per-frame allocation). */
export interface NoseviewValues {
  /** Eye altitude in metres: above sea level on terrain cities, else above ground. */
  altM: number;
  /** Player world position in metres (the pair `AIR..` is derived from). */
  x: number;
  z: number;
  /** Seconds since start (monotonic), for the airspeed derivative. */
  timeS: number;
}

/** Round a metres altitude to a whole-metre string, clamped at 0 (no unit, no padding). */
export function formatNvAlt(altM: number): string {
  return String(Math.max(0, Math.round(altM)));
}

/** Convert a horizontal metres/second speed to a knots string (×1.944, rounded, no padding). */
export function formatNvAir(speedMs: number): string {
  return String(Math.round(speedMs * 1.944));
}

/**
 * Horizontal metres per second between two updates; 0 on the first update,
 * when `dt ≤ 0`, or when `dt > 1 s` (teleport / tab sleep).
 */
export function nvSpeed(
  prev: { x: number; z: number; timeS: number } | undefined,
  cur: { x: number; z: number; timeS: number },
): number {
  if (prev === undefined) return 0;
  const dt = cur.timeS - prev.timeS;
  if (dt <= 0 || dt > 1) return 0;
  const dx = cur.x - prev.x;
  const dz = cur.z - prev.z;
  return Math.hypot(dx, dz) / dt;
}

/** DOM wrapper for the `#noseview` overlay. */
export class Noseview {
  private readonly alt: HTMLElement;
  private readonly air: HTMLElement;
  /** Reused sample objects so `update` never allocates. */
  private readonly prev: { x: number; z: number; timeS: number };
  private readonly cur: { x: number; z: number; timeS: number };
  private hasPrev = false;
  /** Smoothed airspeed (m/s); `shown += (raw − shown) · 0.35` per update. */
  private shown = 0;

  constructor(root: HTMLElement) {
    root.setAttribute('aria-hidden', 'true');
    const doc = root.ownerDocument;
    const mk = (className: string, text = ''): HTMLElement => {
      const el = doc.createElement('div');
      el.className = className;
      el.textContent = text;
      return el;
    };
    this.alt = mk('nv-alt', 'ALT. 0');
    this.air = mk('nv-air', 'AIR.. 0');
    root.append(
      mk('nv-title', 'NOSEVIEW'),
      this.alt,
      this.air,
      mk('nv-v'),
      mk('nv-h'),
      mk('nv-box'),
      mk('nv-tick-l'),
      mk('nv-tick-r'),
    );
    this.prev = { x: 0, z: 0, timeS: 0 };
    this.cur = { x: 0, z: 0, timeS: 0 };
  }

  /** Refresh the readouts. Called every HUD tick while `retrocgi` is active. */
  update(v: NoseviewValues): void {
    this.alt.textContent = `ALT. ${formatNvAlt(v.altM)}`;
    this.cur.x = v.x;
    this.cur.z = v.z;
    this.cur.timeS = v.timeS;
    const raw = nvSpeed(this.hasPrev ? this.prev : undefined, this.cur);
    this.prev.x = this.cur.x;
    this.prev.z = this.cur.z;
    this.prev.timeS = this.cur.timeS;
    this.hasPrev = true;
    this.shown += (raw - this.shown) * 0.35;
    this.air.textContent = `AIR.. ${formatNvAir(this.shown)}`;
  }
}
