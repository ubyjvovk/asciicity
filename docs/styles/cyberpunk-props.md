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
  roads, every `LAMP_SPACING = 32` m of centreline, alternating sides, at
  `ROAD_WIDTH[cls]/2 + 0.8` m from the centreline, seated on `groundAt`
  (`y = heightAt(x, z)`). A bridge road's lamp closer than 10 m to an
  already-placed lamp is skipped (its endpoint overlaps the connected street).
  `Lamp = { x, y, z, dirX, dirZ }` — base position + the unit horizontal arm
  direction pointing back at the road.
- **Cables** on `residential / service / pedestrian` roads (service gets
  cables but no lamps), every `CABLE_SPACING = 25` m, an 8-segment catenary
  spanning road width + 4 m, end height 6–9 m above `groundAt`, sag 1.2 m
  (lowest point = end height − 1.2 m). End height is a deterministic hash of
  the road id + cable index.

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

Cover: 320 m primary → 10 lamps (±1) alternating at the spec offset with the
arm toward the road; footway/service no lamps, residential yes; cable classes
and 25 m spacing; lowest catenary point = end height − 1.2 m; sloped-heightAt
seating; London tile `0_0` totals (lamps 300–1 200, triangles ≤ 250 000);
determinism.
