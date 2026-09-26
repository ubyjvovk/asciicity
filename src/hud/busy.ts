/**
 * Background-loading indicator — pure part (T-0171, docs/hud-busy.md).
 * Turns the loader sources (streamed tiles, the cyberpunk engine, cyberpunk
 * layer cells, car models) into one retro-terminal status line and gates it
 * with show/hide hysteresis. No DOM, no three. Since T-0174 it also words
 * the boot phases (`bootLine`: JACK-IN / DECRYPT / COMPILE) shown from the
 * first paint until `ready`.
 */

import type { LoadProgress } from '../ui/loading';

/** Braille spinner frames, one per {@link SPINNER_MS}. */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Milliseconds per spinner frame. */
export const SPINNER_MS = 80;
/** Cells in the indeterminate bar. */
export const BAR_CELLS = 8;
/** Milliseconds per bar step (the lit block moves one cell). */
export const BAR_MS = 120;
/** Minimum milliseconds between two reads of the loader sources. */
export const POLL_MS = 250;

/** Width of the lit `▰` block inside the bar. */
const BAR_BLOCK = 3;

/** What is loading in the background right now. */
export interface BusyInputs {
  /** Streamed city tiles in flight (`TileManager.pending()`). */
  tilesPending: number;
  /** The lazily imported cyberpunk engine is still loading. */
  engineLoading: boolean;
  /** Sum of every cyberpunk `*.pending` stats key (layer cells not built yet). */
  cellsPending: number;
  /** The cyberpunk car models are loading. */
  carsLoading: boolean;
}

/** Build {@link BusyInputs} from the tile count, `punk.status` and `punk.stats()`. */
export function busyInputsFromStats(
  tilesPending: number,
  engineStatus: string,
  stats: Readonly<Record<string, number>>,
): BusyInputs {
  let cellsPending = 0;
  for (const key in stats) {
    if (key.endsWith('.pending')) cellsPending += stats[key];
  }
  const carsLoading =
    (stats['vehicles.on'] === 1 && stats['vehicles.ready'] !== 1) ||
    (stats['vehicles.loading'] ?? 0) > 0;
  return {
    tilesPending,
    engineLoading: engineStatus === 'loading',
    cellsPending,
    carsLoading,
  };
}

/** Active items joined by ` · ` (`SECTORS n · NEON GRID · CELLS n · CARS`), `''` when idle. */
export function busyLabel(i: BusyInputs): string {
  const parts: string[] = [];
  if (i.tilesPending > 0) parts.push(`SECTORS ${i.tilesPending}`);
  if (i.engineLoading) parts.push('NEON GRID');
  if (i.cellsPending > 0) parts.push(`CELLS ${i.cellsPending}`);
  if (i.carsLoading) parts.push('CARS');
  return parts.join(' · ');
}

/** Spinner frame at time `tMs`. */
export function busySpinner(tMs: number): string {
  const n = SPINNER_FRAMES.length;
  const k = Math.floor(Math.max(0, tMs) / SPINNER_MS) % n;
  return SPINNER_FRAMES[k];
}

/** Indeterminate bar at time `tMs`: a 3-cell `▰` block ping-ponging across 8 `▱` cells. */
export function busyBar(tMs: number): string {
  const span = BAR_CELLS - BAR_BLOCK; // last start cell
  const period = 2 * span;
  const k = Math.floor(Math.max(0, tMs) / BAR_MS) % period;
  const start = k <= span ? k : period - k;
  let s = '';
  for (let c = 0; c < BAR_CELLS; c++) s += c >= start && c < start + BAR_BLOCK ? '▰' : '▱';
  return s;
}

/** Verb for the line: `BOOT` while the cyberpunk engine loads, else `SYNC`. */
export function busyVerb(i: BusyInputs): string {
  return i.engineLoading ? 'BOOT' : 'SYNC';
}

/** Full status line (spinner, verb, bar, label unless `narrow`), `''` when idle. */
export function busyLine(i: BusyInputs, tMs: number, narrow: boolean): string {
  const label = busyLabel(i);
  if (label === '') return '';
  const head = `${busySpinner(tMs)} ${busyVerb(i)} ${busyBar(tMs)}`;
  return narrow ? head : `${head} ${label}`;
}

/**
 * Show/hide hysteresis: shows once busy has been continuously true for
 * `showAfterMs`, and hides only after it has been idle for `holdMs`.
 */
export class BusyGate {
  private busySince: number | null = null;
  private idleSince: number | null = null;
  private shown = false;

  /** `showAfterMs` of continuous busy before showing; `holdMs` idle before hiding. */
  constructor(
    private readonly showAfterMs = 300,
    private readonly holdMs = 600,
  ) {}

  /** Feed the current busy state at time `tMs`; returns whether to show. */
  step(busy: boolean, tMs: number): boolean {
    if (busy) {
      this.idleSince = null;
      if (this.busySince === null) this.busySince = tMs;
      if (tMs - this.busySince >= this.showAfterMs) this.shown = true;
    } else {
      this.busySince = null;
      if (this.shown) {
        if (this.idleSince === null) this.idleSince = tMs;
        if (tMs - this.idleSince >= this.holdMs) {
          this.shown = false;
          this.idleSince = null;
        }
      }
    }
    return this.shown;
  }

  /** Mark the line as already shown at `tMs` (boot → background handover): idle now hides after `holdMs`. */
  force(tMs: number): void {
    this.shown = true;
    this.busySince = tMs;
    this.idleSince = null;
  }
}

/** Megabytes for the boot `DOWNLINK x.x/y.y MB` readout (matches `formatLoading`). */
const MB = 1_000_000;

/** One boot line split into the three `BusyView` spans (T-0174). */
export interface BootParts {
  /** Boot verb: `JACK-IN`, `DECRYPT` or `COMPILE`. */
  verb: string;
  /** 8-cell bar: determinate while downloading, else ping-pong. */
  bar: string;
  /** Label: `LINKING NODE`, `DOWNLINK x.x/y.y MB`, `CITYGRID <CITY>`, the build step or the city. */
  label: string;
}

/** Determinate 8-cell bar: `floor(received·8/total)` cells lit, clamped. */
export function bootBar(received: number, total: number): string {
  const t = Math.max(1, total);
  const r = Math.max(0, Math.min(received, total));
  const filled = Math.min(BAR_CELLS, Math.floor((r * BAR_CELLS) / t));
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled);
}

/**
 * Boot verb/bar/label for a pre-`ready` progress snapshot; `p === null`
 * (no progress event yet) is the static `JACK-IN … LINKING NODE` line.
 * `ready` has no boot parts (returns `null`) — use {@link busyLine}.
 */
export function bootParts(p: LoadProgress | null, cityLabel: string, tMs: number): BootParts | null {
  if (p === null) return { verb: 'JACK-IN', bar: busyBar(tMs), label: 'LINKING NODE' };
  const city = cityLabel.toUpperCase();
  switch (p.phase) {
    case 'download': {
      const rec = (Math.max(0, Math.min(p.received, p.total)) / MB).toFixed(1);
      const tot = (p.total / MB).toFixed(1);
      return { verb: 'JACK-IN', bar: bootBar(p.received, p.total), label: `DOWNLINK ${rec}/${tot} MB` };
    }
    case 'parse':
      return { verb: 'DECRYPT', bar: busyBar(tMs), label: `CITYGRID ${city}` };
    case 'build':
      return { verb: 'COMPILE', bar: busyBar(tMs), label: p.step ? p.step : city };
    case 'ready':
      return null;
  }
}

/** Nothing loading — the default `inputs` of {@link bootLine}. */
const IDLE_INPUTS: BusyInputs = { tilesPending: 0, engineLoading: false, cellsPending: 0, carsLoading: false };

/**
 * Boot status line (spinner, verb, bar, label unless `narrow`). At `ready`
 * it delegates to {@link busyLine} with `inputs` (idle → `''`).
 */
export function bootLine(
  p: LoadProgress,
  cityLabel: string,
  tMs: number,
  narrow: boolean,
  inputs: BusyInputs = IDLE_INPUTS,
): string {
  const parts = bootParts(p, cityLabel, tMs);
  if (parts === null) return busyLine(inputs, tMs, narrow);
  const head = `${busySpinner(tMs)} ${parts.verb} ${parts.bar}`;
  return narrow ? head : `${head} ${parts.label}`;
}
