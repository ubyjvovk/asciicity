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
export interface PlayerState { x: number; z: number; y: number; yaw: number; pitch: number; fly: boolean }
export interface InputState {
  forward: number;  // -1..1
  strafe: number;   // -1..1
  turn: number;     // -1..1
  sprint: boolean;
  lookDx: number;   // px since last read
  lookDy: number;   // px since last read
  up: number;       // -1..1
  flyToggles: number; // KeyF presses since last read
}
export const EYE_HEIGHT = 1.7;             // m
...
```

_See the source or §4.7 for the full constant list (`FLY_SPEED`, `FLY_SPRINT_SPEED`, `FALL_SPEED`, `MAX_ALTITUDE`)._

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

## Fly mode (T-0049)

Press `F` to toggle noclip flight (each press flips `PlayerState.fly`). While
flying you steer where you look (mouse pitch steers vertically), `Space`/`C`
climb/descend straight up/down, and `Shift` sprints at `FLY_SPRINT_SPEED`.

### stepPlayer fly rules

1. `fly = s.fly` flipped once per odd `i.flyToggles` (one press flips, two
   leave it).
2. Speed `= sprint ? FLY_SPRINT_SPEED : FLY_SPEED` (`90` / `30` m/s).
3. Direction `dir = forward·look + strafe·right + up·(0,1,0)` where
   `look = (sin yaw cos pitch, sin pitch, −cos yaw cos pitch)` and
   `right = (cos yaw, 0, sin yaw)`; `dir` is normalised when non-zero.
4. `to = from + dir·speed·dt` with **no collision** — `resolve` is never
   called while flying (noclip through buildings).
5. `y` is clamped to `[groundAt(x, z) + EYE_HEIGHT, MAX_ALTITUDE]` (never
   below the ground, never above 1 500 m).

### Walk / fall

With `fly = false` the old walk code runs unchanged (horizontal move on the
forward/right plane, diagonal normalised, `resolve` collision), then the
height is glued to the ground or, after leaving fly mode, falls at a constant
`FALL_SPEED` (30 m/s) until it lands on `groundAt(x, z) + EYE_HEIGHT`. The
walk-ground default is `FLAT_HEIGHT`.

`stepPlayer` now takes a `groundAt: HeightFn` (default `FLAT_HEIGHT`) so walk
and fly both know the walkable height.

### Keys

| Input | Effect                          |
|-------|---------------------------------|
| `F`   | Toggle fly mode (no repeat)     |
| `Space` / `C` | Climb / descend (held; `Space` calls `preventDefault`) |
| `Shift` | Fly sprint (sprint while airborne) |

`axesFromHeld` now also maps held `Space` (`up` +1) and `KeyC` (`up` −1)
(both → 0).

## Changing sensitivity

- **Turn speed** — set `TURN_SPEED` (rad/s), default `Math.PI / 2`.
- **Mouse sensitivity** — set `MOUSE_SENS` (rad/px), default `0.0025`.
- **Walk/sprint speed** — set `WALK_SPEED` / `SPRINT_SPEED` (m/s), defaults
  `9` / `27`.
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
