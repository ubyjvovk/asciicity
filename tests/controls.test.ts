/**
 * Unit tests for `src/player/controls.ts` (T-0008, T-0013): the pure
 * `stepPlayer` integration, `yawToBearingDeg`, and `axesFromHeld`. The DOM
 * `Controls` class is browser-only and covered by the e2e smoke + PM review.
 */
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../src/data/types';
import {
  MOUSE_SENS,
  PITCH_LIMIT,
  SPRINT_SPEED,
  TURN_SPEED,
  WALK_SPEED,
  axesFromHeld,
  stepPlayer,
  yawToBearingDeg,
} from '../src/player/controls';

/** Identity resolve: the player goes exactly where the kinematics say. */
const identity: (from: Vec2, to: Vec2) => Vec2 = (_from, to) => to;

const idle = {
  forward: 0,
  strafe: 0,
  turn: 0,
  sprint: false,
  lookDx: 0,
  lookDy: 0,
};

describe('stepPlayer', () => {
  it('forward at yaw 0 for 1 s moves z by -WALK_SPEED and leaves x', () => {
    const s = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, forward: 1 },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(-WALK_SPEED);
  });

  it('forward at yaw pi/2 moves x by +WALK_SPEED', () => {
    const s = stepPlayer(
      { x: 0, z: 0, yaw: Math.PI / 2, pitch: 0 },
      { ...idle, forward: 1 },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(WALK_SPEED);
    expect(s.z).toBeCloseTo(0);
  });

  it('strafe +1 at yaw 0 moves x by +WALK_SPEED', () => {
    const s = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, strafe: 1 },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(WALK_SPEED);
    expect(s.z).toBeCloseTo(0);
  });

  it('forward+strafe together moves exactly WALK_SPEED (normalised)', () => {
    const s = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, forward: 1, strafe: 1 },
      1,
      identity,
    );
    expect(Math.hypot(s.x, s.z)).toBeCloseTo(WALK_SPEED);
  });

  it('sprint uses SPRINT_SPEED', () => {
    const s = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, forward: 1, sprint: true },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(-SPRINT_SPEED);
  });

  it('turn = 1 for 1 s adds TURN_SPEED to yaw', () => {
    const s = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, turn: 1 },
      1,
      identity,
    );
    expect(s.yaw).toBeCloseTo(TURN_SPEED);
  });

  it('lookDx = 100 adds 100 * MOUSE_SENS to yaw', () => {
    const s = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, lookDx: 100 },
      1,
      identity,
    );
    expect(s.yaw).toBeCloseTo(100 * MOUSE_SENS);
  });

  it('lookDy moves pitch the opposite sign and clamps at +-pi/3', () => {
    const down = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, lookDy: 100 },
      1,
      identity,
    );
    expect(down.pitch).toBeCloseTo(-100 * MOUSE_SENS); // opposite sign

    const clamped = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, lookDy: 1e6 },
      1,
      identity,
    );
    expect(clamped.pitch).toBeCloseTo(-PITCH_LIMIT);

    const clampedUp = stepPlayer(
      { x: 0, z: 0, yaw: 0, pitch: 0 },
      { ...idle, lookDy: -1e6 },
      1,
      identity,
    );
    expect(clampedUp.pitch).toBeCloseTo(PITCH_LIMIT);
  });

  it('does not mutate the input', () => {
    const input = { ...idle, forward: 1, lookDx: 7, lookDy: 3, turn: 1, strafe: 1, sprint: true };
    const snapshot = { ...input };
    stepPlayer({ x: 0, z: 0, yaw: 0, pitch: 0 }, input, 1, identity);
    expect(input).toEqual(snapshot);
  });

  it('a resolve that returns from leaves the position unchanged', () => {
    const freeze: (from: Vec2, to: Vec2) => Vec2 = (from) => from;
    const s = stepPlayer(
      { x: 5, z: 7, yaw: 0, pitch: 0 },
      { ...idle, forward: 1 },
      1,
      freeze,
    );
    expect(s.x).toBeCloseTo(5);
    expect(s.z).toBeCloseTo(7);
    // heading still updates even though position is frozen
    expect(s.yaw).toBeCloseTo(0);
  });
});

describe('yawToBearingDeg', () => {
  it('maps yaw to compass degrees in [0, 360)', () => {
    expect(yawToBearingDeg(0)).toBeCloseTo(0);
    expect(yawToBearingDeg(Math.PI / 2)).toBeCloseTo(90);
    expect(yawToBearingDeg(-Math.PI / 2)).toBeCloseTo(270);
    expect(yawToBearingDeg(2 * Math.PI)).toBeCloseTo(0);
    expect(yawToBearingDeg(3 * Math.PI)).toBeCloseTo(180);
  });
});

describe('axesFromHeld', () => {
  it('W alone → forward 1', () => {
    expect(axesFromHeld(new Set(['KeyW']))).toEqual({
      forward: 1,
      strafe: 0,
      turn: 0,
      sprint: false,
    });
  });

  it('W+S → 0', () => {
    expect(axesFromHeld(new Set(['KeyW', 'KeyS'])).forward).toBe(0);
  });

  it('S after releasing W (set contains only S) → −1', () => {
    expect(axesFromHeld(new Set(['KeyS'])).forward).toBe(-1);
  });

  it('A+D → strafe 0', () => {
    expect(axesFromHeld(new Set(['KeyA', 'KeyD'])).strafe).toBe(0);
  });

  it('ArrowLeft → turn −1', () => {
    expect(axesFromHeld(new Set(['ArrowLeft'])).turn).toBe(-1);
  });

  it('ShiftRight → sprint true', () => {
    expect(axesFromHeld(new Set(['ShiftRight'])).sprint).toBe(true);
  });

  it('empty set → all zero/false', () => {
    expect(axesFromHeld(new Set())).toEqual({
      forward: 0,
      strafe: 0,
      turn: 0,
      sprint: false,
    });
  });

  it('ArrowUp counts as forward', () => {
    expect(axesFromHeld(new Set(['ArrowUp'])).forward).toBe(1);
  });
});
