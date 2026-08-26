# HUD (NAVIGATION panel)

Pure formatters in `src/hud/format.ts`, a named-road / place index in
`src/hud/zone.ts`, and the DOM panel in `src/hud/hud.ts` (imports `hud.css`).
`format.ts` and `zone.ts` never touch `document` / `window`. Wiring into the
frame loop is T-0010.

## Row formats

`hudRow(label, value)` is `label.padEnd(11, '.') + ' ' + value`.

| Label   | Formatter                         | Example                         |
|---------|-----------------------------------|---------------------------------|
| SECTOR  | `sectorOf(x, z, cell = 100)`      | `E00 / N01`                     |
| WORLD   | `formatWorld(x, z)`               | `1234.50 / -321.00`             |
| BEARING | `formatBearing(deg)`              | `267 DEG / WEST`                |
| ZONE    | `ZoneIndex.zoneLabel(x, z)`       | `CHEAPSIDE` / `NEAR BANK` / `CITY` |
| ALT     | `formatAlt(m, unit = 'ASL')` (only when defined)| `156 M ASL` / `12 M AGL` |
| LANDMARK| `ZoneIndex.nearestLandmark` name  | `ST PAUL'S CATHEDRAL` / `-`        |
| MODE    | `HudValues.mode` (only when defined) | `FLY`                      |
| FPS     | integer (`Math.round`)            | `60`                            |

The `<pre class="hud-rows">` text is those six to eight `hudRow` lines, each
prefixed with `> `. Order: SECTOR, WORLD, BEARING, ZONE, then `ALT` (only
when `HudValues.alt` is defined), `LANDMARK`, then `MODE` (only when
`HudValues.mode` is defined), then `FPS`:

- **ALT** sits fourth — between ZONE and LANDMARK — and is emitted only when
  `HudValues.alt` is defined. On flat cities (no `city.terrain`) it stays
  undefined **unless** the player is flying, when it reads AGL
  (`formatAlt(agl, 'AGL')`, metres above the ground); on terrain cities it is
  always ASL. Unset on flat London when not flying so the panel keeps the
  classic six rows.
- **MODE** sits sixth — between LANDMARK and FPS — and is emitted only while
  flying (`HudValues.mode = 'FLY'`).

So the panel is 6 rows (flat, grounded), 7 (either ALT or MODE), or 8 (both
ALT and MODE on a terrain city while flying).

### `formatBearing`

Round to nearest integer, modulo 360 into `[0, 359]`, zero-pad to 3 digits.
Compass is 8 sectors of 45° centred on the cardinals / ordinals:

`NORTH, NORTHEAST, EAST, SOUTHEAST, SOUTH, SOUTHWEST, WEST, NORTHWEST`.

- `0` → `"000 DEG / NORTH"`
- `22.4` → `"022 DEG / NORTH"`
- `22.6` → `"023 DEG / NORTHEAST"`
- `45` → `"045 DEG / NORTHEAST"`
- `267` → `"267 DEG / WEST"`
- `359.7` → `"000 DEG / NORTH"`
- `−90` → `"270 DEG / WEST"`

### `formatWorld`

`x.toFixed(2) + ' / ' + z.toFixed(2)`. `formatWorld(1234.5, -321)` →
`"1234.50 / -321.00"`.

### `sectorOf`

`c = floor(x / cell)`, `r = floor(z / cell)` (default `cell = 100`).
East/west: `E` + at-least-two-digit `c` when `c >= 0`, else `W` + `−c`.
South/north: `S` + `r` when `r >= 0`, else `N` + `−r`. Joined with `" / "`.

- `(50, −50)` → `"E00 / N01"`
- `(−150, 250)` → `"W02 / S02"`
- `(0, 0)` → `"E00 / S00"`

### `hudRow`

`hudRow('SECTOR', 'E00 / S00')` → `"SECTOR..... E00 / S00"`.

### `formatAlt`

`formatAlt(m, unit = 'ASL')` returns `` `${Math.round(m)} M ${unit}` ``. Fed with
`city.terrain.datum + groundAt(state.x, state.z)` in the frame loop —
metres above sea level of the ground under the player (`formatAlt(155.6)`
→ `"156 M ASL"`) — or with the height above ground while flying on a flat
city (`formatAlt(agl, 'AGL')` → `"12 M AGL"`). The ALT row is only rendered
when `HudValues.alt` is non-`undefined`.

## Zone rules

`ZoneIndex(roads, places, cell = 50)`:

- Only **named** roads are indexed. Each consecutive pair of points is a
  segment. The segment's axis-aligned bbox, expanded by **30 m**, is written
  into every cell it touches.
- `nearestRoad(x, z)` searches the cell of the query and its 8 neighbours.
  Distance is point-to-segment. Empty index → `null`.
- `nearestPlace(x, z)` is a linear Euclidean scan of every place.
- `zoneLabel(x, z)`:
  1. If a named road is within **25 m** (inclusive) → that name, upper-cased.
  2. Else if a place is within **300 m** (inclusive) → `"NEAR "` + name
     upper-cased (e.g. `"NEAR BANK"`).
  3. Else `"CITY"`.

A long named segment is found from its middle because the expanded bbox
covers every cell along (and around) it.

## Landmark rules

The `LANDMARK` row names the nearest **named** building the player is facing.
`ZoneIndex(roads, places, cell = 50, buildings = [])` takes an optional fourth
argument.

- Only **named** buildings (`name` set) are indexed; each footprint's centroid
  (mean of `poly` points) is written into its 50 m cell in a separate bucket
  map from roads.
- `nearestLandmark(x, z, yaw, maxDist = 80, halfAngle = π/4)` searches the
  cells around `(x, z)` covering `rings = max(1, ceil(maxDist / cell))`
  rings. For each named building it computes:
  - `dist` — Euclidean distance from `(x, z)` to the centroid;
  - `angle` — the angle between the forward vector `(sin yaw, −cos yaw)` and
    the vector `(cx − x, cz − z)` from the player to the centroid.
- A building qualifies when `dist <= maxDist` **and** `angle <= halfAngle`;
  the nearest qualifying building is returned, else `null`.
- Unnamed buildings, buildings beyond `maxDist`, and buildings outside the
  ±`halfAngle` cone of the heading are all ignored.

`Hud.update` renders the `LANDMARK` row (via `hudRow`) after `ZONE` and before
`FPS`, showing `-` when no landmark is found (`landmark` is undefined).

## DOM panel

`new Hud(root)` appends, using `textContent` only (no `innerHTML`):

1. `div.hud-title` — `::: NAVIGATION`
2. `pre.hud-rows` — the five `> ` rows; `update` rewrites this node only
3. `div.hud-help` — `WASD MOVE · MOUSE LOOK · SHIFT RUN · F FLY`

The second constructor argument `help` defaults to that desktop help text
and is passed by `main.ts` as `'LEFT: MOVE · RIGHT: LOOK'` when the touch
path is active (T-0031).

Styles (`hud.css`): `#48e06a` monospace 13 px on black; title brighter
(`#8aff9e`); help dim (`#2a8040`).

## Compact breakpoint

At `(max-width: 700px)` the panel shrinks so it no longer covers the right
side of a phone viewport (T-0031):

- `src/style.css` `#hud`: width `176 px`, padding `6px 8px`; `#hud .minimap`
  width/height `90 px` (CSS box only — the canvas keeps its 180 px backing
  store).
- `src/hud/hud.css`: `.hud-rows` `10 px`, `.hud-title` `11 px`,
  `.hud-help` `9 px`.

`#hud` is `pointer-events: none` at all sizes — it is display-only, so
look-drags across it reach the canvas instead of being eaten.
