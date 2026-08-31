/**
 * AsciiCity Tokyo end-to-end tests (docs/integration.md, T-0098). Tokyo is
 * the first streamed-only city (~112 k building ways, ~30 MB of tiles), so
 * these tests allow a long ready timeout. Proves the tiled boot at a small
 * `?tileradius=600` becomes `ready` with `__asciicity.tiles.loaded` non-empty
 * and a `BEARING` HUD row, and that booting the `skytree` preset eventually
 * surfaces a "Skytree" name in the ZONE/tag layer (polled with a tolerant
 * timeout). Never edits smoke/tiles/loading specs.
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

  // The default spawn is `tokyostation` — the player is on the ground and the
  // HUD must show the BEARING row (part of the navigation HUD).
  await expect(page.locator('#hud')).toContainText('BEARING');
});

test('tokyo: booting the skytree preset eventually shows a "Skytree" name in the ZONE/tag layer', async ({
  page,
}) => {
  await page.goto('/?city=tokyo&tileradius=600&at=skytree');
  await waitReady(page);

  // Poll (tolerant): the ZONE text (HUD) and the floating tag layer both
  // derive from the loaded data. The Skytree sits ~200 m ahead of the preset
  // on a road vertex facing it, so once its tile streams in, its name
  // ("Tokyo Skytree") appears in the tag layer and the nearest place
  // ("TOKYO SKYTREE") becomes the HUD zone. Case-insensitive body-wide match
  // covers both render surfaces. Tolerant 60 s timeout.
  await page.waitForFunction(
    () => /skytree/i.test(document.body.innerText),
    undefined,
    { timeout: 60_000 },
  );
});
