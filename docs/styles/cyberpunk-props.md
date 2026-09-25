# cyberpunk — street props (T-0155)

Sodium street lamps, overhead cables and real point lights for the
`cyberpunk` night city (wave 20b, `docs/architecture.md` §4.11 "cyberpunk v2"
→ "Street props"). Pure placement/geometry lives in
`src/render/punk/propsmesh.ts` (unit-tested, no `three/webgpu`); the
`props` layer in `src/render/punk/props.ts` streams it in cells and owns the
shared node materials.

## Modules

| file | what |
|---|---|
| `propsmesh.ts` (pure) | `placeLamps`, `placeCables`, `buildPropsMesh` |
| `props.ts` (browser) | `PropsLayer`: CellStreamer + materials + point lights |

## Placement

- **Lamps** on `primary / secondary / tertiary / residential / pedestrian`
  roads. City roads are chopped into many short OSM ways, so candidates start
  at `LAMP_SPACING/2 = 16` m along EACH way and repeat every `LAMP_SPACING =
  32` m (16, 48, 80, …); a way shorter than 32 m but ≥ 8 m gets one candidate
  at its midpoint. Sides alternate per way (even k → left, odd → right; single
  candidates → left), at `ROAD_WIDTH[cls]/2 + 0.8` m from the centreline,
  seated on `groundAt` (`y = heightAt(x, z)`). Candidates are de-duplicated
  **globally across all ways**: a base within `LAMP_DEDUP = 12` m of an
  already accepted lamp is dropped (spatial hash, cell 12 m). `Lamp = { x, y,
  z, dirX, dirZ }` — base position + the unit horizontal arm direction
  pointing back at the road.
- **Building push-out (narrow streets, rework 1):** `placeLamps` takes an
  optional `buildings` list (the streamer passes `cell.buildings`). A
  candidate base inside a footprint or within `EDGE_MARGIN = 0.6` m of one is
  pushed toward the centreline in `PUSH_STEP = 0.5` m steps down to
  `MIN_LAMP_OFFSET = 1.5` m; if still blocked the lamp is skipped (poles stay
  out of facades on streets narrower than the class width). Footprints are
  indexed in a 20 m spatial bucket (`pointInPolygon` / `distToPolygon`), so
  per-cell builds stay near O(n) (≤ 10 ms on london `0_0` cells; measured
  ≈ 3.9 ms). The arm keeps pointing at the road.
- **Cables** on `residential / service / pedestrian` roads (service gets
  cables but no lamps). Candidates start at `CABLE_SPACING/2 = 12.5` m along
  EACH way and repeat every `CABLE_SPACING = 25` m; a way ≥ 10 m but < 25 m
  gets one at its midpoint. Each cable is an 8-segment catenary spanning road
  width + 4 m, end height 6–9 m above `groundAt`, sag 1.2 m (lowest point =
  end height − 1.2 m). End height is a deterministic hash of the road id +
  arc length. With `buildings`, each end is clipped to the first footprint
  edge it crosses from the centreline outward (cables end on walls, not
  through buildings); a cable whose clipped end is still > 2 m inside a
  footprint is dropped. Cables are de-duplicated globally (centreline base
  within `CABLE_DEDUP = 8` m of an accepted one).

## Geometry (`buildPropsMesh`)

| mesh | contents | material groups / UVs |
|---|---|---|
| `solid` | pole (0.15×7 m), arm (1.8 m toward road, 0.1 m), head (0.6×0.2×0.3 m), cable ribbon (0.04 m, double-sided) | group 0 = dark body, group 1 = emissive heads |
| `cones` | open 8-segment cone head→ground, radius 3.5 m | `uv.y` 0 (head) → 1 (ground) |
| `pools` | 4 m disc at ground +0.03 m | `uv.x` 0 (centre) → 1 (edge) |

## Layer (`props.ts`)

- Streams cells via `CellStreamer` (buildRadius 450, disposeRadius 600,
  maxBuildsPerFrame 1); one merged mesh per type per cell, materials shared.
- **Materials:** solid body/heads `MeshStandardNodeMaterial` (head emissive
  sodium `(1.0, 0.55, 0.2) × 3`); cones/pools `MeshBasicNodeMaterial`
  transparent, `depthWrite: false`, `AdditiveBlending`, fog on, opacity from a
  UV falloff node — cones `0.06·(1 − uv.y)` (fade to 0 at the ground), pools
  `0.22·(1 − uv.x)` (radial fade).
- **Point lights:** 4 warm `PointLight`s (intensity 30, distance 18, decay 2)
  created once in `attach` and added to the root; every 0.5 s re-assigned to
  the nearest lamps within 60° of the view direction
  (`camera.getWorldDirection`); removed in `detach`. Unused lights are hidden.
- `rainPassThrough: true` — cones/pools glow volumes rain falls through.
- **Stats:** `props.lamps`, `props.cables`, `props.lights` (active),
  `props.triangles`, plus the streamer's `cells` / `pending` / `buildMs`.

## Tests (`tests/punk-props.test.ts`)

Cover: 320 m primary → 10 lamps at 16…304 m alternating at the spec offset
with the arm toward the road; footway/service no lamps, residential yes;
**short ways** (< 32 m, ≥ 8 m) get one midpoint lamp each (8 m → 1, 7 m → 0);
**chained short ways** along a straight line give lamps ~every 32 m with no
two within 12 m; cable classes and 25 m spacing; lowest catenary point = end
height − 1.2 m; sloped-heightAt seating; **building push-out** (overhanging
wall → offset ≤ 3.4 m & outside; no free spot ≥ 1.5 m → skipped; determinism);
**cable clipping** (ends on/within 2 m of a footprint edge or at the span end
when no building is hit); London tile `0_0` per-cell — no lamp base inside any
footprint, total lamps 200–1 200 (measured 575), whole-tile triangles ≤
250 000, max per-cell build < 50 ms; **bank region** (all tiles, `bucketSources`,
x∈[−150,0], |z|<30) ≥ 8 lamps (measured 12) with none inside any footprint;
determinism.
