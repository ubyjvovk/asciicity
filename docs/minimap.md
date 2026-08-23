# Minimap (`src/hud/minimap.ts`)

A small heading-up 2D canvas of nearby building footprints, roads, the player
as an arrow at the centre, and a north marker. Pure projection
(`worldToMinimap`) and cell lookup (`nearbyCells`) run in node; `Minimap`
draws on a provided `<canvas>` and has no top-level DOM access. Wiring into
`main.ts` is a later ticket.

## Exports

```ts
export interface MinimapOptions {
  size: number;       // canvas px, default 180
  radius: number;     // metres centre→edge, default 160
  headingUp: boolean; // default true
}
export function worldToMinimap(
  px: number, pz: number,
  player: { x: number; z: number; yaw: number },
  opts: MinimapOptions,
): [number, number]
export function nearbyCells(x: number, z: number, radius: number, cell: number): string[]
export class Minimap {
  constructor(canvas: HTMLCanvasElement, city: CityData, opts?: Partial<MinimapOptions>)
  update(player: { x: number; z: number; yaw: number }): void
}
```

Coordinates follow `docs/architecture.md` §3: `x` east, `z` south, yaw `0`
faces north (`−z`), forward = `(sin yaw, −cos yaw)`.

## Projection

`dx = px − player.x`, `dz = pz − player.z`.

When `headingUp`:

```
rx = dx·cos(yaw) + dz·sin(yaw)
rz = −dx·sin(yaw) + dz·cos(yaw)
```

so the player's forward vector maps straight up the canvas (negative canvas
`y`). Otherwise `rx = dx`, `rz = dz` (north-up: east is right, south is down).

Scale `k = (size / 2) / radius`. Result:

```
[size/2 + rx·k,  size/2 + rz·k]
```

A point one `radius` due north of a yaw-0 player at the origin lands on the
top edge; a point at `2 × radius` falls outside `[0, size]`. The player's own
position is always the canvas centre.

## Cell grid

The constructor buckets every building footprint and every road segment into a
**100 m** cell grid once (same spatial-hash pattern as `ZoneIndex` in
`src/hud/zone.ts`). Keys are `"c,r"` with `c = floor(x / 100)`,
`r = floor(z / 100)`. A footprint or segment that straddles several cells is
stored (by object identity) in each one.

`nearbyCells(x, z, radius, cell)` returns the keys of cells whose square
intersects the **circle's bounding box** `[x±radius] × [z±radius]`. At the
origin with `radius = 100`, `cell = 100` that is the 3×3 neighbourhood (9
keys). A query whose box sits inside one cell returns a single key.

`update` gathers those cells around the player and draws their contents. It
does not re-bucket or allocate typed arrays.

## Colours (draw order)

| Layer        | Style                                      |
|--------------|--------------------------------------------|
| Background   | filled black `#000`                        |
| Roads        | 1 px strokes `#2a8040`                     |
| Buildings    | filled polygons `#1f5a2a`; named `#48e06a` |
| Player       | filled 6 px triangle `#8aff9e` at centre   |
| North marker | letter `N`, `#8aff9e`, 10 px monospace     |

The player triangle points up when `headingUp`; otherwise it is rotated by
`yaw` (canvas `rotate`, which is clockwise, matching yaw 0 = north / yaw
`+π/2` = east on a north-up map).

The `N` is placed **8 px inside the canvas edge** along the projected world-north
direction (up when `headingUp` is false, or when yaw is 0). The glyph itself
stays upright.

CSS (`src/hud/minimap.css`, imported by `minimap.ts`):

```css
.minimap {
  display: block;
  margin-top: 8px;
  border: 1px solid #1f5a2a;
  image-rendering: pixelated;
}
```

## How to wire it

The canvas lives inside `#hud`, under the NAVIGATION rows. A later ticket
will append it from `main.ts` / `Hud`; until then:

```ts
import { Minimap } from './hud/minimap';

const canvas = document.createElement('canvas');
hudRoot.append(canvas);           // #hud, below the row <pre>
const minimap = new Minimap(canvas, city); // size 180, radius 160, headingUp

// each frame, after stepPlayer:
minimap.update(player);
```

`new Minimap` sets `canvas.width` / `height` to `opts.size` and adds the
`.minimap` class. Pass `{ headingUp: false }` for a north-up map.
