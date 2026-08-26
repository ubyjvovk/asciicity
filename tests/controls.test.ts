/**
 * Unit tests for `src/player/controls.ts` (T-0008, T-0013, T-0019, T-0048):
 * the pure
 * `stepPlayer` integration, `yawToBearingDeg`, `axesFromHeld`, and
 * `isMouseSpike`. The DOM `Controls` class is browser-only and covered by
 * the e2e smoke + PM review.
 */
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../src/data/types';
import {
  EYE_HEIGHT,
  FALL_SPEED,
  FLY_SPEED,
  FLY_SPRINT_SPEED,
  MAX_ALTITUDE,
  MOUSE_SENS,
  PITCH_LIMIT,
  SPRINT_SPEED,
  TURN_SPEED,
  WALK_SPEED,
  axesFromHeld,
  isMouseSpike,
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
  up: 0,
  flyToggles: 0,
};

// A walk-state player on the flat floor: eye height ON the ground.
const onGroundY: number = EYE_HEIGHT;
const player = (p: Partial<Parameters<typeof stepPlayer>[0]> = {}): Parameters<typeof stepPlayer>[0] => ({
  x: 0,
  z: 0,
  y: onGroundY,
  yaw: 0,
  pitch: 0,
  fly: false,
  ...p,
});
describe('movement speeds', () => {
  it('WALK_SPEED === 9', () => {
    expect(WALK_SPEED).toBe(9);
  });

  it('SPRINT_SPEED === 27', () => {
    expect(SPRINT_SPEED).toBe(27);
  });
});

describe('stepPlayer', () => {
  it('forward at yaw 0 for 1 s moves z by -WALK_SPEED and leaves x', () => {
    const s = stepPlayer(
      player(),
      { ...idle, forward: 1 },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(-WALK_SPEED);
  });

  it('forward at yaw pi/2 moves x by +WALK_SPEED', () => {
    const s = stepPlayer(
      player({ yaw: Math.PI / 2 }),
      { ...idle, forward: 1 },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(WALK_SPEED);
    expect(s.z).toBeCloseTo(0);
  });

  it('strafe +1 at yaw 0 moves x by +WALK_SPEED', () => {
    const s = stepPlayer(
      player(),
      { ...idle, strafe: 1 },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(WALK_SPEED);
    expect(s.z).toBeCloseTo(0);
  });

  it('forward+strafe together moves exactly WALK_SPEED (normalised)', () => {
    const s = stepPlayer(
      player(),
      { ...idle, forward: 1, strafe: 1 },
      1,
      identity,
    );
    expect(Math.hypot(s.x, s.z)).toBeCloseTo(WALK_SPEED);
  });

  it('sprint uses SPRINT_SPEED', () => {
    const s = stepPlayer(
      player(),
      { ...idle, forward: 1, sprint: true },
      1,
      identity,
    );
    expect(s.x).toBeCloseTo(0);
    expect(s.z).toBeCloseTo(-SPRINT_SPEED);
  });

  it('turn = 1 for 1 s adds TURN_SPEED to yaw', () => {
    const s = stepPlayer(
      player(),
      { ...idle, turn: 1 },
      1,
      identity,
    );
    expect(s.yaw).toBeCloseTo(TURN_SPEED);
  });

  it('lookDx = 100 adds 100 * MOUSE_SENS to yaw', () => {
    const s = stepPlayer(
      player(),
      { ...idle, lookDx: 100 },
      1,
      identity,
    );
    expect(s.yaw).toBeCloseTo(100 * MOUSE_SENS);
  });

  it('lookDy moves pitch the opposite sign and clamps at +-pi/3', () => {
    const down = stepPlayer(
      player(),
      { ...idle, lookDy: 100 },
      1,
      identity,
    );
    expect(down.pitch).toBeCloseTo(-100 * MOUSE_SENS); // opposite sign

    const clamped = stepPlayer(
      player(),
      { ...idle, lookDy: 1e6 },
      1,
      identity,
    );
    expect(clamped.pitch).toBeCloseTo(-PITCH_LIMIT);

    const clampedUp = stepPlayer(
      player(),
      { ...idle, lookDy: -1e6 },
      1,
      identity,
    );
    expect(clampedUp.pitch).toBeCloseTo(PITCH_LIMIT);
  });

  it('does not mutate the input', () => {
    const input = { ...idle, forward: 1, lookDx: 7, lookDy: 3, turn: 1, strafe: 1, sprint: true };
    const snapshot = { ...input };
    stepPlayer(player(), input, 1, identity);
    expect(input).toEqual(snapshot);
  });

  it('a resolve that returns from leaves the position unchanged', () => {
    const freeze: (from: Vec2, to: Vec2) => Vec2 = (from) => from;
    const s = stepPlayer(
      player({ x: 5, z: 7 }),
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
      up: 0,
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
      up: 0,
    });
  });

  it('ArrowUp counts as forward', () => {
    expect(axesFromHeld(new Set(['ArrowUp'])).forward).toBe(1);
  });

  it('Space → up +1', () => {
    expect(axesFromHeld(new Set(['Space'])).up).toBe(1);
  });

  it('KeyC → up −1', () => {
    expect(axesFromHeld(new Set(['KeyC'])).up).toBe(-1);
  });

  it('Space + KeyC → up 0', () => {
    expect(axesFromHeld(new Set(['Space', 'KeyC'])).up).toBe(0);
  });

  it('Space alone leaves walk axes zero', () => {
    expect(axesFromHeld(new Set(['Space']))).toEqual({
      forward: 0,
      strafe: 0,
      turn: 0,
      sprint: false,
      up: 1,
    });
  });
});

describe('fly mode (T-0049)', () => {
  const spy: (from: Vec2, to: Vec2) => Vec2 = (_from, to) => to;

  it('one flyToggles flips fly, two leave it', () => {
    const s1 = stepPlayer(player(), { ...idle, flyToggles: 1, forward: 1 }, 0.1, spy);
    expect(s1.fly).toBe(true);
    const s2 = stepPlayer(player(), { ...idle, flyToggles: 2, forward: 1 }, 0.1, spy);
    expect(s2.fly).toBe(false);
  });

  it('walk mode keeps y = 11.7 on groundAt = (x, z) => 10', () => {
    const groundAt = () => 10;
    const s = stepPlayer(
      player({ y: 11.7, fly: false }),
      { ...idle, forward: 1 },
      1,
      spy,
      groundAt,
    );
    expect(s.y).toBeCloseTo(11.7);
    expect(s.fly).toBe(false);
  });

  it('in fly mode forward at pitch +pi/6 for 1 s moves y by FLY_SPEED*sin(pi/6) and horizontally by FLY_SPEED*cos(pi/6)', () => {
    const s = stepPlayer(
      player({ y: EYE_HEIGHT, fly: true, pitch: Math.PI / 6 }),
      { ...idle, forward: 1 },
      1,
      spy,
    );
    expect(s.y - EYE_HEIGHT).toBeCloseTo(FLY_SPEED * Math.sin(Math.PI / 6));
    expect(Math.hypot(s.x - 0, s.z - 0)).toBeCloseTo(FLY_SPEED * Math.cos(Math.PI / 6));
    expect(s.x).toBeCloseTo(0); // yaw 0, no strafe → look straight ahead
  });

  it('up = 1 alone rises FLY_SPEED * dt', () => {
    const s = stepPlayer(
      player({ y: 10, fly: true }),
      { ...idle, up: 1 },
      1,
      spy,
    );
    expect(s.y).toBeCloseTo(10 + FLY_SPEED);
  });

  it('sprint uses FLY_SPRINT_SPEED', () => {
    const s = stepPlayer(
      player({ y: EYE_HEIGHT, fly: true }),
      { ...idle, forward: 1, sprint: true },
      1,
      spy,
    );
    expect(s.z).toBeCloseTo(-FLY_SPRINT_SPEED);
  });

  it('resolve is NOT called in fly mode but IS called in walk mode', () => {
    let flyCalls = 0;
    const flySpy: (from: Vec2, to: Vec2) => Vec2 = (_f, t) => {
      flyCalls++;
      return t;
    };
    stepPlayer(player({ fly: true }), { ...idle, forward: 1 }, 0.1, flySpy);
    expect(flyCalls).toBe(0);

    let walkCalls = 0;
    const walkSpy: (from: Vec2, to: Vec2) => Vec2 = (_f, t) => {
      walkCalls++;
      return t;
    };
    stepPlayer(player({ fly: false }), { ...idle, forward: 1 }, 0.1, walkSpy);
    expect(walkCalls).toBe(1);
  });

  it('y never goes below groundAt + EYE_HEIGHT nor above MAX_ALTITUDE', () => {
    const high = stepPlayer(
      player({ y: MAX_ALTITUDE - 5, fly: true }),
      { ...idle, up: 1 },
      1,
      spy,
    );
    expect(high.y).toBe(MAX_ALTITUDE);

    const low = stepPlayer(
      player({ y: EYE_HEIGHT, fly: true }),
      { ...idle, up: -1 },
      1,
      spy,
      () => 10,
    );
    expect(low.y).toBeCloseTo(10 + EYE_HEIGHT);
  });

  it('leaving fly mode 100 m up falls exactly FALL_SPEED*dt per step until it lands on groundY', () => {
    const groundAt = () => 10; // groundY = 11.7
    let s = player({ y: 11.7 + 100, fly: true });
    let landed = false;
    for (let step = 0; step < 10; step++) {
      const after = stepPlayer(
        s,
        { ...idle, flyToggles: step === 0 ? 1 : 0 },
        1,
        identity,
        groundAt,
      );
      if (!landed) {
        // Drops the full FALL_SPEED·dt until the ground clamps it.
        expect(after.y).toBeCloseTo(Math.max(11.7, s.y - FALL_SPEED));
        if (after.y === 11.7) landed = true;
      }
      s = after;
    }
    expect(s.y).toBeCloseTo(11.7);
    expect(landed).toBe(true);
  });

  it('diagonal fly input is normalised (|Δ| = speed * dt)', () => {
    const s = stepPlayer(
      player({ y: EYE_HEIGHT, fly: true }),
      { ...idle, forward: 1, strafe: 1, up: 1 },
      1,
      spy,
    );
    expect(Math.hypot(s.x, s.y - EYE_HEIGHT, s.z)).toBeCloseTo(FLY_SPEED);
  });
});

describe('isMouseSpike', () => {
  it('isMouseSpike(640, 360) true', () => {
    expect(isMouseSpike(640, 360)).toBe(true);
  });

  it('isMouseSpike(20, -15) false', () => {
    expect(isMouseSpike(20, -15)).toBe(false);
  });

  it('isMouseSpike(301, 0) true', () => {
    expect(isMouseSpike(301, 0)).toBe(true);
  });

  it('isMouseSpike(0, 300) false (limit is exclusive)', () => {
    expect(isMouseSpike(0, 300)).toBe(false);
  });

  it('custom limit honoured', () => {
    expect(isMouseSpike(50, 0, 40)).toBe(true);
    expect(isMouseSpike(40, 0, 40)).toBe(false);
    expect(isMouseSpike(0, -41, 40)).toBe(true);
  });
});
