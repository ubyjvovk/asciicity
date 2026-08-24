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
  landmark?: string;
  fps: number;
}

/** Renders title, six dotted rows, and the help line into a root element. */
export class Hud {
  private readonly rows: HTMLElement;

  constructor(root: HTMLElement, help = 'WASD MOVE · MOUSE LOOK · SHIFT RUN') {
    const doc = root.ownerDocument;

    const title = doc.createElement('div');
    title.className = 'hud-title';
    title.textContent = '::: NAVIGATION';

    const rows = doc.createElement('pre');
    rows.className = 'hud-rows';

    const helpEl = doc.createElement('div');
    helpEl.className = 'hud-help';
    helpEl.textContent = help;

    root.append(title, rows, help);
    this.rows = rows;
  }

  /** Replace the six row lines from `v`. Touches only `textContent`. */
  update(v: HudValues): void {
    this.rows.textContent = [
      `> ${hudRow('SECTOR', v.sector)}`,
      `> ${hudRow('WORLD', v.world)}`,
      `> ${hudRow('BEARING', v.bearing)}`,
      `> ${hudRow('ZONE', v.zone)}`,
      `> ${hudRow('LANDMARK', v.landmark ?? '-')}`,
      `> ${hudRow('FPS', String(Math.round(v.fps)))}`,
    ].join('\n');
  }
}
