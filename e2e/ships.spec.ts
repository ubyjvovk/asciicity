/**
 * Bay shipping end-to-end tests (docs/architecture.md §4.17, T-0081).
 * Boots the real `sf.json` dataset at Pier 39, once at night and once at noon,
 * and checks `__asciicity.ships`. Never edits smoke.spec.ts / sf.spec.ts.
 *
 * `?time=HH:MM` is *today in the browser's local time* (`parseTimeParam`).
 * Pin America/Los_Angeles so 22:30 is evening in the Bay (UTC hosts would
 * otherwise treat 22:30 as afternoon solar time at lon −122).
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ timezoneId: 'America/Los_Angeles' });
test.describe.configure({ timeout: 120_000 });

/** Shape of the `__asciicity.ships` hook. */
interface ShipsApi {
  ready?: boolean;
  ships?: { count: number; lightsOn: boolean };
}

/** Wait until `__asciicity.ready` is true (SF loads a large JSON — allow 90 s). */
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

async function readShips(page: Page): Promise<{ count: number; lightsOn: boolean }> {
  return page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: ShipsApi }).__asciicity;
    return {
      count: api?.ships?.count ?? -1,
      lightsOn: api?.ships?.lightsOn ?? false,
    };
  });
}

test('sf night at pier39: 15 ships with lights on', async ({ page }) => {
  await page.goto('/?city=sf&at=pier39&time=22:30');
  await waitReady(page);
  const ships = await readShips(page);
  expect(ships.count).toBe(15);
  expect(ships.lightsOn).toBe(true);
});

test('sf noon at pier39: running lights off', async ({ page }) => {
  await page.goto('/?city=sf&at=pier39&time=12:00');
  await waitReady(page);
  const ships = await readShips(page);
  expect(ships.count).toBe(15);
  expect(ships.lightsOn).toBe(false);
});
