/**
 * DOM wrapper for the green NAVIGATION panel. Browser-only (imports CSS).
 */
import './hud.css';
import { hudRow } from './format';

/** Snapshot of HUD row values passed to {@link Hud.update}. */
export interface HudValues {
  sector: string;
  world: string;
  bearing: string;
  zone: string;
  /** Metres above sea level, already formatted (`formatAlt`). Absent → no ALT row. */
  alt?: string;
  /** Mode label (e.g. `'FLY'`); absent → no MODE row. */
  mode?: string;
  landmark?: string;
  fps: number;
}

/** Renders title, the dotted rows, and the help line. */
export class Hud {
  private readonly rows: HTMLElement;
  private readonly root: HTMLElement;
  /** Original help line passed to the constructor (desktop or touch). */
  private readonly help: string;

  constructor(root: HTMLElement, help = 'WASD MOVE · MOUSE LOOK · SHIFT RUN · F FLY · R STYLE · P POSTCARD · ESC MENU') {
    const doc = root.ownerDocument;

    const title = doc.createElement('div');
    title.className = 'hud-title';
    title.textContent = '::: NAVIGATION';

    const rows = doc.createElement('pre');
    rows.className = 'hud-rows';

    // Third argument is the bare help string so existing tests (and the
    // compact-panel CSS that styles a following text node) keep working.
    root.append(title, rows, help);
    this.rows = rows;
    this.root = root;
    this.help = help;
  }

  /**
   * Swap `MOUSE LOOK` for `DRAG LOOK` on the desktop help line while
   * pointer-lock is unavailable (T-0091). The touch variant has neither
   * phrase and is left unchanged.
   */
  setDragLook(on: boolean): void {
    if (!this.help.includes('MOUSE LOOK')) return;
    const text = on
      ? this.help.replace('MOUSE LOOK', 'DRAG LOOK')
      : this.help;
    const node = this.root.childNodes[2];
    if (node) node.textContent = text;
  }

  /** Rewrite the row lines from `v`. Touches only `textContent`. */
  update(v: HudValues): void {
    const lines = [
      `> ${hudRow('SECTOR', v.sector)}`,
      `> ${hudRow('WORLD', v.world)}`,
      `> ${hudRow('BEARING', v.bearing)}`,
      `> ${hudRow('ZONE', v.zone)}`,
    ];
    if (v.alt !== undefined) lines.push(`> ${hudRow('ALT', v.alt)}`);
    lines.push(`> ${hudRow('LANDMARK', v.landmark ?? '-')}`);
    if (v.mode !== undefined) lines.push(`> ${hudRow('MODE', v.mode)}`);
    lines.push(`> ${hudRow('FPS', String(Math.round(v.fps)))}`);
    this.rows.textContent = lines.join('\n');
  }
}
