/**
 * AsciiCity Tokyo end-to-end tests (docs/integration.md, T-0098). Tokyo is
 * the first streamed-only city (~112 k building ways, ~30 MB of tiles), so
 * these tests allow a long ready timeout. Proves the tiled boot at a small
 * `?tileradius=600` becomes `ready` with `__asciicity.tiles.loaded` non-empty
 * and a `BEARING` HUD row, and that booting the `skytree` preset resolves to
 * the derived-from-data east-side vantage on tile 4_-3 with the spawn tile
 * loaded (mechanical, does not depend on which HUD surface carries the
 * `Skytree` string at 795 m out). Wave 22 (T-0166): the PLATEAU credit and
 * a street-walkability check of the default spawn. Never edits
 * smoke/tiles/loading specs.
 */
import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

/** Wait until `__asciicity.ready` is true (Tokyo tiled boot — allow 90 s). */
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

test('tokyo: boots ?city=tokyo&tileradius=600 at the default spawn → ready with loaded tiles and a BEARING HUD row', async ({
  page,
}) => {
  await page.goto('/?city=tokyo&tileradius=600');
  await waitReady(page);

  // Tokyo is tiled: the streaming surface must have loaded at least the 3×3
  // spawn tiles before `ready`.
  const tiles = await page.evaluate(() => {
    const api = (window as unknown as {
      __asciicity?: { tiles?: { loaded: string[]; pending: number } };
    }).__asciicity;
    return {
      loaded: api?.tiles?.loaded ?? [],
      pending: api?.tiles?.pending ?? -1,
    };
  });
  expect(tiles.loaded.length).toBeGreaterThan(0);

  // The default spawn is `shibuya` (T-0103, wave 12) — the player is on the
  // ground and the HUD must show the BEARING row (part of the navigation HUD).
  await expect(page.locator('#hud')).toContainText('BEARING');
});

test('tokyo: plain ?city=tokyo (no at) resolves the shibuya default spawn — WORLD row within 60 m of the Scramble vertex, tiles loaded', async ({
  page,
}) => {
  // Default-spawn proof: `cityById('tokyo').defaultSpawn === 'shibuya'` so a
  // plain `?city=tokyo` boot must land the player on the Shibuya Scramble
  // Crossing vertex derived in `SPAWN_PRESETS.shibuya` — local metres
  // (−6015.50, 2419.70) at Tokyo Station's origin (see the T-0103 unit tests
  // in `tests/spawn.test.ts` for the derivation).
  await page.goto('/?city=tokyo&tileradius=600');
  await waitReady(page);
  const info = await page.evaluate(() => {
    const api = (window as unknown as {
      __asciicity?: {
        state?: { x: number; z: number };
        tiles?: { loaded: string[] };
      };
    }).__asciicity;
    return {
      x: api?.state?.x ?? NaN,
      z: api?.state?.z ?? NaN,
      loaded: api?.tiles?.loaded ?? [],
    };
  });
  const EXPECTED_X = -6015.5;
  const EXPECTED_Z = 2419.7;
  expect(Math.hypot(info.x - EXPECTED_X, info.z - EXPECTED_Z)).toBeLessThan(60);
  expect(info.loaded.length).toBeGreaterThan(0);
});

test('tokyo: PLATEAU buildings (wave 22) — the #credits line names PLATEAU and the shibuya boot spawn is on a walkable street', async ({
  page,
}) => {
  await page.goto('/?city=tokyo&tileradius=600');
  await waitReady(page);

  // PDL 1.0 attribution: main.ts appends `CREDITS.plateau` for Tokyo only.
  await expect(page.locator('#credits')).toContainText('PLATEAU');

  // Walkable street: fetch the spawn's 3×3 tiles and check the player
  // position is outside every building footprint (PLATEAU replaced most of
  // them, T-0166) and within 15 m of a road polyline (the spawn.test.ts rule).
  const street = await page.evaluate(async () => {
    type Pt = [number, number];
    const api = (window as unknown as {
      __asciicity?: { state?: { x: number; z: number } };
    }).__asciicity;
    const p: Pt = [api?.state?.x ?? NaN, api?.state?.z ?? NaN];
    const inside = (poly: Pt[]): boolean => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i];
        const [xj, zj] = poly[j];
        if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) c = !c;
      }
      return c;
    };
    const segDist = (a: Pt, b: Pt): number => {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len2 = dx * dx + dz * dz;
      const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
    };
    const index = (await (await fetch('data/tokyo/index.json')).json()) as {
      tileSize: number;
      tiles: Record<string, unknown>;
    };
    const si = Math.floor(p[0] / index.tileSize);
    const sj = Math.floor(p[1] / index.tileSize);
    let insideBuildings = 0;
    let buildings = 0;
    let roadDist = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const key = `${si + di}_${sj + dj}`;
        if (!(key in index.tiles)) continue;
        const tile = (await (await fetch(`data/tokyo/tiles/${key}.json`)).json()) as {
          buildings: { poly: Pt[] }[];
          roads: { pts: Pt[] }[];
        };
        for (const b of tile.buildings) {
          buildings++;
          if (inside(b.poly)) insideBuildings++;
        }
        for (const r of tile.roads) {
          for (let i = 0; i < r.pts.length - 1; i++) roadDist = Math.min(roadDist, segDist(r.pts[i], r.pts[i + 1]));
        }
      }
    }
    return { buildings, insideBuildings, roadDist };
  });
  expect(street.buildings).toBeGreaterThan(0);
  expect(street.insideBuildings).toBe(0);
  expect(street.roadDist).toBeLessThan(15);
});

test('tokyo: booting the skytree preset resolves to the east-side vantage on tile 4_-3 with the spawn tile loaded', async ({
  page,
}) => {
  await page.goto('/?city=tokyo&tileradius=600&at=skytree');
  await waitReady(page);

  // Mechanical assertions replace the old body-text `Skytree` poll (the PM
  // rework relocated `skytree` from 156 m NE to 795 m E of the tower, past
  // the ZONE's Voronoi cell for "TOKYO SKYTREE"): the player position matches
  // the preset's local coordinate within 60 m, and the spawn tile has
  // streamed in. See docs/integration.md §Tokyo presets / this test's peer
  // unit test in `tests/spawn.test.ts` for the coordinate derivation.
  const info = await page.evaluate(() => {
    const api = (window as unknown as {
      __asciicity?: {
        state?: { x: number; z: number };
        tiles?: { loaded: string[] };
      };
    }).__asciicity;
    return {
      x: api?.state?.x ?? NaN,
      z: api?.state?.z ?? NaN,
      loaded: api?.tiles?.loaded ?? [],
    };
  });
  const EXPECTED_X = 4708;
  const EXPECTED_Z = -2968;
  expect(Math.hypot(info.x - EXPECTED_X, info.z - EXPECTED_Z)).toBeLessThan(60);
  expect(info.loaded).toContain('4_-3');
});

test('tokyo: plain ?city=tokyo boot reports render matrix (per-city default, architecture §4.20)', async ({
  page,
}) => {
  await page.goto('/?city=tokyo&tileradius=600');
  await waitReady(page);
  const render = await page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: { render?: string } })
      .__asciicity;
    return api?.render ?? '';
  });
  expect(render).toBe('matrix');
});

test('tokyo: ?city=tokyo&render=ascii boots ascii — the explicit URL wins over the city default', async ({
  page,
}) => {
  await page.goto('/?city=tokyo&render=ascii&tileradius=600');
  await waitReady(page);
  const render = await page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: { render?: string } })
      .__asciicity;
    return api?.render ?? '';
  });
  expect(render).toBe('ascii');
});
