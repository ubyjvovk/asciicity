/**
 * Pointer-lock failure / drag-to-look e2e (docs/architecture.md §4.7
 * wave-10, T-0091). Headless Chromium has no pointer lock, so the failure
 * path is what runs: overlay click → DRAG TO LOOK prompt → second click
 * commits drag-look → a 200 px drag changes yaw → Escape toggles pause.
 * Never edits smoke.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';

/** Shape of the T-0091 debug contract on `window.__asciicity`. */
interface PointerApi {
  ready?: boolean;
  state?: { yaw: number };
  pointer?: {
    locked: boolean;
    dragLook: boolean;
    failures: number;
    lastError: string;
  };
}

/** Wait until the frame loop has published `ready === true`. */
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __asciicity?: { ready?: boolean } })
        .__asciicity;
      return api?.ready === true;
    },
    undefined,
    { timeout: 30_000 },
  );
}

test('pointer lock failure: drag-to-look and Escape toggle the pause menu', async ({
  page,
}) => {
  // The ticket assumes headless Chromium cannot grant a lock. This worker
  // image's Chromium 1193 does, on a user-gesture click, so stub the API
  // to the rejected-promise path the rest of the assertions describe.
  await page.addInitScript(() => {
    HTMLElement.prototype.requestPointerLock = function requestPointerLock() {
      return Promise.reject(
        new DOMException('Pointer lock unavailable', 'SecurityError'),
      );
    };
  });
  await page.goto('/?synthetic=1');
  await waitReady(page);

  // 1. First overlay click requests the lock; headless rejects it, so the
  //    overlay comes back with the drag-to-look prompt.
  await page.locator('#overlay p').click();
  await expect(page.locator('#overlay p')).toContainText('DRAG TO LOOK');
  const failures = await page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: PointerApi }).__asciicity;
    return api?.pointer?.failures ?? 0;
  });
  expect(failures).toBeGreaterThanOrEqual(1);

  // 2. Second overlay click retries once, then stays hidden in drag-look.
  await page.locator('#overlay p').click();
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __asciicity?: PointerApi }).__asciicity;
      return api?.pointer?.dragLook === true;
    },
    undefined,
    { timeout: 5_000 },
  );
  await expect(page.locator('#overlay')).toBeHidden();

  // 3. Drag 200 px across `#view`; unlocked look must change yaw.
  const yawBefore = await page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: PointerApi }).__asciicity;
    return api?.state?.yaw ?? 0;
  });
  const box = await page.locator('#view').boundingBox();
  if (!box) throw new Error('#view has no bounding box');
  const midY = box.y + box.height / 2;
  await page.mouse.move(box.x + 100, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, midY);
  await page.mouse.up();
  await page.waitForFunction(
    (y0) => {
      const api = (window as unknown as { __asciicity?: PointerApi }).__asciicity;
      const yaw = api?.state?.yaw;
      return typeof yaw === 'number' && yaw !== y0;
    },
    yawBefore,
    { timeout: 5_000 },
  );

  // 4. Escape shows the pause menu; Escape again hides it.
  await page.keyboard.press('Escape');
  await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#menu button').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#overlay')).toBeHidden();
});
