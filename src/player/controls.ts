/**
 * Player kinematics (`stepPlayer`) and DOM keyboard/pointer-lock input
 * (`Controls`). The pure function runs in node for tests; the class touches
 * `window`/`document` only when instantiated in a browser and has no
 * top-level side effects. Contract: docs/architecture.md §3 and §4.7.
 */
import type { Vec2 } from '../data/types';

/** Player pose: x east, z south (metres), yaw/pitch in radians. */
export interface PlayerState {
  x: number;
  z: number;
  yaw: number;
  pitch: number;
}

/** One frame of directional input; look deltas are px since the last read. */
export interface InputState {
  /** -1..1: +1 forward (north of heading), -1 reverse. */
  forward: number;
  /** -1..1: +1 strafe right, -1 left. */
  strafe: number;
  /** -1..1: +1 turns clockwise (yaw+), -1 anticlockwise. */
  turn: number;
  /** True while a Shift key is held (sprint). */
  sprint: boolean;
  /** Accumulated horizontal mouse delta in px since the last read. */
  lookDx: number;
  /** Accumulated vertical mouse delta in px since the last read. */
  lookDy: number;
}

/** Walk speed in m/s. */
export const WALK_SPEED = 3;
/** Sprint speed in m/s. */
export const SPRINT_SPEED = 9;
/** Turn rate in rad/s. */
export const TURN_SPEED = Math.PI / 2;
/** Mouse look sensitivity in rad/px. */
export const MOUSE_SENS = 0.0025;
/** Pitch clamp (π/3 = 60°). */
export const PITCH_LIMIT = Math.PI / 3;

/**
 * Advance a player pose by `dt` seconds. Pure: returns a new PlayerState and
 * never mutates `s` or `i`. Applies turn + mouse look, clamps pitch, then
 * moves along the (normalised) forward/right vector; the final position is
 * `resolve(from, to)`, which collision (T-0007) may snap.
 */
export function stepPlayer(
  s: PlayerState,
  i: InputState,
  dt: number,
  resolve: (from: Vec2, to: Vec2) => Vec2,
): PlayerState {
  const yaw = s.yaw + i.turn * TURN_SPEED * dt + i.lookDx * MOUSE_SENS;
  const pitch = Math.max(
    -PITCH_LIMIT,
    Math.min(PITCH_LIMIT, s.pitch - i.lookDy * MOUSE_SENS),
  );

  const speed = i.sprint ? SPRINT_SPEED : WALK_SPEED;
  // Forward = (sin yaw, 0, -cos yaw); right = (cos yaw, 0, sin yaw) (§3).
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = Math.sin(yaw);
  let dx = fx * i.forward + rx * i.strafe;
  let dz = fz * i.forward + rz * i.strafe;

  // Normalise diagonal movement so horizontal speed stays `speed`.
  if (i.forward !== 0 && i.strafe !== 0) {
    const len = Math.hypot(dx, dz);
    dx /= len;
    dz /= len;
  }

  const from: Vec2 = [s.x, s.z];
  const to: Vec2 = [from[0] + dx * speed * dt, from[1] + dz * speed * dt];
  const [x, z] = resolve(from, to);

  return { x, z, yaw, pitch };
}

/** Convert a yaw in radians to a HUD bearing in degrees, 0 ≤ result < 360. */
export function yawToBearingDeg(yaw: number): number {
  return (((yaw * 180) / Math.PI) % 360 + 360) % 360;
}

/**
 * Derive directional axes from the set of currently held `KeyboardEvent.code`s.
 * Opposite keys cancel to 0; releasing one of a pair leaves the other active.
 */
export function axesFromHeld(
  held: ReadonlySet<string>,
): Pick<InputState, 'forward' | 'strafe' | 'turn' | 'sprint'> {
  const forward =
    (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) +
    (held.has('KeyS') || held.has('ArrowDown') ? -1 : 0);
  const strafe = (held.has('KeyD') ? 1 : 0) + (held.has('KeyA') ? -1 : 0);
  const turn =
    (held.has('ArrowRight') ? 1 : 0) + (held.has('ArrowLeft') ? -1 : 0);
  const sprint = held.has('ShiftLeft') || held.has('ShiftRight');
  return { forward, strafe, turn, sprint };
}

/**
 * Thin DOM wrapper that turns keyboard + pointer-lock mouse motion into an
 * `InputState`. Registered listeners are removed by `dispose()`. No top-level
 * side effects — safe to import in node.
 */
export class Controls {
  private readonly target: HTMLElement;
  private readonly held = new Set<string>();
  private forward = 0;
  private strafe = 0;
  private turn = 0;
  private sprint = false;
  private lookDx = 0;
  private lookDy = 0;

  /**
   * Construct a Controls from keys/mouse targeting `target`; `target` is also
   * the element locked by clicks (`requestPointerLock`).
   */
  constructor(target: HTMLElement) {
    this.target = target;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('click', this.onClick);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  /** Return the current input and zero the accumulated look deltas. */
  readInput(): InputState {
    const state: InputState = {
      forward: this.forward,
      strafe: this.strafe,
      turn: this.turn,
      sprint: this.sprint,
      lookDx: this.lookDx,
      lookDy: this.lookDy,
    };
    this.lookDx = 0;
    this.lookDy = 0;
    return state;
  }

  /** Remove every listener added by the constructor. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('click', this.onClick);
    document.removeEventListener('mousemove', this.onMouseMove);
  }

  private recompute(): void {
    const axes = axesFromHeld(this.held);
    this.forward = axes.forward;
    this.strafe = axes.strafe;
    this.turn = axes.turn;
    this.sprint = axes.sprint;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return; // ignore auto-repeat
    this.held.add(e.code);
    this.recompute();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    this.recompute();
  };

  private onBlur = (): void => {
    this.held.clear();
    this.recompute();
  };

  private onClick = (): void => {
    this.target.requestPointerLock();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement === this.target) {
      this.lookDx += e.movementX;
      this.lookDy += e.movementY;
    }
  };
}
