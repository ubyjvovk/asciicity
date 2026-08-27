/**
 * HUD formatters and ZoneIndex (T-0009). Hud DOM is browser-only and is not
 * imported here (it pulls in CSS).
 */
import { describe, expect, it } from 'vitest';
import type { Building, Place, Road } from '../src/data/types';
import {
  formatAlt,
  formatBearing,
  formatWorld,
  hudRow,
  sectorOf,
} from '../src/hud/format';
import { ZoneIndex } from '../src/hud/zone';

describe('formatBearing', () => {
  it('0 → "000 DEG / NORTH"', () => {
    expect(formatBearing(0)).toBe('000 DEG / NORTH');
  });

  it('267 → "267 DEG / WEST"', () => {
    expect(formatBearing(267)).toBe('267 DEG / WEST');
  });

  it('359.7 → "000 DEG / NORTH"', () => {
    expect(formatBearing(359.7)).toBe('000 DEG / NORTH');
  });

  it('45 → NORTHEAST', () => {
    expect(formatBearing(45)).toBe('045 DEG / NORTHEAST');
  });

  it('22.4 → NORTH', () => {
    expect(formatBearing(22.4)).toBe('022 DEG / NORTH');
  });

  it('22.6 → NORTHEAST', () => {
    expect(formatBearing(22.6)).toBe('023 DEG / NORTHEAST');
  });

  it('−90 → "270 DEG / WEST"', () => {
    expect(formatBearing(-90)).toBe('270 DEG / WEST');
  });
});

describe('formatWorld', () => {
  it('formatWorld(1234.5, -321)', () => {
    expect(formatWorld(1234.5, -321)).toBe('1234.50 / -321.00');
  });
});

describe('sectorOf', () => {
  it('sectorOf for (50, −50) → "E00 / N01"', () => {
    expect(sectorOf(50, -50)).toBe('E00 / N01');
  });

  it('sectorOf for (−150, 250) → "W02 / S02"', () => {
    expect(sectorOf(-150, 250)).toBe('W02 / S02');
  });

  it('sectorOf for (0, 0) → "E00 / S00"', () => {
    expect(sectorOf(0, 0)).toBe('E00 / S00');
  });
});

describe('hudRow', () => {
  it("hudRow('SECTOR', 'E00 / S00') → \"SECTOR..... E00 / S00\"", () => {
    expect(hudRow('SECTOR', 'E00 / S00')).toBe('SECTOR..... E00 / S00');
  });
});

describe('formatAlt', () => {
  it('formatAlt(155.6) → "156 M ASL"', () => {
    expect(formatAlt(155.6)).toBe('156 M ASL');
  });

  it('formatAlt rounds down at 0.4', () => {
    expect(formatAlt(155.4)).toBe('155 M ASL');
  });

  it('formatAlt handles zero and negatives', () => {
    expect(formatAlt(0)).toBe('0 M ASL');
    expect(formatAlt(-12.6)).toBe('-13 M ASL');
  });
});

function building(partial: Omit<Building, 'id' | 'h'> & { id?: number; h?: number }): Building {
  return { id: partial.id ?? 1, h: partial.h ?? 20, ...partial };
}

// Centroid of the supplied square footprint ring.
function square(cx: number, cz: number, half = 10): Building['poly'] {
  return [[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half]];
}

function road(partial: Omit<Road, 'id' | 'cls'> & { id?: number; cls?: Road['cls'] }): Road {
  return { id: partial.id ?? 1, cls: partial.cls ?? 'residential', ...partial };
}

describe('ZoneIndex', () => {
  it('a named road 10 m away gives its name upper-cased', () => {
    const roads = [road({ name: 'Cheapside', pts: [[-20, 10], [20, 10]] })];
    const index = new ZoneIndex(roads, []);
    const hit = index.nearestRoad(0, 0);
    expect(hit).not.toBeNull();
    expect(hit?.name).toBe('Cheapside');
    expect(hit?.dist).toBeCloseTo(10);
    expect(index.zoneLabel(0, 0)).toBe('CHEAPSIDE');
  });

  it('an unnamed road is ignored', () => {
    const roads = [road({ pts: [[-20, 10], [20, 10]] })];
    const index = new ZoneIndex(roads, []);
    expect(index.nearestRoad(0, 0)).toBeNull();
    expect(index.zoneLabel(0, 0)).toBe('CITY');
  });

  it('a road segment spanning several cells is found from its middle', () => {
    const roads = [road({ name: 'Long Street', pts: [[0, 0], [400, 0]] })];
    const index = new ZoneIndex(roads, []);
    const hit = index.nearestRoad(200, 0);
    expect(hit).not.toBeNull();
    expect(hit?.name).toBe('Long Street');
    expect(hit?.dist).toBeCloseTo(0);
    expect(index.zoneLabel(200, 0)).toBe('LONG STREET');
  });

  it('place fallback within 300 m gives NEAR X', () => {
    const places: Place[] = [{ name: 'Bank', x: 100, z: 0 }];
    const index = new ZoneIndex([], places);
    expect(index.nearestPlace(0, 0)?.name).toBe('Bank');
    expect(index.nearestPlace(0, 0)?.dist).toBeCloseTo(100);
    expect(index.zoneLabel(0, 0)).toBe('NEAR BANK');
  });

  it('nothing nearby gives CITY', () => {
    const places: Place[] = [{ name: 'Bank', x: 400, z: 0 }];
    const index = new ZoneIndex([], places);
    expect(index.zoneLabel(0, 0)).toBe('CITY');
  });

  it('nearestRoad returns null on an empty index', () => {
    const index = new ZoneIndex([], []);
    expect(index.nearestRoad(0, 0)).toBeNull();
    expect(index.nearestPlace(0, 0)).toBeNull();
    expect(index.zoneLabel(0, 0)).toBe('CITY');
  });
});

// A tiny stand-in for the DOM so `Hud` can be exercised in the node vitest
// environment. It captures the last `textContent` written to the rows element.
interface FakeElement {
  ownerDocument: FakeDocument;
  className: string;
  textContent: string;
  style: { display: string };
  append(...items: (FakeElement | string)[]): void;
}
interface FakeDocument {
  createElement(tag: string): FakeElement;
}

function makeFakeDoc(): { root: FakeElement; rows: () => FakeElement; items: () => unknown[] } {
  const created: FakeElement[] = [];
  const appended: unknown[] = [];
  const pushed = (...args: (FakeElement | string)[]): void => {
    for (const a of args) appended.push(a);
  };
  const doc: FakeDocument = {
    createElement(_tag: string) {
      const el: FakeElement = {
        ownerDocument: doc,
        className: '',
        textContent: '',
        style: { display: '' },
        append() {
          /* not needed for the row assertions */
        },
      };
      created.push(el);
      return el;
    },
  };
  const root: FakeElement = {
    ownerDocument: doc,
    className: '',
    textContent: '',
    style: { display: '' },
    append(...items: (FakeElement | string)[]) {
      // Capture every argument so the help-line tests can assert the
      // constructor's bare-string third argument.
      pushed(...items);
    },
  };
  // The `pre.hud-rows` element is always the second createElement call.
  const rows = () => created[1];
  const items = () => appended;
  return { root, rows, items };
}

describe('Hud.update row count', () => {
  it('renders 7 rows with ALT fourth when alt is set', async () => {
    // Use a fake element as root — Hud is browser-only but does not touch
    // window/document itself; it goes through root.ownerDocument.createElement.
    const { Hud } = await import('../src/hud/hud');
    const { root, rows } = makeFakeDoc();
    const hud = new Hud(root as unknown as HTMLElement);
    hud.update({
      sector: 'E00 / S00',
      world: '0.00 / 0.00',
      bearing: '000 DEG / NORTH',
      zone: 'CITY',
      alt: '156 M ASL',
      landmark: 'ST PAULS',
      fps: 60,
    });
    const lines = rows().textContent.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatch(/^> SECTOR\.+ /);
    expect(lines[1]).toMatch(/^> WORLD\.+ /);
    expect(lines[2]).toMatch(/^> BEARING\.+ /);
    expect(lines[3]).toMatch(/^> ZONE\.+ /);
    expect(lines[4]).toMatch(/^> ALT\.+ 156 M ASL$/);
    expect(lines[5]).toMatch(/^> LANDMARK\.+ ST PAULS$/);
    expect(lines[6]).toMatch(/^> FPS\.+ 60$/);
  });

  it('renders 6 rows (no ALT) when alt is undefined', async () => {
    const { Hud } = await import('../src/hud/hud');
    const { root, rows } = makeFakeDoc();
    const hud = new Hud(root as unknown as HTMLElement);
    hud.update({
      sector: 'E00 / S00',
      world: '0.00 / 0.00',
      bearing: '000 DEG / NORTH',
      zone: 'CITY',
      landmark: 'ST PAULS',
      fps: 60,
    });
    const lines = rows().textContent.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.some((l) => l.startsWith('> ALT'))).toBe(false);
    expect(lines[4]).toMatch(/^> LANDMARK\.+ ST PAULS$/);
    expect(lines[5]).toMatch(/^> FPS\.+ 60$/);
  });

  it('renders 8 rows with ALT and MODE (ALT fourth, MODE between LANDMARK and FPS)', async () => {
    const { Hud } = await import('../src/hud/hud');
    const { root, rows } = makeFakeDoc();
    const hud = new Hud(root as unknown as HTMLElement);
    hud.update({
      sector: 'E00 / S00',
      world: '0.00 / 0.00',
      bearing: '000 DEG / NORTH',
      zone: 'CITY',
      alt: '156 M ASL',
      mode: 'FLY',
      landmark: 'ST PAULS',
      fps: 60,
    });
    const lines = rows().textContent.split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[4]).toMatch(/^> ALT\.+ 156 M ASL$/);
    expect(lines[5]).toMatch(/^> LANDMARK\.+/);
    expect(lines[6]).toMatch(/^> MODE\.+ FLY$/);
    expect(lines[7]).toMatch(/^> FPS\.+ 60$/);
  });

  it('renders 7 rows with MODE (no ALT) — MODE sits between LANDMARK and FPS', async () => {
    const { Hud } = await import('../src/hud/hud');
    const { root, rows } = makeFakeDoc();
    const hud = new Hud(root as unknown as HTMLElement);
    hud.update({
      sector: 'E00 / S00',
      world: '0.00 / 0.00',
      bearing: '000 DEG / NORTH',
      zone: 'CITY',
      mode: 'FLY',
      landmark: 'ST PAULS',
      fps: 60,
    });
    const lines = rows().textContent.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[4]).toMatch(/^> LANDMARK\.+ ST PAULS$/);
    expect(lines[5]).toMatch(/^> MODE\.+ FLY$/);
    expect(lines[6]).toMatch(/^> FPS\.+ 60$/);
  });

  it('renders 6 rows without alt and mode — no MODE row', async () => {
    const { Hud } = await import('../src/hud/hud');
    const { root, rows } = makeFakeDoc();
    const hud = new Hud(root as unknown as HTMLElement);
    hud.update({
      sector: 'E00 / S00',
      world: '0.00 / 0.00',
      bearing: '000 DEG / NORTH',
      zone: 'CITY',
      landmark: 'X',
      fps: 60,
    });
    const lines = rows().textContent.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.some((l) => l.startsWith('> MODE'))).toBe(false);
  });
});

describe('Hud help line', () => {
  it('appends the desktop help line passed by main.ts (ends in ESC MENU)', async () => {
    const { Hud } = await import('../src/hud/hud');
    const { root, items } = makeFakeDoc();
    new Hud(
      root as unknown as HTMLElement,
      'WASD MOVE · MOUSE LOOK · SHIFT RUN · F FLY · R STYLE · ESC MENU',
    );
    expect(items()).toContain(
      'WASD MOVE · MOUSE LOOK · SHIFT RUN · F FLY · R STYLE · ESC MENU',
    );
  });

  it('appends the touch help line verbatim (unchanged)', async () => {
    const { Hud } = await import('../src/hud/hud');
    const { root, items } = makeFakeDoc();
    new Hud(root as unknown as HTMLElement, 'LEFT: MOVE · RIGHT: LOOK · R STYLE');
    expect(items()).toContain('LEFT: MOVE · RIGHT: LOOK · R STYLE');
  });
});

describe('nearestLandmark', () => {
  it('a named building 30 m straight ahead (yaw 0) is returned', () => {
    const buildings = [building({ name: 'St Paul\'s', poly: square(0, -30) })];
    const index = new ZoneIndex([], [], 50, buildings);
    const hit = index.nearestLandmark(0, 0, 0);
    expect(hit).not.toBeNull();
    expect(hit?.name).toBe('St Paul\'s');
    expect(hit?.dist).toBeCloseTo(30);
  });

  it('the same building with yaw π (facing away) is not returned', () => {
    const buildings = [building({ name: 'St Paul\'s', poly: square(0, -30) })];
    const index = new ZoneIndex([], [], 50, buildings);
    expect(index.nearestLandmark(0, 0, Math.PI)).toBeNull();
  });

  it('an unnamed building ahead is ignored', () => {
    const buildings = [building({ poly: square(0, -30) })];
    const index = new ZoneIndex([], [], 50, buildings);
    expect(index.nearestLandmark(0, 0, 0)).toBeNull();
  });

  it('a named building 120 m ahead is ignored (beyond maxDist)', () => {
    const buildings = [building({ name: 'Far Tower', poly: square(0, -120) })];
    const index = new ZoneIndex([], [], 50, buildings);
    expect(index.nearestLandmark(0, 0, 0)).toBeNull();
  });

  it('of two named buildings ahead the nearer is returned', () => {
    const buildings = [
      building({ name: 'Far', poly: square(0, -30) }),
      building({ name: 'Near', poly: square(0, -10) }),
    ];
    const index = new ZoneIndex([], [], 50, buildings);
    const hit = index.nearestLandmark(0, 0, 0);
    expect(hit?.name).toBe('Near');
    expect(hit?.dist).toBeCloseTo(10);
  });

  it('a building 30 m ahead but 60° off-heading is ignored', () => {
    // Centroid at (26, −15): 30 m away at 60° from north (yaw 0).
    const buildings = [building({ name: 'Off Axis', poly: square(26, -15) })];
    const index = new ZoneIndex([], [], 50, buildings);
    expect(index.nearestLandmark(0, 0, 0)).toBeNull();
  });

  it('nearestLandmark returns null when the index was built without buildings', () => {
    const index = new ZoneIndex([], []);
    expect(index.nearestLandmark(0, 0, 0)).toBeNull();
  });
});
