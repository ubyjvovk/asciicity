/**
 * Validator cases for wave-10 building parts (`minH`) and the raised height
 * clamp (docs/data-format.md "Building parts"). Broader `validateCity` cases
 * live in `tests/data.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { validateCity } from '../src/data/validate';
import { syntheticCity } from '../src/data/synthetic';

/** Deep copy of a valid synthetic city for mutation in checks. */
function base(): ReturnType<typeof syntheticCity> {
  return structuredClone(syntheticCity(1, 3));
}

describe('validateCity building parts', () => {
  it('minH must be a finite number in [0, h − 1)', () => {
    const c = base();
    c.buildings[0].h = 20;
    c.buildings[0].minH = 5;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].minH = 0;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].minH = 18.999;
    expect(() => validateCity(c)).not.toThrow();

    c.buildings[0].minH = 19; // === h − 1, exclusive upper bound
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    c.buildings[0].minH = 20;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    c.buildings[0].minH = -0.1;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    (c.buildings[0] as { minH?: unknown }).minH = NaN;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    (c.buildings[0] as { minH?: unknown }).minH = Infinity;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    (c.buildings[0] as { minH?: unknown }).minH = '5';
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.minH/);

    delete c.buildings[0].minH;
    expect(() => validateCity(c)).not.toThrow();
  });

  it('h up to 600 is valid', () => {
    const c = base();
    c.buildings[0].h = 600;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].h = 400;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].h = 3;
    expect(() => validateCity(c)).not.toThrow();
    c.buildings[0].h = 601;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.h/);
    c.buildings[0].h = 2.9;
    expect(() => validateCity(c)).toThrow(/buildings\[0\]\.h/);
  });
});
