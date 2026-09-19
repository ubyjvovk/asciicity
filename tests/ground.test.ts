/**
 * Pure parts of the per-style ground grid (docs/architecture.md §4.11,
 * T-0132): `groundGridFor` resolution and the registry flags. No WebGL or
 * DOM is touched.
 */
import { describe, expect, it } from 'vitest';
import { groundGridFor } from '../src/world/ground';
import { STYLES } from '../src/render/styles/index';

describe('groundGridFor', () => {
  it('is true when groundGrid is absent', () => {
    expect(groundGridFor({})).toBe(true);
  });

  it('is true when groundGrid is true', () => {
    expect(groundGridFor({ groundGrid: true })).toBe(true);
  });

  it('is false when groundGrid is false', () => {
    expect(groundGridFor({ groundGrid: false })).toBe(false);
  });
});

describe('registry ground-grid flags (T-0132)', () => {
  it('lowpoly and scribble carry groundGrid === false (quest is out of the cycle)', () => {
    const lowpoly = STYLES.find((s) => s.id === 'lowpoly');
    const scribble = STYLES.find((s) => s.id === 'scribble');
    expect(STYLES.find((s) => s.id === 'quest')).toBeUndefined();
    expect(lowpoly?.groundGrid).toBe(false);
    expect(scribble?.groundGrid).toBe(false);
  });

  it('every other registry style resolves to groundGrid true', () => {
    const painterly = new Set(['quest', 'lowpoly', 'scribble', 'pencil', 'crayon', 'pastel', 'watercolor', 'retrocgi']);
    for (const style of STYLES) {
      if (!painterly.has(style.id)) {
        expect(groundGridFor(style), style.id).toBe(true);
      }
    }
  });
});
