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

| Input          | Effect (keydown)                       | On keyup      |
|----------------|----------------------------------------|---------------|
| `W` / `↑`      | `forward = 1`                          | `forward = 0` |
| `S` / `↓`      | `forward = −1`                         | `forward = 0` |
| `A`            | `strafe = −1` (left)                   | `strafe = 0`  |
| `D`            | `strafe = +1` (right)                  | `strafe = 0`  |
| `←`            | `turn = −1` (anticlockwise)            | `turn = 0`    |
| `→`            | `turn = +1` (clockwise)                | `turn = 0`    |
| `ShiftLeft`/`ShiftRight` | `sprint = true`               | `sprint = false` |

- `keydown` auto-repeat is ignored (`e.repeat` guard).
- Clicking `target` calls `target.requestPointerLock()` (pointer lock).
- `mousemove` accumulates `movementX`/`movementY` into `lookDx`/`lookDy` **only
  while** `document.pointerLockElement === target`.
- `readInput()` returns the current directional state and the accumulated look
  deltas, then zeroes the look deltas (they are consumed per frame).
- `dispose()` removes every listener — safe to call on teardown.

## Changing sensitivity

- **Turn speed** — set `TURN_SPEED` (rad/s), default `Math.PI / 2`.
- **Mouse sensitivity** — set `MOUSE_SENS` (rad/px), default `0.0025`.
- **Walk/sprint speed** — set `WALK_SPEED` / `SPRINT_SPEED` (m/s), defaults
  `3` / `9`.
- **Pitch clamp** — set `PITCH_LIMIT`, default `Math.PI / 3` (60°).

These constants are exported from `src/player/controls.ts`; changing a value
there recompiles the game with the new feel.
