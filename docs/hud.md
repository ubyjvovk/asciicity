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
  `HudValues.alt` is defined. It is always the **eye altitude** (where the
  camera is, not the ground below). On flat cities (no `city.terrain`) it
  stays undefined **unless** the player is flying, when it reads AGL
  (`formatAlt(agl, 'AGL')`, metres of eye above the ground); on terrain cities
  it is always ASL (`datum + state.y − EYE_HEIGHT`). Unset on flat London when
  not flying so the panel keeps the classic six rows.
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
`city.terrain.datum + state.y − EYE_HEIGHT` in the frame loop — the **eye
altitude** in metres above sea level (`formatAlt(305.6)` → `"306 M ASL"`) —
or with the eye height above ground while flying on a flat city
(`formatAlt(agl, 'AGL')` → `"12 M AGL"`). On the ground the eye altitude
equals the ground height (`y − EYE_HEIGHT === groundAt`), so the walking row
is unchanged. The ALT row is only rendered when `HudValues.alt` is
non-`undefined`.

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

## Floating landmark tags

`src/hud/tags.ts` — pure `landmarkAnchors` / `pickTags` plus a thin DOM
`Tags` class (architecture.md §4.13). Only buildings that carry a landmark
fix (or an extra appended by `applyLandmarks`) get a tag.

`landmarkAnchors(city, fixesForCity, heightAt = FLAT_HEIGHT)` returns
`{ name, label, x, y, z }[]` for every named building whose exact name is a
key in `fixesForCity`, and for extras (`id <= −1000`). `label` is
`fix.label` when set, else the building name — except for extras
(`id <= −1000`), which always use their own `name`, never the fix label
(an extra sharing an OSM building's name still tags with its own name).
`x`/`z` are the footprint
centroid; `y` is `roofY + 4` where `roofY` is `max(heightAt over the ring)
+ h` — the same roof the building mesh uses. `heightAt` defaults to
`FLAT_HEIGHT` so London / synthetic stay at `y = h + 4`.

`pickTags(anchors, px, pz, maxDist = 600, max = 8)` returns the nearest
`max` anchors whose 2-D (x/z) distance to the player is `<= maxDist`
(inclusive), nearest first. Farther landmarks are dropped.

`new Tags(root)` fills `root` with a **fixed pool of 8** `div.tag` elements
(no per-frame allocation). `update(anchors, camera, w, h)` projects each
anchor with `THREE.Vector3.project(camera)`, hides when NDC `z > 1` (behind
the camera) or the pixel is outside `[0, w] × [0, h]`, and sets CSS
`left`/`top` from NDC (`left = (x·0.5+0.5)·w`, `top = (−y·0.5+0.5)·h`).

`main.ts` builds the anchor list once after `applyLandmarks`, calls
`tags.update(pickTags(...), camera, w, h)` every 4th frame, and honours
`?tags=0` (no container, no updates). The `#tags` overlay is
`pointer-events: none`. CSS (`src/style.css`): `div.tag` is 11 px
monospace, HUD green on black at 70 %.

## DOM panel

`new Hud(root)` appends, using `textContent` only (no `innerHTML`):

1. `div.hud-title` — `::: NAVIGATION`
2. `pre.hud-rows` — the five `> ` rows; `update` rewrites this node only
3. `div.hud-help` — the help line supplied by `main.ts` (see below)

On desktop `main.ts` passes `'WASD MOVE · MOUSE LOOK · SHIFT RUN · F FLY ·
R STYLE · P POSTCARD · ESC MENU'`; it lists the render key (`R`), then the
postcard key (`P`, T-0072), and ends with `ESC MENU` because on desktop the
pause/settings menu opens via Escape (T-0068). On touch it passes
`'LEFT: MOVE · RIGHT: LOOK · R STYLE'` unchanged (T-0031).

Styles (`hud.css`): `#48e06a` monospace 13 px on black; title brighter
(`#8aff9e`); help dim (`#2a8040`).

## Compact breakpoint

At `(max-width: 700px)` the panel shrinks so it no longer covers the right
side of a phone viewport (T-0031):

- `src/style.css` `#hud`: width `176 px`, padding `6px 8px`.
- `src/hud/hud.css`: `.hud-rows` `10 px`, `.hud-title` `11 px`,
  `.hud-help` `9 px`.

`#hud` is `pointer-events: none` at all sizes — it is display-only, so
look-drags across it reach the canvas instead of being eaten.

## Layout (T-0060)

The NAVIGATION panel is **top-right** (`#hud`). The heading-up minimap is a
separate **top-left** panel (`#mini`, 180 px; 120 px under the 700 px
breakpoint) holding `<canvas id="minimap">` — it is no longer a child of
`#hud`. `H` hides/shows `#hud`, `M` hides/shows `#mini` (`display: none`,
and the matching per-frame update is skipped). Both panels are created at
boot even when `?hud=0` / `?minimap=0` (those flags start them hidden).

A ⚙ `#gear` button sits **bottom-right** (40×40 px, **touch devices only**
— under pointer lock nothing is clickable on desktop and the Esc overlay
covers it, so main.ts sets `gear.hidden = !touch` with the same
`'ontouchstart'`/`maxTouchPoints` test TouchControls uses). It opens the
pause/settings menu. The `#credits` footer is a **20 px black bar across
the very bottom of the page** (T-0068): `#view` is `calc(100vh − 20px)`
tall, `applySize()` passes `innerHeight − 20` to the canvas and camera
aspect, and `#gear`/`#toast` sit at `bottom: calc(20px + 16px)` so nothing
overlaps the bar.
## Postcard export (T-0072 / T-0073)

`P` (desktop, no modifier) downloads the current frame as a PNG via
`src/export/postcard.ts` (architecture.md §4.15) — a 28-px caption bar is
appended **below** the frame (never covering it). The bar reads
`ASCIICITY · <CITY LABEL>` (the registry's upper-cased label, e.g.
`SAN FRANCISCO`); the filename is `asciicity-<cityId>-<yyyymmdd-hhmmss>.png`
(the compact id, e.g. `sf` — labels contain spaces).

`Shift+P` records a 3-second · 12 fps animated GIF (36 frames on an 83.3 ms
wall-clock schedule, scaled to at most 960 px wide with
`imageSmoothingEnabled = false`, same caption bar on every frame) and
downloads it as `asciicity-<cityId>-<yyyymmdd-hhmmss>.gif`. Toasts: `REC ●`
at the start of capture, `ENCODING…` when the 36 frames are in, and
`POSTCARD SAVED` after the download. Re-entrant `Shift+P` / menu / hook
calls while a recording is in flight share the same in-flight promise.

Touch players have no `P` / `Shift+P`, so the pause/settings menu carries
`SAVE PNG` and `RECORD GIF (3S)` `menuButton`s directly under the `STYLE:`
row (GIF under PNG); each dismisses the overlay the way CLICK TO RESUME
does, waits two `requestAnimationFrame`s, then runs the same capture path.
`POSTCARD SAVED` is toasted only when a download was requested (the silent
`window.__asciicity.postcard('png' | 'gif')` test hook does not toast it).
See `docs/integration.md` for the full menu rows, persistence, and keys.
