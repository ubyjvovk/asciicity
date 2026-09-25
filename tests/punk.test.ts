/**
 * Cyberpunk style (wave 20): the pure halves of `src/render/punk/` — look
 * presets (`look.ts`) and the CPU mirror of the collision-rain maths
 * (`rainmath.ts`). The WebGPU graph itself is covered by the e2e + GPU review.
 */
import { describe, it, expect } from 'vitest';
import {
  FOG_SCALE,
  LOOK_PRESETS,
  bloomSettings,
  lookPreset,
  nextLookPreset,
} from '../src/render/punk/look';
import {
  HEIGHT_AREA,
  RAIN_AREA,
  RAIN_SPAN,
  RAIN_SPEED,
  SPLASH_S,
  rainDrop,
} from '../src/render/punk/rainmath';
import { STYLES } from '../src/render/styles/index';
import { STYLE_ORDER } from '../src/render/style';

describe('cyberpunk registry entry', () => {
  it('is the last STYLE_ORDER id and the only engine: webgpu style', () => {
    expect(STYLE_ORDER[STYLE_ORDER.length - 1]).toBe('cyberpunk');
    const webgpu = STYLES.filter((s) => s.engine === 'webgpu').map((s) => s.id);
    expect(webgpu).toEqual(['cyberpunk']);
  });

  it('hides the floor grid and keeps a WebGL fallback fragment', () => {
    const s = STYLES.find((x) => x.id === 'cyberpunk');
    expect(s?.groundGrid).toBe(false);
    expect(s?.fragment).toMatch(/void main\(\)/);
  });
});

describe('look presets', () => {
  it('has unique ids, neonNoir first (default)', () => {
    const ids = LOOK_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('neonNoir');
    expect(lookPreset(undefined).id).toBe('neonNoir');
    expect(lookPreset('nope').id).toBe('neonNoir');
    expect(lookPreset('sinCity').id).toBe('sinCity');
  });

  it('cycles forwards and backwards with wrap', () => {
    const n = LOOK_PRESETS.length;
    expect(nextLookPreset(LOOK_PRESETS[n - 1].id).id).toBe(LOOK_PRESETS[0].id);
    expect(nextLookPreset(LOOK_PRESETS[0].id, -1).id).toBe(LOOK_PRESETS[n - 1].id);
    expect(nextLookPreset('unknown').id).toBe(LOOK_PRESETS[1].id);
  });

  it('keeps upstream numbers, fog scaled to city blocks', () => {
    const noir = lookPreset('neonNoir');
    expect(noir.fogFar).toBeCloseTo(50 * FOG_SCALE);
    expect(noir.gradeTint[1]).toBeCloseTo(0.9);
    expect(lookPreset('silentHill').fogNear).toBeCloseTo(-20 * FOG_SCALE);
  });

  it('collapses the two bloom bands like upstream applyBloomSettings', () => {
    const b = bloomSettings(lookPreset('neonNoir'));
    expect(b.strength).toBeCloseTo(0.85 + 2.2 * 0.35);
    expect(b.radius).toBeCloseTo(Math.max(0.55, 0.85 * 0.55));
  });
});

describe('collision rain maths', () => {
  it('falls from top at RAIN_SPEED and wraps each span', () => {
    const top = 30;
    const a = rainDrop(0, 1, 0, top, -1000);
    expect(a.y).toBeCloseTo(top);
    const t = 1;
    const b = rainDrop(0, 1, t, top, -1000);
    expect(b.y).toBeCloseTo(top - RAIN_SPEED * t);
    const cycle = RAIN_SPAN / RAIN_SPEED;
    const c = rainDrop(0, 1, cycle + 0.1, top, -1000);
    expect(c.k).toBe(1);
    expect(c.y).toBeCloseTo(top - RAIN_SPEED * 0.1);
  });

  it('stops at the floor and splashes for SPLASH_S right after', () => {
    const top = 30;
    const floorY = 12; // a roof
    const hitT = (top - floorY) / RAIN_SPEED;
    expect(rainDrop(0, 1, hitT - 0.05, top, floorY).falling).toBe(true);
    const at = rainDrop(0, 1, hitT + 0.01, top, floorY);
    expect(at.falling).toBe(false);
    expect(at.splash).toBeGreaterThanOrEqual(0);
    expect(at.splash).toBeLessThan(1);
    expect(rainDrop(0, 1, hitT + SPLASH_S + 0.01, top, floorY).splash).toBe(-1);
  });

  it('never shows a drop under cover (floor above the spawn height)', () => {
    for (const t of [0, 0.3, 1.7, 2.2]) {
      const d = rainDrop(0.4, 1, t, 10, 25);
      expect(d.falling).toBe(false);
      expect(d.splash).toBe(-1);
    }
  });

  it('height box covers the rain box with slack for a frame of travel', () => {
    // Both boxes share a centre; the height map refreshes every other frame,
    // so leave ≥ 10 m a side for a sprinting / flying player.
    expect((HEIGHT_AREA - RAIN_AREA) / 2).toBeGreaterThanOrEqual(10);
  });
});
