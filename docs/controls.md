# Controls (T-0008) — `src/player/controls.ts`

Pure player kinematics plus the thin DOM input wrapper. The pure part runs in
node for unit tests; the `Controls` class touches `window`/`document` only
when instantiated in a browser.

## Coordinates (§3)

- `x` east, `z` south, `y` up. **`z` south** — a negative `z` delta moves north.
- Yaw in radians: `0` faces north (`−z`), `+π/2` faces east (`+x`).
- Pitch in radians, clamped to `±π/3` (±60°).

## Exports

```ts
export interface PlayerState { x: number; z: number; yaw: number; pitch: number }
export interface InputState {
  forward: number;  // -1..1
  strafe: number;   // -1..1
  turn: number;     // -1..1
  sprint: boolean;
  lookDx: number;   // px since last read
  lookDy: number;   // px since last read
}
export const WALK_SPEED = 3;            // m/s
export const SPRINT_SPEED = 9;          // m/s
export const TURN_SPEED = Math.PI / 2;  // rad/s
export const MOUSE_SENS = 0.0025;       // rad/px
export function stepPlayer(s, i, dt, resolve): PlayerState
export function yawToBearingDeg(yaw): number   // 0 ≤ result < 360
export function axesFromHeld(held): Pick<InputState, 'forward' | 'strafe' | 'turn' | 'sprint'>
export function isMouseSpike(dx, dy, limit = 300): boolean  // |dx| > limit || |dy| > limit
export class Controls { constructor(target: HTMLElement); readInput(): InputState; dispose(): void }
```

## stepPlayer

Pure — returns a **new** `PlayerState`, never mutates `s` or `i`. Order:

1. `yaw = s.yaw + turn·TURN_SPEED·dt + lookDx·MOUSE_SENS`
2. `pitch = clamp(s.pitch − lookDy·MOUSE_SENS, ±π/3)`
3. `speed = sprint ? SPRINT_SPEED : WALK_SPEED`
4. Move along forward/right by `speed·dt`; when `forward` and `strafe` are
   both non-zero the (forward, right) vector is normalised so diagonal speed
   equals `speed`.
5. `position = resolve(from, to)` — collision (T-0007) may snap `to`.

The updated `yaw` (after look/turn) is used for the move direction, matching
the camera look applied first.

## yawToBearingDeg

`((yaw · 180/π) % 360 + 360) % 360` — always in `[0, 360)`. Example: `π/2 → 90`,
`−π/2 → 270`, `2π → 0`, `3π → 180`.

## Controls (key map)

`Controls` registers listeners in its constructor and removes all of them in
`dispose()`. It has **no top-level side effects**, so node can import the
module for the pure parts.

| Input          | Effect when held                       |
|----------------|----------------------------------------|
| `W` / `↑`      | `forward` contributes `+1`             |
| `S` / `↓`      | `forward` contributes `−1`             |
| `A`            | `strafe` contributes `−1` (left)       |
| `D`            | `strafe` contributes `+1` (right)      |
| `←`            | `turn` contributes `−1` (anticlockwise)|
| `→`            | `turn` contributes `+1` (clockwise)    |
| `ShiftLeft`/`ShiftRight` | `sprint = true`               |

- `keydown` auto-repeat is ignored (`e.repeat` guard).
- Clicking `target` calls `target.requestPointerLock()` (pointer lock).
- `mousemove` accumulates `movementX`/`movementY` into `lookDx`/`lookDy` **only
  while** `document.pointerLockElement === target`, after the pointer-lock
  entry skip and spike filter below.
- `readInput()` returns the current directional state and the accumulated look
  deltas, then zeroes the look deltas (they are consumed per frame).
- `dispose()` removes every listener — including `pointerlockchange` — safe
  to call on teardown.

## Pointer-lock entry

When pointer lock is acquired, Chromium delivers a first `mousemove` whose
`movementX`/`movementY` equals the jump from the last pointer position
(observed: 640/360 px in headless tests). `Controls` listens for `document`
`pointerlockchange`; when `document.pointerLockElement === target` it sets a
private `skipNextMove` flag. The next locked `mousemove` clears that flag
and returns without accumulating.

Independently, any single-event delta that `isMouseSpike(dx, dy)` reports
(`|dx| > 300` or `|dy| > 300`; the default limit is exclusive) is discarded
so a stray large jump cannot spin the camera. A custom `limit` may be passed
to the helper; `Controls` uses the default.

## Held-key model

Axes are derived from a private `Set` of currently held `KeyboardEvent.code`s,
not from the last key that went down. Non-repeat `keydown` adds the code,
`keyup` deletes it, then a private `recompute()` calls `axesFromHeld`:

- `forward = (W|↑ ? 1 : 0) + (S|↓ ? −1 : 0)`
- `strafe = (D ? 1 : 0) + (A ? −1 : 0)`
- `turn = (→ ? 1 : 0) + (← ? −1 : 0)`
- `sprint` is true while `ShiftLeft` or `ShiftRight` is held

Opposite keys cancel to 0. Releasing one key of a pair leaves the other
active (hold W, press S, release W → still reverse). A `window` `blur`
listener clears the set and recomputes so keys released while the tab is
unfocused cannot stick.

## Changing sensitivity

- **Turn speed** — set `TURN_SPEED` (rad/s), default `Math.PI / 2`.
- **Mouse sensitivity** — set `MOUSE_SENS` (rad/px), default `0.0025`.
- **Walk/sprint speed** — set `WALK_SPEED` / `SPRINT_SPEED` (m/s), defaults
  `3` / `9`.
- **Pitch clamp** — set `PITCH_LIMIT`, default `Math.PI / 3` (60°).

These constants are exported from `src/player/controls.ts`; changing a value
there recompiles the game with the new feel.

## Touch (T-0025) — `src/player/touch.ts`

Phone/tablet input layered on top of keyboard/mouse. `InputState` / `Controls`
are unchanged; `main.ts` merges the two streams with `mergeInput`. Pure helpers
run in node; `TouchControls` is a thin Pointer Event wrapper with **no
top-level DOM access**.

```ts
export function joystickToAxes(dx: number, dy: number, radius = 60): { forward: number; strafe: number }
export function mergeInput(a: InputState, b: InputState): InputState
export class TouchControls { constructor(target: HTMLElement); readInput(): InputState; dispose(): void }
```

### joystickToAxes

Pure. `strafe = clamp(dx / radius, −1..1)`, `forward = clamp(−dy / radius, −1..1)`
(so a finger moving **up** the screen is forward). If the magnitude of the
clamped axes is `< 0.1`, both axes are 0 (dead zone). Values past `radius` clamp
to ±1 rather than being rescaled.

### mergeInput

Pure — returns a **new** `InputState`, never mutates `a` or `b`. `forward` /
`strafe` / `turn` are summed then clamped to [−1, 1]; `sprint` is OR'd;
`lookDx` / `lookDy` are summed with no clamp.

### TouchControls

Constructed on `target` (the canvas). Listeners use Pointer Events and ignore
anything whose `pointerType` is not `'touch'`.

| Region of `target` | Effect |
|--------------------|--------|
| Left half, pointer down | Joystick: origin = start point; axes from the current delta each frame via `joystickToAxes`. Sprint when `hypot(dx, dy) > 1.5 × radius`. |
| Right half, pointer down | Look: each move adds `(Δx, Δy) × 2` to `lookDx` / `lookDy` (movementX semantics from the previous event, scaled ×2). |

- `readInput()` returns the current stick axes / sprint plus the accumulated
  look deltas, then zeroes the look deltas (same consume-per-frame contract as
  `Controls`).
- `dispose()` removes every listener and the ring/knob nodes.
- Visuals (`src/player/touch.css`): two `position: fixed` circles (ring at the
  origin, knob following the finger, clamped to the ring). The ring shows a
  **faint idle hint** anchored bottom-left at all times (opacity `0.28`, knob
  hidden); a left-half `pointerdown` swaps it to the active origin-anchored
  placement at full opacity, and `pointerup`/`pointercancel` return it to the
  idle hint instead of hiding it. The input model is unchanged.

`main.ts` constructs `TouchControls(canvas)` when `'ontouchstart' in window`
or `navigator.maxTouchPoints > 0`, and each frame does
`mergeInput(controls.readInput(), touch.readInput())`. The overlay's existing
click handler already fires on tap; `requestPointerLock` is wrapped in
try/catch because it fails on touch.
