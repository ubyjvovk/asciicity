/**
 * Sector-streaming e2e (architecture.md §4.19, T-0095 / T-0096). Boots every
 * shipped city tiled with a small `?tileradius=` and asserts
 * `__asciicity.tiles.loaded` is non-empty at `ready`. The SF case also
 * teleports across a tile boundary and checks `loaded` / `pending` /
 * `version` / `disposed`. Never edits smoke/sf/ships/loading specs.
 */
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

/** Shape of the `__asciicity.tiles` debug surface. */
interface TilesApi {
  ready?: boolean;
  /** Eye height in metres (mirrors `state.y` every frame). */
  y?: number;
  /** Live player pose — the position surface sampled on each poll. */
  state?: { x: number; y: number; z: number; yaw: number; pitch: number };
  tiles?: {
    loaded: string[];
    pending: number;
    version: number;
    disposed: number;
  };
}

/** Wait until `__asciicity.ready` is true (SF tiled boot — allow 90 s). */
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __asciicity?: { ready?: boolean } }).__asciicity;
      return api?.ready === true;
    },
    undefined,
    { timeout: 90_000 },
  );
}

async function readTiles(page: Page): Promise<{
  loaded: string[];
  pending: number;
  version: number;
  disposed: number;
}> {
  return page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: TilesApi }).__asciicity;
    return {
      loaded: api?.tiles?.loaded ?? [],
      pending: api?.tiles?.pending ?? -1,
      version: api?.tiles?.version ?? -1,
      disposed: api?.tiles?.disposed ?? -1,
    };
  });
}

const TILED_CITIES = ['london', 'kyiv', 'sf', 'nyc'] as const;

for (const id of TILED_CITIES) {
  test(`tiles: boot ?city=${id}&tileradius=600 at default spawn → ready with loaded tiles`, async ({
    page,
  }) => {
    await page.goto(`/?city=${id}&tileradius=600`);
    await waitReady(page);
    const tiles = await readTiles(page);
    expect(tiles.loaded.length).toBeGreaterThan(0);
  });
}

// §4.21 CARS toggle: ?cars=0 boots to `ready` without exercising the fleet's
// visible update path, so the toggle is at least exercised headlessly.
test('tiles: boot ?city=london&tileradius=600&cars=0 → ready', async ({ page }) => {
  await page.goto('/?city=london&tileradius=600&cars=0');
  await waitReady(page);
  const tiles = await readTiles(page);
  expect(tiles.loaded.length).toBeGreaterThan(0);
});

test('tiles: boot ?city=sf&tileradius=600, pending drains, crossing a tile unloads', async ({
  page,
}) => {
  // Default spawn is `ggb` (deck). Fly so the later teleport is noclip.
  await page.goto('/?city=sf&tileradius=600&fly=1');
  await waitReady(page);

  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __asciicity?: TilesApi }).__asciicity;
      const t = api?.tiles;
      return (
        api?.ready === true &&
        Array.isArray(t?.loaded) &&
        (t?.loaded.length ?? 0) > 0 &&
        t?.pending === 0
      );
    },
    undefined,
    { timeout: 90_000 },
  );

  const start = await readTiles(page);
  expect(start.loaded.length).toBeGreaterThan(0);
  expect(start.pending).toBe(0);
  expect(start.version).toBeGreaterThan(0);

  // GGB is the NW corner of the bbox; +x/+z flies toward downtown so new
  // tiles enter the wanted set and the original 3×3 can unload (unloadR = 780).
  await page.evaluate(() => {
    const api = (
      window as unknown as { __asciicity?: { state?: { x: number; z: number } } }
    ).__asciicity;
    if (api?.state) {
      api.state.x += 2500;
      api.state.z += 1500;
    }
  });

  await page.waitForFunction(
    (prev) => {
      const api = (window as unknown as { __asciicity?: TilesApi }).__asciicity;
      const t = api?.tiles;
      if (!t) return false;
      const loadedChanged = t.loaded.join(',') !== prev.loaded.join(',');
      return loadedChanged && t.version > prev.version && t.disposed > prev.disposed;
    },
    { loaded: start.loaded, version: start.version, disposed: start.disposed },
    { timeout: 30_000 },
  );

  const after = await readTiles(page);
  expect(after.loaded.join(',')).not.toBe(start.loaded.join(','));
  expect(after.version).toBeGreaterThan(start.version);
  expect(after.disposed).toBeGreaterThan(start.disposed);
});

test('tiles: long fly across ≥ 3 tile widths stays bounded, disposes, and holds the 3×3 (no fall-through)', async ({
  page,
}) => {
  // SwiftShader caps effective fly speed (~35 m/s under streaming load), so
  // the minimal ≥ 3000 m cross takes ~85 s of real flight. Give just this
  // test extra headroom; on faster hosts it finishes in ~45 s.
  test.setTimeout(180_000);
  // SF tile extent is 1000 m; the bbox + spawn layout is the same one the
  // crossing test above uses, so tile keys / radii carry over unchanged.
  const S = 1000;
  await page.goto('/?city=sf&tileradius=600&fly=1');
  await waitReady(page);
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __asciicity?: TilesApi }).__asciicity;
      const t = api?.tiles;
      return (
        api?.ready === true &&
        Array.isArray(t?.loaded) &&
        (t?.loaded.length ?? 0) > 0 &&
        t?.pending === 0
      );
    },
    undefined,
    { timeout: 90_000 },
  );

  // Face due east (yaw = +π/2, level pitch) from the GGB spawn so the flight
  // sweeps across tile columns toward downtown, well inside the tiled bbox.
  const start = await page.evaluate(() => {
    const a = (window as unknown as {
      __asciicity: { state: { x: number; y: number; z: number; yaw: number; pitch: number } };
    }).__asciicity;
    const s = a.state;
    s.yaw = Math.PI / 2;
    s.pitch = 0;
    return { x: s.x, y: s.y, z: s.z };
  });
  const startY = start.y;

  // Fly (sprint) — 90 m/s, noclip, level → real-time movement, no collision.
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');

  let maxLoaded = 0;
  let disposedChanges = 0;
  let versionChanges = 0;
  let prevDisposed = -1;
  let prevVersion = -1;
  let maxDist = 0;

  const deadline = Date.now() + 170_000;
  while (Date.now() < deadline) {
    const p = await page.evaluate(() => {
      const a = (window as unknown as { __asciicity?: TilesApi }).__asciicity;
      const s = a?.state as { x: number; y: number; z: number } | undefined;
      return {
        x: s?.x ?? NaN,
        y: s?.y ?? NaN,
        z: s?.z ?? NaN,
        apiY: a?.y ?? NaN,
        loaded: a?.tiles?.loaded?.length ?? 0,
        pending: a?.tiles?.pending ?? 0,
        disposed: a?.tiles?.disposed ?? 0,
        version: a?.tiles?.version ?? 0,
      };
    });

    // No fall-through through any tile boundary: position stays finite and
    // the eye height never sinks below the takeoff altitude (a level fly only
    // ever clamps UP when terrain rises — a ground gap / NaN height breaks this).
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(Number.isFinite(p.z)).toBe(true);
    expect(Number.isFinite(p.apiY)).toBe(true);
    expect(p.y).toBeGreaterThanOrEqual(startY - 1e-3);

    // Loaded set stays bounded while crossing (tileradius=600 → a few tiles).
    maxLoaded = Math.max(maxLoaded, p.loaded);
    expect(p.loaded).toBeLessThanOrEqual(36);
    expect(p.pending).toBeLessThanOrEqual(20);

    if (p.disposed > prevDisposed) disposedChanges += 1;
    if (p.version > prevVersion) versionChanges += 1;
    prevDisposed = p.disposed;
    prevVersion = p.version;

    const dist = Math.hypot(p.x - start.x, p.z - start.z);
    maxDist = Math.max(maxDist, dist);
    if (dist >= 3050) break;
    await page.waitForTimeout(400);
  }

  await page.keyboard.up('w');
  await page.keyboard.up('Shift');

  // Crossed ≥ 3 tile widths (each 1000 m).
  expect(maxDist).toBeGreaterThanOrEqual(3000);
  // Dispose accounting: the trailing tiles actually unloaded while the fly
  // was in motion, and new tiles were added (residency changed).
  expect(disposedChanges).toBeGreaterThan(0);
  expect(versionChanges).toBeGreaterThan(0);

  const end = await page.evaluate(() => {
    const s = (window as unknown as { __asciicity: { state: { x: number; z: number } } }).__asciicity
      .state;
    return { x: s.x, z: s.z };
  });

  // The player's current 3×3 is always wanted, so every EXISTING tile in it
  // must be resident once the fly stops. SF's tiled index is sparse (a tile
  // exists only for populated cells), so intersect the 3×3 with the index's
  // keys — absent cells have nothing to load.
  const pi = Math.floor(end.x / S);
  const pj = Math.floor(end.z / S);
  const indexTiles = new Set(
    Object.keys(
      (JSON.parse(
        readFileSync('public/data/sf/index.json', 'utf8'),
      ) as { tiles: Record<string, unknown> }).tiles,
    ),
  );
  const need = new Set<string>();
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) need.add(`${pi + di}_${pj + dj}`);
  }
  const needExisting = [...need].filter((k) => indexTiles.has(k));
  expect(needExisting.length).toBeGreaterThan(0);
  await page.waitForFunction(
    (keys: string[]) => {
      const loaded = (window as unknown as { __asciicity?: TilesApi }).__asciicity?.tiles
        ?.loaded ?? [];
      return keys.every((k) => loaded.includes(k));
    },
    needExisting,
    { timeout: 30_000 },
  );
  const finalLoaded = await readTiles(page);
  for (const k of needExisting) expect(finalLoaded.loaded).toContain(k);
});
