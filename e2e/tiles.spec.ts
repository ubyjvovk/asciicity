/**
 * Sector-streaming e2e (architecture.md §4.19, T-0095 / T-0096). Boots every
 * shipped city tiled with a small `?tileradius=` and asserts
 * `__asciicity.tiles.loaded` is non-empty at `ready`. The SF case also
 * teleports across a tile boundary and checks `loaded` / `pending` /
 * `version` / `disposed`. Never edits smoke/sf/ships/loading specs.
 */
import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

/** Shape of the `__asciicity.tiles` debug surface. */
interface TilesApi {
  ready?: boolean;
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
