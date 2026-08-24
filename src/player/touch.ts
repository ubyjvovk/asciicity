/**
 * Touch input: virtual joystick (left half) + drag-to-look (right half).
 * Pure helpers (`joystickToAxes`, `mergeInput`) run in node; `TouchControls`
 * is a thin Pointer Event wrapper with no top-level DOM access.
 */
import './touch.css';
import type { InputState } from './controls';

/** Default joystick radius in CSS pixels. */
const JOYSTICK_RADIUS = 60;
/** Look deltas are twice the pointer movement (px). */
const LOOK_SCALE = 2;
/** Sprint when the stick is pulled past this multiple of the radius. */
const SPRINT_REACH = 1.5;
/** Dead zone on the normalised stick magnitude (exclusive). */
const DEAD_ZONE = 0.1;

/** Clamp a value to [−1, 1], coalescing −0 to +0. */
function clampAxis(v: number): number {
  const c = v < -1 ? -1 : v > 1 ? 1 : v;
  return c === 0 ? 0 : c;
}

/**
 * Map a joystick pixel delta to clamped forward/strafe axes, with a 0.1 dead zone.
 */
export function joystickToAxes(
  dx: number,
  dy: number,
  radius = JOYSTICK_RADIUS,
): { forward: number; strafe: number } {
  const strafe = clampAxis(dx / radius);
  const forward = clampAxis(-dy / radius);
  if (Math.hypot(strafe, forward) < DEAD_ZONE) {
    return { forward: 0, strafe: 0 };
  }
  return { forward, strafe };
}

/**
 * Sum two input frames: axes clamped to [−1, 1], sprint OR'd, look deltas added.
 */
export function mergeInput(a: InputState, b: InputState): InputState {
  return {
    forward: clampAxis(a.forward + b.forward),
    strafe: clampAxis(a.strafe + b.strafe),
    turn: clampAxis(a.turn + b.turn),
    sprint: a.sprint || b.sprint,
    lookDx: a.lookDx + b.lookDx,
    lookDy: a.lookDy + b.lookDy,
  };
}

/**
 * Virtual joystick (left half of `target`) and drag-to-look (right half).
 * Only `pointerType === 'touch'` pointers are handled.
 */
export class TouchControls {
  private readonly target: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly prevTouchAction: string;
  private joyId: number | null = null;
  private joyOriginX = 0;
  private joyOriginY = 0;
  private joyDx = 0;
  private joyDy = 0;
  private readonly looks = new Map<number, { x: number; y: number }>();
  private lookDx = 0;
  private lookDy = 0;

  /**
   * Attach touch pointer listeners to `target` and create the joystick overlay.
   */
  constructor(target: HTMLElement) {
    this.target = target;
    this.prevTouchAction = target.style.touchAction;
    target.style.touchAction = 'none';

    const doc = target.ownerDocument;
    const ring = doc.createElement('div');
    ring.className = 'touch-joystick-ring';
    ring.setAttribute('aria-hidden', 'true');
    const knob = doc.createElement('div');
    knob.className = 'touch-joystick-knob';
    knob.setAttribute('aria-hidden', 'true');
    const parent = target.parentElement ?? doc.body;
    parent.append(ring, knob);
    this.ring = ring;
    this.knob = knob;
    this.hideStick();

    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerup', this.onUp);
    target.addEventListener('pointercancel', this.onUp);
  }

  /** Return the current touch input and zero the accumulated look deltas. */
  readInput(): InputState {
    const active = this.joyId !== null;
    const axes = active
      ? joystickToAxes(this.joyDx, this.joyDy, JOYSTICK_RADIUS)
      : { forward: 0, strafe: 0 };
    const sprint =
      active &&
      Math.hypot(this.joyDx, this.joyDy) > SPRINT_REACH * JOYSTICK_RADIUS;
    const state: InputState = {
      forward: axes.forward,
      strafe: axes.strafe,
      turn: 0,
      sprint,
      lookDx: this.lookDx,
      lookDy: this.lookDy,
    };
    this.lookDx = 0;
    this.lookDy = 0;
    return state;
  }

  /** Remove every listener and the joystick overlay. */
  dispose(): void {
    this.target.removeEventListener('pointerdown', this.onDown);
    this.target.removeEventListener('pointermove', this.onMove);
    this.target.removeEventListener('pointerup', this.onUp);
    this.target.removeEventListener('pointercancel', this.onUp);
    this.target.style.touchAction = this.prevTouchAction;
    this.ring.remove();
    this.knob.remove();
    this.looks.clear();
    this.joyId = null;
  }

  private onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    try {
      this.target.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort; move/up still fire while over `target`.
    }
    const rect = this.target.getBoundingClientRect();
    const left = e.clientX < rect.left + rect.width / 2;
    if (left) {
      if (this.joyId !== null) return;
      this.joyId = e.pointerId;
      this.joyOriginX = e.clientX;
      this.joyOriginY = e.clientY;
      this.joyDx = 0;
      this.joyDy = 0;
      this.showStick();
      return;
    }
    this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    if (this.joyId === e.pointerId) {
      this.joyDx = e.clientX - this.joyOriginX;
      this.joyDy = e.clientY - this.joyOriginY;
      this.layoutKnob();
      return;
    }
    const prev = this.looks.get(e.pointerId);
    if (!prev) return;
    this.lookDx += (e.clientX - prev.x) * LOOK_SCALE;
    this.lookDy += (e.clientY - prev.y) * LOOK_SCALE;
    prev.x = e.clientX;
    prev.y = e.clientY;
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    if (this.joyId === e.pointerId) {
      this.joyId = null;
      this.joyDx = 0;
      this.joyDy = 0;
      this.hideStick();
    }
    this.looks.delete(e.pointerId);
  };

  private showStick(): void {
    this.ring.classList.add('is-active');
    this.knob.classList.add('is-active');
    this.ring.style.left = `${this.joyOriginX}px`;
    this.ring.style.top = `${this.joyOriginY}px`;
    this.layoutKnob();
  }

  private hideStick(): void {
    this.ring.classList.remove('is-active');
    this.knob.classList.remove('is-active');
  }

  private layoutKnob(): void {
    const mag = Math.hypot(this.joyDx, this.joyDy);
    const scale = mag > JOYSTICK_RADIUS && mag > 0 ? JOYSTICK_RADIUS / mag : 1;
    this.knob.style.left = `${this.joyOriginX + this.joyDx * scale}px`;
    this.knob.style.top = `${this.joyOriginY + this.joyDy * scale}px`;
  }
}
