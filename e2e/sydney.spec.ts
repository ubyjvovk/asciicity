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

test('sydney: ?at=harbourbridge lands on the Harbour Bridge deck (y > 35)', async ({
  page,
}) => {
  // Cahill Walk (eastern walkway) at ~-33.85° lat sits on the bridge deck.
  // Sydney datum is ≈ 3.9 m ASL (T-0110 transect); the Harbour Bridge deck
  // apex is 49 m ASL (T-0112 deckApexASL) so mid-span y ≈ 45–50 relative to
  // the datum. y > 35 separates the walkway from the harbour water (y ≈ −4).
  await page.goto('/?city=sydney&at=harbourbridge&tileradius=600');
  await waitReady(page);
  const out = await page.evaluate(() => {
    const api = (
      window as unknown as { __asciicity?: { state?: { y: number }; city?: string } }
    ).__asciicity;
    return { y: api?.state?.y ?? NaN, city: api?.city ?? '' };
  });
  expect(out.city).toBe('sydney');
  expect(out.y).toBeGreaterThan(35);
});

test('sydney: ?at=mrsmacquarie renders a non-empty LANDMARK / ZONE HUD row', async ({
  page,
}) => {
  // Mrs Macquarie's Point vantage faces the Opera House across Farm Cove.
  // With that landmark 689 m away in the frame, the LANDMARK row (nearest
  // named building in facing direction, src/hud/hud.ts:69) must resolve to
  // a non-empty label; the ZONE row is also non-empty as we sit inside the
  // Domain / Royal Botanic Garden district. Wait until the HUD has actually
  // painted the LANDMARK label (HUD_INTERVAL is 4 frames; `ready` flips on
  // frame 1, so LANDMARK arrives ~3 frames later).
  await page.goto('/?city=sydney&at=mrsmacquarie&tileradius=600');
  await waitReady(page);
  await expect(page.locator('#hud')).toContainText('LANDMARK', { timeout: 5_000 });
  const hud = (await page.locator('#hud').textContent()) ?? '';
  // Both rows must exist AND carry a non-empty value.
  for (const label of ['LANDMARK', 'ZONE']) {
    const line = hud.split('\n').find((l) => l.includes(label));
    expect(line, `${label} row missing`).toBeTruthy();
    const value = (line ?? '').replace(new RegExp(label, 'g'), '').replace(/^[\s>]+/, '').trim();
    expect(value.length, `${label} value empty`).toBeGreaterThan(0);
  }
});
