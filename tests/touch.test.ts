/**
 * Unit tests for `src/player/touch.ts` (T-0025): the pure `joystickToAxes`
 * and `mergeInput` helpers. The DOM `TouchControls` class is browser-only
 * and covered by the e2e smoke + PM review.
 */
import { describe, expect, it } from 'vitest';
import type { InputState } from '../src/player/controls';
import { joystickToAxes, mergeInput } from '../src/player/touch';

/** Idle input frame used as a base for mergeInput cases. */
const idle: InputState = {
  forward: 0,
  strafe: 0,
  turn: 0,
  sprint: false,
  lookDx: 0,
  lookDy: 0,
  up: 0,
  flyToggles: 0,
};

describe('joystickToAxes', () => {
  it('joystickToAxes(60, 0) → strafe 1 / forward 0', () => {
    const a = joystickToAxes(60, 0);
    expect(a.strafe).toBe(1);
    expect(a.forward).toBe(0);
  });

  it('(0, −60) → forward 1', () => {
    const a = joystickToAxes(0, -60);
    expect(a.forward).toBe(1);
    expect(a.strafe).toBe(0);
  });

  it('(120, 0) clamps to 1', () => {
    const a = joystickToAxes(120, 0);
    expect(a.strafe).toBe(1);
    expect(a.forward).toBe(0);
  });

  it('(3, 3) dead zone → 0/0', () => {
    const a = joystickToAxes(3, 3);
    expect(a.forward).toBe(0);
    expect(a.strafe).toBe(0);
  });
});

describe('mergeInput', () => {
  it('sums and clamps axes, ORs sprint, sums look deltas, and does not mutate inputs', () => {
    const a: InputState = {
      ...idle,
      forward: 0.7,
      strafe: 0.8,
      turn: 0.6,
      sprint: false,
      lookDx: 4,
      lookDy: -3,
      up: 0.5,
      flyToggles: 1,
    };
    const b: InputState = {
      ...idle,
      forward: 0.6,
      strafe: -0.5,
      turn: 0.7,
      sprint: true,
      lookDx: 2.5,
      lookDy: 1,
      up: 0.5,
      flyToggles: 2,
    };
    const aSnap = { ...a };
    const bSnap = { ...b };

    const m = mergeInput(a, b);

    expect(m.forward).toBe(1);
    expect(m.strafe).toBeCloseTo(0.3);
    expect(m.turn).toBe(1);
    expect(m.sprint).toBe(true);
    expect(m.lookDx).toBe(6.5);
    expect(m.lookDy).toBe(-2);
    expect(m.up).toBe(1);
    expect(m.flyToggles).toBe(3);
    expect(a).toEqual(aSnap);
    expect(b).toEqual(bSnap);
    expect(m).not.toBe(a);
    expect(m).not.toBe(b);
  });
});
