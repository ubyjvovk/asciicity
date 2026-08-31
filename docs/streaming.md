# Sector streaming — `TileManager` (`src/world/tiles.ts`)

Pure scheduler for 1000 m tiles around the player. No three.js, no DOM.
`main.ts` wires meshes, `?tileradius=` URL parsing, HUD/bus rebuilds, and
the tiled boot path (this file, Integration). Contract:
`docs/architecture.md` §4.19; tile files: `docs/data-format.md` "Tiled
datasets".

## Exports

```ts
new TileManager(index: TileIndexData, loadTile: (key: string) => Promise<TileData>, opts?: { loadR?: number; unloadR?: number })
update(x: number, z: number): void
take(): TileEvent[]                 // at most one 'add' per call; any number of 'remove's
snapshot(): { buildings: Building[]; roads: Road[]; version: number }
loadedKeys(): string[]
pending(): number                   // in-flight fetches + fetched tiles waiting for take()
type TileEvent = { kind: 'add'; key: string; tile: TileData } | { kind: 'remove'; key: string }
```

`CollisionGrid` (same ticket) gains `addSource(key, buildings, corridors)` /
`removeSource(key)`. Constructor arguments remain a permanent base source;
water rings stay constructor-only.

## Lifecycle

A listed tile (`index.tiles["i_j"]`) moves through:

1. **wanted** — `update(x, z)` recomputes the set. A tile is wanted when it
   is in the index and either (a) it is the player's own tile or one of the
   8 neighbours (the 3×3 is always wanted, regardless of radii) or (b) its
   rect `x ∈ [i·S, (i+1)·S) × z ∈ [j·S, (j+1)·S)` intersects the closed
   square `[x ± loadR] × [z ± loadR]`. With the defaults (`loadR = 2000`,
   `S = 1000`) and the player at rest in the middle of a tile, that square
   is exactly the **5×5** around the player's tile.
2. **fetching** — wanted tiles that are not yet added are requested
   nearest-first (Euclidean distance from the player to the tile centre;
   key string as a tie-break), at most **two** unresolved `loadTile` calls.
   A rejected load is retried **once**; a second failure `console.warn`s
   and **skips** the tile. A skip is sticky only while the tile stays
   wanted — leaving and re-entering the set makes it eligible again, so a
   skip cannot hot-loop.
3. **fetched** — `loadTile` resolved. The tile sits on an internal ready
   queue; `pending()` still counts it. `snapshot()` / `loadedKeys()` do
   **not** include it.
4. **added** — `take()` emits `{ kind: 'add', key, tile }` (at most one
   add per call). Only then is the tile in `loadedKeys()` and in the
   concatenated `snapshot()` arrays. `version` increments once for that
   `take()` if the added set changed; `snapshot()` is reference-stable
   until the next change.
5. **removed** — a loaded tile is dropped only when it is **not** wanted
   **and** its rect lies entirely outside the unload square
   `[x ± unloadR] × [z ± unloadR]` (default `unloadR = 2600`). The 3×3
   therefore never unloads. `take()` flushes **every** pending `remove`
   in the same call. Walking just past a tile boundary and back does not
   emit removes (hysteresis).

`take()` is the only way residency changes become visible: fetch
completion alone is silent. Call it once per frame so mesh builds stay
inside the §4.18 budget.

## Radii and `?tileradius`

| | default | meaning |
|---|---|---|
| `loadR` | 2000 m | half-extent of the wanted square |
| `unloadR` | 2600 m | half-extent of the keep-loaded square |

The ratio `unloadR / loadR = 1.3` is the hysteresis band (600 m at
defaults) that stops a walk along a tile edge from thrashing.

`?tileradius=<m>` is parsed by T-0095, **not** this module. It scales
**both** radii proportionally from the defaults:

```
loadR    = m
unloadR  = m * (2600 / 2000) = 1.3 * m
```

so `?tileradius=500` → `{ loadR: 500, unloadR: 650 }`. Pass those as
`TileManager` opts. e2e uses a small value so a short walk crosses a
tile boundary.

Negative indices keep their minus sign in the key (`"-1_0"`) and
round-trip through fetch → take → snapshot → remove like any other
tile. Bridge roads are global (`index.bridgeRoads`) and never appear in
a tile — the manager never splits or fetches them.

## Collision sources

`CollisionGrid.addSource(key, buildings, corridors)` buckets the
footprints and corridor segments into the same spatial hash `blocked`
already uses (tagged internally by `key`). `removeSource(key)` pulls
those objects back out of their buckets — `blocked` still only visits
the 3×3 neighbourhood of cells, never a linear scan of every source.
The constructor's buildings/corridors are a permanent base source and
cannot be removed; water rings + odd-parity / shore-margin tests stay
constructor-only so island-in-bay behaviour is unchanged when sources
come and go. Re-adding a removed key replaces the previous contents.

## Integration (`main.ts`)

A registry entry with `tiled: true` (`file` = `data/<city>/index.json`,
`sizeBytes` = the committed index size) takes the tiled boot path.
Monolithic cities (`?synthetic=1`, London / Kyiv / NYC) keep the existing
loader. Both paths coexist.

### Boot order

1. **Index** — `loadCityJson` (phase `download`, `sizeHint` = registry
   `sizeBytes`) → `validateTileIndex`.
2. **Spawn** — `resolveSpawn` against `index.landmarks` (first entry per
   name) and `index.bbox` **before any tile fetch**, so the 3×3 is centred
   on the player, not the origin.
3. **Globals** — terrain, water + levels, rivers/boats, ship lanes,
   `bridgeRoads` → chaining + `BridgeDecks` + `groundAt`, plus a permanent
   rendered roads mesh and collision source `'bridges'`. Landmark extras
   (`id ≤ −1000`) are a permanent buildings mesh. `await nextFrame()`
   between builders (phase `build`, §4.18 steps).
4. **Spawn 3×3** — `TileManager.update(spawn)` then `take()` until the
   player's tile and its 8 neighbours that exist in the index are added
   (phase `build`, step `TILE <i>_<j>`; bar = completed / Σ bytes of that
   3×3).
5. **`ready`** — overlay prompt returns. The rest of the 5×5 streams in
   after ready, at most one tile build per frame.

### Frame loop

Each frame: `tiles.update(x, z)` then apply `tiles.take()`. `add` builds
the tile's `THREE.Group` (existing buildings / roads / trees builders,
same `groundAt`) and `collision.addSource(key, …)`; `remove` detaches the
group, disposes geometries/materials, and `removeSource`. ≤ 1 add per
frame comes free from `take()`.

### What rebuilds when

When `snapshot().version` changes, at most once per second, scheduled
**outside** the render path (`setTimeout(0)`):

- `ZoneIndex` from `snapshot().roads` + `index.bridgeRoads` + places +
  snapshot buildings + extras
- tag anchors (`landmarkAnchors` + suspension-bridge tags)
- `minimap.setCity(...)` with a `CityData`-shaped view of the snapshot +
  globals (woods concatenated from resident tiles)
- the bus fleet from `snapshot().roads` + `index.bridgeRoads`, seed
  `9 ^ version` (buses teleport on rebuild — accepted)

Boats and ships are global and never rebuild.

### Debug surface

`window.__asciicity.tiles = { loaded, pending, version, disposed }` is a
live reference, mutated every frame:

| field | meaning |
|---|---|
| `loaded` | keys whose `add` event has been taken |
| `pending` | in-flight fetches + fetched-not-yet-taken |
| `version` | `snapshot().version` (bumps once per mutating `take()`) |
| `disposed` | count of `remove` events applied (geometries disposed) |

### `?tileradius=<m>`

Parsed in `main.ts` (`parseTileRadius`). Scales both radii from the
defaults (`2000 / 2600 × m / 2000`):

```
loadR    = m
unloadR  = 1.3 · m
```

`?tileradius=600` → `{ loadR: 600, unloadR: 780 }`. The e2e uses this so a
short teleport crosses a tile boundary and an original 3×3 tile unloads.

## Verifying streaming

**Debug surface** — live reference, mutated every frame, exposed as
`window.__asciicity.tiles`:

| field | meaning |
|---|---|
| `loaded` | keys whose `add` event has been taken (resident) |
| `pending` | in-flight fetches + fetched-but-not-yet-taken |
| `version` | `snapshot().version` (bumps once per mutating `take()`) |
| `disposed` | count of `remove` events applied (geometries disposed) |

The live player pose is `window.__asciicity.state` (`x`, `y`, `z`, `yaw`,
`pitch`) and `y` mirrors the eye height each frame — together they are the
“no fall-through” position surface sampled per poll. Movement in e2e:
fly mode (`?fly=1`, hold `Shift`+`W`) covers ground fastest; `?tileradius=`
scales both radii so a short run crosses tile boundaries.

**`tests/tiles.test.ts`** covers the scheduler deterministically in node:

- *Thrash guard* — 20 alternating `update()` calls 1 m either side of a tile
  boundary produce ≤ 2 version changes: the hysteresis band (`unloadR`)
  keeps a just-beyond-load-radius tile resident instead of dropping and
  re-fetching it on every toggle.
- *Fetch storm* — a never-resolving `loadTile` while the player crosses many
  tiles keeps unresolved calls ≤ 2 (the `MAX_IN_FLIGHT` cap) and `take()`
  well-behaved (no spurious adds/removes, no throw).

**`e2e/tiles.spec.ts`** boots a tiled city (SF) at `?tileradius=600&fly=1`
and asserts, per poll during a long fly across ≥ 3 tile widths:

- `loaded` never exceeds a radius-derived bound (≤ 36);
- `disposed` strictly increases and `version` increases as the trailing
  tiles unload and leading ones stream in;
- the player's current 3×3 keys are all present in `loaded` after the fly;
- `state.y` stays finite and ≥ its takeoff value through every boundary
  (no fall-through — a ground gap / NaN height would sink or NaN it).
