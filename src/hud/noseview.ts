/**
 * NOSEVIEW HUD skin for the `retrocgi` render style (docs/architecture.md
 * §4.11 "`retrocgi` (wave 19)"): title, reticle and the `ALT.` / `AIR..`
 * readouts of a 1981 glider display. Browser-only (imports CSS). Visibility
 * is pure CSS, keyed on `body[data-render="retrocgi"]` (main.ts keeps that
 * attribute equal to the active style id). STUB until T-0150: the interface
 * below is locked and already wired into main.ts; T-0150 fills it in.
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

/** DOM wrapper for the `#noseview` overlay. */
export class Noseview {
  constructor(root: HTMLElement) {
    root.setAttribute('aria-hidden', 'true');
  }

  /** Refresh the readouts. Called every HUD tick while `retrocgi` is active. */
  update(_v: NoseviewValues): void {
    // T-0150
  }
}
