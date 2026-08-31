/**
 * Pure settings helpers (T-0060): load / save / URL mirroring.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  applySettingsToUrl,
  loadSettings,
  saveSettings,
  type Settings,
} from '../src/settings';

/** In-memory `Storage` stand-in keyed like `localStorage`. */
function fakeStorage(initial?: string | null): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  data: Record<string, string>;
} {
  const data: Record<string, string> = {};
  if (initial !== undefined && initial !== null) data[SETTINGS_KEY] = initial;
  return {
    data,
    getItem(key: string): string | null {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key: string, value: string): void {
      data[key] = value;
    },
  };
}

describe('loadSettings', () => {
  it('loadSettings — URL beats storage beats defaults for each key', () => {
    const stored: Settings = {
      hud: false,
      minimap: false,
      crt: false,
      cars: false,
      render: 'gloom',
      city: 'london',
    };
    const storage = fakeStorage(JSON.stringify(stored));

    // URL overrides hud, crt, render, city; minimap and cars are absent → storage.
    const url = new URLSearchParams(
      'hud=1&crt=1&render=pico8&city=kyiv&theme=gloom',
    );
    const s = loadSettings(storage, url);
    expect(s.hud).toBe(true); // URL
    expect(s.minimap).toBe(false); // storage (URL silent)
    expect(s.crt).toBe(true); // URL
    expect(s.cars).toBe(false); // storage (URL silent)
    expect(s.render).toBe('pico8'); // URL `render` wins over `theme`
    expect(s.city).toBe('kyiv'); // URL

    // Empty URL + empty storage → defaults.
    expect(loadSettings(fakeStorage(), new URLSearchParams())).toEqual(
      DEFAULT_SETTINGS,
    );

    // Storage only (no URL keys) → storage values.
    expect(loadSettings(storage, new URLSearchParams())).toEqual(stored);
  });

  it('cars defaults to true (empty URL + empty storage)', () => {
    expect(DEFAULT_SETTINGS.cars).toBe(true);
    expect(
      loadSettings(fakeStorage(), new URLSearchParams()).cars,
    ).toBe(true);
  });

  it('?cars=0 → cars false', () => {
    const s = loadSettings(fakeStorage(), new URLSearchParams('cars=0'));
    expect(s.cars).toBe(false);
  });

  it('malformed storage JSON → defaults', () => {
    const storage = fakeStorage('{not json');
    expect(loadSettings(storage, new URLSearchParams())).toEqual(DEFAULT_SETTINGS);
  });

  it('?minimap=0 → false', () => {
    const s = loadSettings(fakeStorage(), new URLSearchParams('minimap=0'));
    expect(s.minimap).toBe(false);
  });
});

describe('applySettingsToUrl', () => {
  it("applySettingsToUrl('?city=kyiv&hud=0', { hud: true, … }) removes hud and keeps city", () => {
    const out = applySettingsToUrl('?city=kyiv&hud=0', {
      ...DEFAULT_SETTINGS,
      hud: true,
    });
    expect(out).toContain('city=kyiv');
    expect(out).not.toMatch(/[?&]hud=/);
  });

  it("share-URL drops cars when it equals its default (true)", () => {
    // Default cars=true → the param is stripped.
    const kept = applySettingsToUrl('?city=kyiv&cars=0', {
      ...DEFAULT_SETTINGS,
      cars: true,
    });
    expect(kept).toContain('city=kyiv');
    expect(kept).not.toMatch(/[?&]cars=/);
    // Non-default cars=false → the param is written as `cars=0`.
    const off = applySettingsToUrl('?city=kyiv', {
      ...DEFAULT_SETTINGS,
      cars: false,
    });
    expect(off).toContain('cars=0');
  });
});

describe('saveSettings', () => {
  it('saveSettings round-trips through a fake storage', () => {
    const storage = fakeStorage();
    const s: Settings = {
      hud: false,
      minimap: true,
      crt: false,
      cars: false,
      render: 'gloom',
      city: 'kyiv',
    };
    saveSettings(storage, s);
    expect(storage.data[SETTINGS_KEY]).toBe(JSON.stringify(s));
    expect(loadSettings(storage, new URLSearchParams())).toEqual(s);
  });
});
