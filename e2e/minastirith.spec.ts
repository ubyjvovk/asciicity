/**
 * AsciiCity Minas Tirith end-to-end tests (docs/architecture.md §4.23, T-0128).
 * Boots the synthesised tiled dataset at the Great Gate in the `quest` style,
 * checks the HUD names a Minas Tirith place, walks into the first ramp, and
 * proves `?at=citadel` stands on the L7 plateau. Boot helpers copied from
 * `e2e/tokyo.spec.ts`. Never edits smoke/tiles/loading specs.
 */
import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ timeout: 180_000 });

/** Wait until `__asciicity.ready` is true (tiled boot — allow 90 s). */
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

test('minas-tirith: boots ?city=minas-tirith at the Great Gate in quest, HUD names the city, walking climbs the ramp', async ({
  page,
}) => {
  await page.goto('/?city=minas-tirith');
  await waitReady(page);

  const boot = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __asciicity?: { city?: string; render?: string; y?: number };
      }
    ).__asciicity;
    return {
      city: api?.city ?? '',
      render: api?.render ?? '',
      y: api?.y ?? NaN,
    };
  });
  expect(boot.city).toBe('minas-tirith');
  expect(boot.render).toBe('quest');

  // HUD updates every 4th frame; `ready` flips on frame 1 so ZONE/LANDMARK
  // arrive a few frames later. Accept GREAT GATE (place/landmark) or any
  // other Minas Tirith name on those rows (The Climbing Way, Pelennor, …).
  const hud = page.locator('#hud');
  await expect(hud).toContainText(/ZONE|LANDMARK/, { timeout: 5_000 });
  const hudText = (await hud.textContent()) ?? '';
  expect(
    /great gate|climbing way|pelennor|ecthelion|citadel|rath|healing|fountain/i.test(
      hudText,
    ),
    `HUD had no Minas Tirith name:\n${hudText}`,
  ).toBe(true);

  // Enter the canvas (pointer lock) then walk west into the city. Spawn is
  // (R_1 + 40, 0) = 460 m east; the L2 ramp that yields ≥ 3 m of climb
  // starts ~82 m west (architecture.md §4.23). 1.5 s at WALK_SPEED 9 m/s
  // only covers 13.5 m of Pelennor, so we hold KeyW until y rises.
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const startY = boot.y;
  await page.keyboard.down('KeyW');
  // SwiftShader e2e runs well below WALK_SPEED (dt is capped at 0.1 s), so
  // the ~82 m to the L2 ramp can take tens of seconds. Hold until y rises.
  await page.waitForFunction(
    (y0) => {
      const api = (window as unknown as { __asciicity?: { y?: number } }).__asciicity;
      return typeof api?.y === 'number' && api.y - y0 >= 3;
    },
    startY,
    { timeout: 90_000 },
  );
  await page.keyboard.up('KeyW');
  const endY = await page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: { y?: number } }).__asciicity;
    return api?.y ?? NaN;
  });
  expect(endY - startY).toBeGreaterThanOrEqual(3);
  console.log(
    `minas-tirith boot city=${boot.city} render=${boot.render} y0=${startY.toFixed(2)} y1=${endY.toFixed(2)} dy=${(endY - startY).toFixed(2)}`,
  );
});

test('minas-tirith: ?city=minas-tirith&at=citadel boots on the Citadel plateau (y ≥ 200)', async ({
  page,
}) => {
  await page.goto('/?city=minas-tirith&at=citadel');
  await waitReady(page);
  const out = await page.evaluate(() => {
    const api = (
      window as unknown as { __asciicity?: { y?: number; city?: string } }
    ).__asciicity;
    return { y: api?.y ?? NaN, city: api?.city ?? '' };
  });
  expect(out.city).toBe('minas-tirith');
  expect(out.y).toBeGreaterThanOrEqual(200);
  console.log(`minas-tirith citadel city=${out.city} y=${out.y.toFixed(2)}`);
});
