/**
 * NOSEVIEW skin e2e (docs/architecture.md §4.11 "`retrocgi`" HUD skin,
 * T-0150). DOM-only: no pixel reads, no screenshots. Boot helpers copied from
 * `amber.spec.ts`; that file is not edited.
 */
import { test, expect, type Page } from '@playwright/test';

/** Wait until `__asciicity.ready` is true. */
async function waitReady(page: Page): Promise<void> {
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
}

test('noseview: shows under retrocgi, hides on the next style', async ({
  page,
}) => {
  // A. Boot retrocgi and check the overlay and captions are visible.
  await page.goto('/?synthetic=1&render=retrocgi');
  await waitReady(page);

  expect(
    await page.evaluate(() => document.body.dataset.render ?? ''),
  ).toBe('retrocgi');

  await expect(page.locator('#noseview')).toHaveCSS('display', 'block');

  await expect(page.locator('.nv-title')).toHaveText('NOSEVIEW');
  await expect(page.locator('.nv-alt')).toHaveText(/^ALT\. \d+$/);
  await expect(page.locator('.nv-air')).toHaveText(/^AIR\.\. \d+$/);

  await expect(page.locator('#hud')).toHaveCSS('display', 'none');

  // B. Press R once (focus the page by clicking the canvas, the way
  //    smoke.spec.ts does for its R loop) → the overlay hides, #hud returns.
  const box = await page.locator('#view').boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await page.keyboard.press('KeyR');
  await page.waitForFunction(
    () => (document.body.dataset.render ?? '') !== 'retrocgi',
  );

  expect(
    await page.evaluate(() => document.body.dataset.render ?? ''),
  ).not.toBe('retrocgi');
  await expect(page.locator('#noseview')).toHaveCSS('display', 'none');
  await expect(page.locator('#hud')).not.toHaveCSS('display', 'none');
});
