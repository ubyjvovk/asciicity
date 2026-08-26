/**
 * Player kinematics (`stepPlayer`) and DOM keyboard/pointer-lock input
 * (`Controls`). The pure function runs in node for tests; the class touches
 * `window`/`document` only when instantiated in a browser and has no
 * top-level side effects. Contract: docs/architecture.md §3 and §4.7.
 */
import { FLAT_HEIGHT, type HeightFn, type Vec2 } from '../data/types';

/** Player pose: x east, z south (metres), y eye height (absolute world y), yaw/pitch in radians. */
export interface PlayerState {
  x: number;
  z: number;
  /** Eye height — absolute world y (metres). */
  y: number;
  yaw: number;
  pitch: number;
  /** True while airborne (fly mode); toggled by `KeyF`. */
  fly: boolean;
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
  /** -1..1: +1 Space (up), -1 KeyC (down). */
  up: number;
  /** KeyF presses since the last read; each odd count flips `fly`. */
  flyToggles: number;
}

/** Eye height above the walkable ground in metres. */
export const EYE_HEIGHT = 1.7;
/** Walk speed in m/s. */
export const WALK_SPEED = 9;
/** Sprint (walk) speed in m/s. */
export const SPRINT_SPEED = 27;
/** Fly speed in m/s. */
export const FLY_SPEED = 30;
/** Fly sprint speed in m/s. */
export const FLY_SPRINT_SPEED = 90;
/** Constant fall speed in m/s after leaving fly mode. */
export const FALL_SPEED = 30;
/** Absolute ceiling for `y` in fly mode (metres). */
export const MAX_ALTITUDE = 1500;
/** Turn rate in rad/s. */
export const TURN_SPEED = Math.PI / 2;
/** Mouse look sensitivity in rad/px. */
export const MOUSE_SENS = 0.0025;
/** Pitch clamp (π/3 = 60°). */
export const PITCH_LIMIT = Math.PI / 3;

/**
 * Advance a player pose by `dt` seconds. Pure: returns a new PlayerState and
 * never mutates `s` or `i`. Applies turn + mouse look, clamps pitch, flips
 * `fly` once per odd `i.flyToggles`, then either walks (grounded, with
 * `resolve` collision) or flies (noclip, `y` clamped to
 * `[groundAt + EYE_HEIGHT, MAX_ALTITUDE]`). While `fly` is false and `y` sits
 * above the ground the player falls at constant `FALL_SPEED`.
 */
export function stepPlayer(
  s: PlayerState,
  i: InputState,
  dt: number,
  resolve: (from: Vec2, to: Vec2) => Vec2,
  groundAt: HeightFn = FLAT_HEIGHT,
): PlayerState {
  const yaw = s.yaw + i.turn * TURN_SPEED * dt + i.lookDx * MOUSE_SENS;
  const pitch = Math.max(
    -PITCH_LIMIT,
    Math.min(PITCH_LIMIT, s.pitch - i.lookDy * MOUSE_SENS),
  );
  const fly = i.flyToggles % 2 === 1 ? !s.fly : s.fly;

  if (!fly) {
    // Walk (or falling after leaving fly mode): horizontal move on the
    // forward/right plane (§3), collision via `resolve`, then glue/fall `y`.
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
    const groundY = groundAt(x, z) + EYE_HEIGHT;
    const y =
      s.y > groundY ? Math.max(groundY, s.y - FALL_SPEED * dt) : groundY;
    return { x, z, y, yaw, pitch, fly };
  }

  // Fly: noclip — `resolve` is never called. Dir = forward·look + strafe·right
  // + up·(0,1,0), normalised when non-zero, then `dir · speed · dt`.
  const speed = i.sprint ? FLY_SPRINT_SPEED : FLY_SPEED;
  const lookX = Math.sin(yaw) * Math.cos(pitch);
  const lookY = Math.sin(pitch);
  const lookZ = -Math.cos(yaw) * Math.cos(pitch);
  const rightX = Math.cos(yaw);
  const rightZ = Math.sin(yaw);
  let dirX = i.forward * lookX + i.strafe * rightX;
  let dirY = i.forward * lookY + i.up;
  let dirZ = i.forward * lookZ + i.strafe * rightZ;
  const len = Math.hypot(dirX, dirY, dirZ);
  if (len > 0) {
    dirX /= len;
    dirY /= len;
    dirZ /= len;
  }
  const x = s.x + dirX * speed * dt;
  const y = s.y + dirY * speed * dt;
  const z = s.z + dirZ * speed * dt;
  const minY = groundAt(x, z) + EYE_HEIGHT;
  const clampedY = Math.max(minY, Math.min(MAX_ALTITUDE, y));
  return { x, z, y: clampedY, yaw, pitch, fly };
}

/** Convert a yaw in radians to a HUD bearing in degrees, 0 ≤ result < 360. */
export function yawToBearingDeg(yaw: number): number {
  return (((yaw * 180) / Math.PI) % 360 + 360) % 360;
}

/**
 * True when a single mouse-delta event is larger than `limit` on either axis
 * (exclusive). Used to drop pointer-lock entry jumps and stray spikes.
 */
export function isMouseSpike(dx: number, dy: number, limit = 300): boolean {
  return Math.abs(dx) > limit || Math.abs(dy) > limit;
}

/**
 * Derive directional axes from the set of currently held `KeyboardEvent.code`s.
 * Opposite keys cancel to 0; releasing one of a pair leaves the other active.
 * `Space`/`KeyC` produce the vertical fly axis `up`.
 */
export function axesFromHeld(
  held: ReadonlySet<string>,
): Pick<InputState, 'forward' | 'strafe' | 'turn' | 'sprint' | 'up'> {
  const forward =
    (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) +
    (held.has('KeyS') || held.has('ArrowDown') ? -1 : 0);
  const strafe = (held.has('KeyD') ? 1 : 0) + (held.has('KeyA') ? -1 : 0);
  const turn =
    (held.has('ArrowRight') ? 1 : 0) + (held.has('ArrowLeft') ? -1 : 0);
  const sprint = held.has('ShiftLeft') || held.has('ShiftRight');
  const up = (held.has('Space') ? 1 : 0) + (held.has('KeyC') ? -1 : 0);
  return { forward, strafe, turn, sprint, up };
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
  private up = 0;
  private flyToggles = 0;
  private lookDx = 0;
  private lookDy = 0;
  /** Drop the first `mousemove` after pointer lock is acquired. */
  private skipNextMove = false;

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
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
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
      up: this.up,
      flyToggles: this.flyToggles,
    };
    this.lookDx = 0;
    this.lookDy = 0;
    this.flyToggles = 0;
    return state;
  }

  /** Remove every listener added by the constructor. */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('click', this.onClick);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  private recompute(): void {
    const axes = axesFromHeld(this.held);
    this.forward = axes.forward;
    this.strafe = axes.strafe;
    this.turn = axes.turn;
    this.sprint = axes.sprint;
    this.up = axes.up;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return; // ignore auto-repeat
    this.held.add(e.code);
    this.recompute();
    // `F` toggles fly mode — one increment per press (no auto-repeat here).
    if (e.code === 'KeyF') this.flyToggles++;
    // Space would scroll the page; the browser must not move.
    if (e.code === 'Space') e.preventDefault();
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

  private onPointerLockChange = (): void => {
    if (document.pointerLockElement === this.target) {
      this.skipNextMove = true;
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (document.pointerLockElement !== this.target) return;
    if (this.skipNextMove) {
      this.skipNextMove = false;
      return;
    }
    if (isMouseSpike(e.movementX, e.movementY)) return;
    this.lookDx += e.movementX;
    this.lookDy += e.movementY;
  };
}
