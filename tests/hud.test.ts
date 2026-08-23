/**
 * HUD formatters and ZoneIndex (T-0009). Hud DOM is browser-only and is not
 * imported here (it pulls in CSS).
 */
import { describe, expect, it } from 'vitest';
import type { Place, Road } from '../src/data/types';
import { formatBearing, formatWorld, hudRow, sectorOf } from '../src/hud/format';
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
