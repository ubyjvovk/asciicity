/**
 * AsciiCity Sydney end-to-end tests (docs/integration.md, T-0110). Sydney is
 * the project's first southern-hemisphere city (DEM tile S34E151, bare-earth
 * `--dem-bare`) and a streamed tiled dataset (~20 k footprints, 57 tiles,
 * ≈ 6.5 MB), so these tests boot with a long ready timeout and a small
 * `?tileradius=600`. Proves the tiled boot reaches the `CLICK TO ENTER`
 * prompt with the terrain HUD (ALT + ZONE rows) rendered, and that the
 * player can move. Never edits smoke/tiles/loading specs.
 */
import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

/** Wait until `__asciicity.ready` is true (Sydney tiled boot — allow 90 s). */
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

test('sydney: boots ?city=sydney to CLICK TO ENTER with terrain HUD (ALT) and non-empty ZONE', async ({
  page,
}) => {
  await page.goto('/?city=sydney&tileradius=600');
  await waitReady(page);

  // The initial overlay must reach the CLICK TO ENTER prompt (not RESUME).
  const prompt = await page.locator('#overlay p').textContent();
  expect(prompt?.trim()).toBe('CLICK TO ENTER');

  // Sydney sits on SRTM terrain, so the HUD must show ALT; ZONE must be non-empty.
  await expect(page.locator('#hud')).toContainText('ALT');
  await expect(page.locator('#hud')).toContainText('ZONE');
  const hud = (await page.locator('#hud').textContent()) ?? '';
  const zoneLine = hud.split('\n').find((l) => l.includes('ZONE')) ?? 'ZONE ';
  // Strip the "ZONE" label and any formatting to confirm a real zone value.
  const zoneValue = zoneLine.replace(/ZONE/g, '').trim();
  expect(zoneValue.length).toBeGreaterThan(0);
});

test('sydney: default spawn moves the player out of the gate (≥ 0.5 m)', async ({
  page,
}) => {
  await page.goto('/?city=sydney&tileradius=600');
  await waitReady(page);

  // Enter the canvas, hold W ~1 s, and confirm the player moved ≥ 0.5 m
  // (copy of the smoke.spec.ts / sf.spec.ts movement pattern).
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const readPos = () =>
    page.evaluate(() => {
      const s = (
        window as unknown as { __asciicity?: { state?: { x: number; z: number } } }
      ).__asciicity?.state;
      return { x: s?.x ?? NaN, z: s?.z ?? NaN };
    });
  const start = await readPos();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyW');
  const moved = await readPos();
  expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThanOrEqual(0.5);
});
