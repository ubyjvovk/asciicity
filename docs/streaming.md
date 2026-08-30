# Sector streaming — `TileManager` (`src/world/tiles.ts`)

Pure scheduler for 1000 m tiles around the player. No three.js, no DOM;
`main.ts` wiring (meshes, `?tileradius=` URL parsing, HUD/bus rebuilds) is
T-0095. Contract: `docs/architecture.md` §4.19; tile files:
`docs/data-format.md` "Tiled datasets".

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
