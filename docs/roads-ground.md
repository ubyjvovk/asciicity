# Roads and ground

Module notes for `src/world/roads.ts` and `src/world/ground.ts` (architecture.md
§4.4–§4.5).

## Road widths

`ROAD_WIDTH` is metres of ribbon width. A segment of class `cls` is extruded
`± ROAD_WIDTH[cls] / 2` from the centre-line.

| class        | width (m) |
| ------------ | --------- |
| primary      | 12        |
| secondary    | 9         |
| tertiary     | 7         |
| residential  | 6         |
| service      | 4         |
| pedestrian   | 4         |
| footway      | 2         |

## Colours

Vertex colours are linear rgb from `THREE.Color(hex)`:

| classes            | hex       |
| ------------------ | --------- |
| primary, secondary | `0x585858` |
| all others         | `0x404040` |

## Ribbons

`buildRoadsMesh(roads, heightAt = FLAT_HEIGHT)` and
`makeRoadsObject(roads, heightAt = FLAT_HEIGHT)` drape each polyline over
`heightAt`. `ROAD_LIFT = 0.15` is the metres the ribbon sits above the
sampled ground (or the bridge deck). With the default `FLAT_HEIGHT` every
vertex is at `y = 0.15`.

For each polyline segment `p→q` of length `len`, split into
`n = max(1, ceil(len / 10))` equal sub-segments and emit one un-mitred
quad per sub-segment, normal `(0, 1, 0)`, uv `(0, 0)`. Degenerate
segments (length 0) are skipped. Overlaps at corners are intentional.

- Ordinary road: each of the four quad corners (left/right offsets
  included) gets `y = heightAt(corner.x, corner.z) + ROAD_LIFT`.
- `bridge: true` road: `ys = bridgeProfile(road.pts, heightAt)` (from
  `src/world/terrain.ts`) gives one deck height per polyline vertex. A
  sub-segment corner at fraction `f` along segment `i` gets
  `y = lerp(ys[i], ys[i+1], f) + ROAD_LIFT` — both edges identical, so
  the deck is flat across.

The result is a single material group
`{ start: 0, count: N, materialIndex: 0 }`.

`makeRoadsObject` wraps that soup in `MeshBasicMaterial({ vertexColors: true })`.

## Grid texture scale

`makeGridTexture` paints a 256×256 canvas: background `#050505`, 1-px lines
`#1f5a2a` every 32 px on both axes (8 cells per tile). Wrap is
`RepeatWrapping`, filter `LinearFilter`.

`makeGround(size = 6000)` builds `PlaneGeometry(size, size)` rotated onto
`y = 0` and sets `texture.repeat` to `size / 40` on both axes. One tile is
therefore 40 m, so a grid line falls every 5 m.
