/**
 * AsciiCity end-to-end smoke test (docs/architecture.md §8, docs/testing.md).
 * Boots the game in a headless Chromium against `/?synthetic=1`, proves it
 * renders non-black ASCII output, moves the player, and shows the HUD, then
 * saves a screenshot the PM can review at `e2e/__shots__/smoke.png`.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { syntheticCity } from '../src/data/synthetic';
import { terrainHeightAt } from '../src/world/terrain';

/** Shape of the T-0010 debug contract exposed on `window.__asciicity`. */
interface AsciiApi {
  ready: boolean;
  state: { x: number; z: number };
}

/** Read the live player x/z from `window.__asciicity.state` (mirrors §5). */
function readPos(page: Page): Promise<{ x: number; z: number }> {
  return test.step('read player state', async () =>
    page.evaluate(() => {
      const api = (
        window as unknown as { __asciicity?: Partial<AsciiApi> }
      ).__asciicity;
      const s = api?.state;
      return { x: s?.x ?? NaN, z: s?.z ?? NaN };
    }),
  );
}

test('smoke: boots, renders, moves, shows HUD, saves screenshot', async ({
  page,
}) => {
  // 1. Boot the game against the deterministic synthetic city.
  await page.goto('/?synthetic=1');

  // 2. Wait until the frame loop has run and exposed the ready contract.
  await page.waitForFunction(
    () => {
      const api = (
        window as unknown as { __asciicity?: { ready?: boolean } }
      ).__asciicity;
      return api?.ready === true;
    },
    undefined,
    { timeout: 30_000 },
  );

  // 3. Read the starting position, then click the canvas centre to enter.
  const start = await readPos(page);
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // 4. Hold W for 600 ms and confirm the player moved ≥ 0.5 m north.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyW');
  const moved = await readPos(page);
  const distance = Math.hypot(moved.x - start.x, moved.z - start.z);
  expect(distance).toBeGreaterThanOrEqual(0.5);

  // 5. The HUD must be showing BEARING and ZONE rows.
  const hud = page.locator('#hud');
  await expect(hud).toContainText('BEARING');
  await expect(hud).toContainText('ZONE');

  // 6. The rendered output must have > 2% non-black pixels. The WebGL canvas
  //    is copied onto a 2D canvas (preserveDrawingBuffer: true) so pixel data
  //    is readable. The ASCII glyphs are thin (1–2 px strokes inside 6×12 px
  //    cells), so a coarse fixed-step sample (e.g. every 8th pixel) aliases
  //    into the gaps between strokes and under-reports; sampling every pixel
  //    robustly detects the glyph coverage (deterministic ≈3.9% on the
  //    synthetic city).
  const nonBlackFraction = await page.evaluate(() => {
    const el = document.getElementById('view');
    if (!(el instanceof HTMLCanvasElement)) return 0;
    const w = el.width;
    const h = el.height;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(el, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) nonBlack++;
    }
    return nonBlack / (w * h);
  });
  expect(nonBlackFraction).toBeGreaterThan(0.02);

  // 7. Save a screenshot for the PM; the directory is gitignored.
  const shotPath = 'e2e/__shots__/smoke.png';
  mkdirSync('e2e/__shots__', { recursive: true });
  await page.screenshot({ path: shotPath });
});

test('smoke: hills exposes eye height above the synthetic heightfield and an ALT row', async ({
  page,
}) => {
  // The default synthetic seed is 1, blocks 12; hills=1 adds the terrain grid.
  // Compute the expected eye height in node from the same seed the browser boots.
  const hills = syntheticCity(1, 12, true);
  if (!hills.terrain) throw new Error('syntheticCity(1, 12, true) must include terrain');
  const expectedY = 1.7 + terrainHeightAt(hills.terrain, 0, 0);

  await page.goto('/?synthetic=1&hills=1');
  await page.waitForFunction(
    () => {
      const api = (
        window as unknown as { __asciicity?: { ready?: boolean } }
      ).__asciicity;
      return api?.ready === true;
    },
    undefined,
    { timeout: 30_000 },
  );

  // Read `y` and `city` from the extended debug contract.
  const observed = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __asciicity?: { y?: number; city?: string };
      }
    ).__asciicity;
    return { y: api?.y ?? NaN, city: api?.city ?? '' };
  });
  expect(observed.city).toBe('synthetic');
  expect(Math.abs(observed.y - expectedY)).toBeLessThan(0.5);

  // The HUD must render the ALT row when terrain is present.
  const hud = page.locator('#hud');
  await expect(hud).toContainText('ALT');
});

test('smoke: fly — Space climbs in fly mode, HUD shows MODE/FLY', async ({
  page,
}) => {
  // `?fly=1` boots airborne; holding Space rises (up axis) in fly mode.
  await page.goto('/?synthetic=1&fly=1');
  await page.waitForFunction(
    () => {
      const api = (
        window as unknown as { __asciicity?: { ready?: boolean } }
      ).__asciicity;
      return api?.ready === true;
    },
    undefined,
    { timeout: 30_000 },
  );

  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const readFly = () =>
    page.evaluate(() => {
      const api = (
        window as unknown as { __asciicity?: { y?: number; fly?: boolean } }
      ).__asciicity;
      return { y: api?.y ?? NaN, fly: api?.fly ?? false };
    });

  const before = await readFly();
  expect(before.fly).toBe(true);

  // Hold Space 500 ms — the player should climb several metres.
  await page.keyboard.down('Space');
  await page.waitForTimeout(500);
  await page.keyboard.up('Space');
  const after = await readFly();
  expect(after.y - before.y).toBeGreaterThanOrEqual(5);
  expect(after.fly).toBe(true);

  const hud = page.locator('#hud');
  await expect(hud).toContainText('MODE');
  await expect(hud).toContainText('FLY');
});
