import { describe, it, expect } from 'vitest';
import {
  BAR_CELLS,
  BAR_MS,
  BusyGate,
  SPINNER_FRAMES,
  SPINNER_MS,
  busyInputsFromStats,
  busyLabel,
  busyLine,
  type BusyInputs,
} from '../src/hud/busy';

const IDLE: BusyInputs = { tilesPending: 0, engineLoading: false, cellsPending: 0, carsLoading: false };
const ALL: BusyInputs = { tilesPending: 3, engineLoading: true, cellsPending: 7, carsLoading: true };

/** Split a `busyLine` into its space-separated parts. */
function parts(line: string): string[] {
  return line.split(' ');
}

describe('busyLabel', () => {
  it('busyLabel idle → empty string', () => {
    expect(busyLabel(IDLE)).toBe('');
  });

  it('busyLabel all four sources → SECTORS 3 · NEON GRID · CELLS 7 · CARS (exact order)', () => {
    expect(busyLabel(ALL)).toBe('SECTORS 3 · NEON GRID · CELLS 7 · CARS');
  });

  it('busyLabel lists only the active sources', () => {
    expect(busyLabel({ ...IDLE, cellsPending: 2 })).toBe('CELLS 2');
    expect(busyLabel({ ...IDLE, tilesPending: 1, carsLoading: true })).toBe('SECTORS 1 · CARS');
  });
});

describe('busyInputsFromStats', () => {
  it('busyInputsFromStats sums every *.pending key and ignores others', () => {
    const i = busyInputsFromStats(4, 'ready', {
      'detail.pending': 2,
      'props.pending': 3,
      'neon.pending': 1,
      'detail.cells': 50,
      'neon.pendingMs': 99,
      'atmosphere.rain': 1,
    });
    expect(i.cellsPending).toBe(6);
    expect(i.tilesPending).toBe(4);
    expect(i.engineLoading).toBe(false);
    expect(i.carsLoading).toBe(false);
  });

  it('busyInputsFromStats engineLoading iff status is loading', () => {
    expect(busyInputsFromStats(0, 'loading', {}).engineLoading).toBe(true);
    expect(busyInputsFromStats(0, 'off', {}).engineLoading).toBe(false);
    expect(busyInputsFromStats(0, 'failed', {}).engineLoading).toBe(false);
  });

  it('busyInputsFromStats CARS from vehicles.on/ready/loading', () => {
    expect(busyInputsFromStats(0, 'ready', { 'vehicles.on': 1, 'vehicles.ready': 0 }).carsLoading).toBe(true);
    expect(busyInputsFromStats(0, 'ready', { 'vehicles.on': 1, 'vehicles.ready': 1 }).carsLoading).toBe(false);
    expect(busyInputsFromStats(0, 'ready', { 'vehicles.on': 0, 'vehicles.ready': 0 }).carsLoading).toBe(false);
    expect(busyInputsFromStats(0, 'ready', { 'vehicles.loading': 1, 'vehicles.ready': 1 }).carsLoading).toBe(true);
    expect(busyInputsFromStats(0, 'ready', {}).carsLoading).toBe(false);
  });
});

describe('busyLine', () => {
  it('busyLine idle → empty string', () => {
    expect(busyLine(IDLE, 1234, false)).toBe('');
  });

  it('busyLine spinner advances one frame per 80 ms and wraps', () => {
    expect(SPINNER_MS).toBe(80);
    const n = SPINNER_FRAMES.length;
    expect(n).toBe(10);
    for (let k = 0; k < 2 * n; k++) {
      expect(parts(busyLine(ALL, k * SPINNER_MS, false))[0]).toBe(SPINNER_FRAMES[k % n]);
      // Still the same frame just before the next tick.
      expect(parts(busyLine(ALL, k * SPINNER_MS + SPINNER_MS - 1, false))[0]).toBe(SPINNER_FRAMES[k % n]);
    }
    expect(parts(busyLine(ALL, n * SPINNER_MS, false))[0]).toBe(SPINNER_FRAMES[0]);
  });

  it('busyLine bar is 8 cells with exactly 3 ▰ that ping-pong (never leaves the bar)', () => {
    expect(BAR_CELLS).toBe(8);
    const starts: number[] = [];
    for (let step = 0; step < 25; step++) {
      const bar = parts(busyLine(ALL, step * BAR_MS, false))[2];
      expect([...bar].length).toBe(8);
      expect([...bar].filter((c) => c === '▰').length).toBe(3);
      expect([...bar].filter((c) => c === '▱').length).toBe(5);
      const start = bar.indexOf('▰');
      expect(bar.slice(start, start + 3)).toBe('▰▰▰');
      starts.push(start);
    }
    // One cell per step, bouncing off both ends: 0..5..0..
    expect(starts.slice(0, 11)).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]);
    for (let k = 1; k < starts.length; k++) expect(Math.abs(starts[k] - starts[k - 1])).toBe(1);
    expect(Math.min(...starts)).toBe(0);
    expect(Math.max(...starts)).toBe(5);
  });

  it('busyLine verb BOOT iff engineLoading', () => {
    expect(parts(busyLine(ALL, 0, false))[1]).toBe('BOOT');
    expect(parts(busyLine({ ...ALL, engineLoading: false }, 0, false))[1]).toBe('SYNC');
    expect(parts(busyLine({ ...IDLE, tilesPending: 1 }, 0, false))[1]).toBe('SYNC');
  });

  it('busyLine narrow drops the label', () => {
    const wide = busyLine({ ...IDLE, tilesPending: 3 }, 0, false);
    const narrow = busyLine({ ...IDLE, tilesPending: 3 }, 0, true);
    expect(wide).toBe(`${SPINNER_FRAMES[0]} SYNC ▰▰▰▱▱▱▱▱ SECTORS 3`);
    expect(narrow).toBe(`${SPINNER_FRAMES[0]} SYNC ▰▰▰▱▱▱▱▱`);
    expect(narrow).not.toContain('SECTORS');
  });
});

describe('BusyGate', () => {
  /** Feed `busy` from `t0` to `t1` (exclusive) in 16 ms frames; returns every result. */
  function run(g: BusyGate, busy: boolean, t0: number, t1: number): boolean[] {
    const out: boolean[] = [];
    for (let t = t0; t < t1; t += 16) out.push(g.step(busy, t));
    return out;
  }

  it('BusyGate a 200 ms blip never shows', () => {
    const g = new BusyGate();
    expect(run(g, false, 0, 100).some(Boolean)).toBe(false);
    expect(run(g, true, 100, 300).some(Boolean)).toBe(false);
    expect(run(g, false, 300, 2000).some(Boolean)).toBe(false);
  });

  it('BusyGate 300 ms continuous shows', () => {
    const g = new BusyGate();
    expect(g.step(true, 1000)).toBe(false);
    expect(g.step(true, 1299)).toBe(false);
    expect(g.step(true, 1300)).toBe(true);
    expect(g.step(true, 1500)).toBe(true);
  });

  it('BusyGate stays shown 600 ms after idle, then hides', () => {
    const g = new BusyGate();
    g.step(true, 0);
    expect(g.step(true, 400)).toBe(true);
    expect(g.step(false, 500)).toBe(true);
    expect(g.step(false, 1099)).toBe(true);
    expect(g.step(false, 1100)).toBe(false);
    expect(g.step(false, 3000)).toBe(false);
    // A fresh blip after hiding needs another 300 ms.
    expect(g.step(true, 3100)).toBe(false);
    expect(g.step(true, 3400)).toBe(true);
  });

  it('BusyGate busy again inside the hold window keeps it shown', () => {
    const g = new BusyGate(300, 600);
    g.step(true, 0);
    g.step(true, 300);
    expect(g.step(false, 400)).toBe(true);
    expect(g.step(true, 900)).toBe(true);
    expect(g.step(false, 1000)).toBe(true);
    expect(g.step(false, 1599)).toBe(true);
    expect(g.step(false, 1600)).toBe(false);
  });
});
