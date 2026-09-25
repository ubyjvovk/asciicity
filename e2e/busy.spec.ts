/**
 * Background-loading indicator e2e (T-0171, docs/hud-busy.md). Boots
 * `/?city=london` (tiled, SwiftShader / WebGL2), waits for `ready`, then
 * fast-travels to a preset in another tile and asserts the `#busy` line
 * fades in (opacity 1) while sectors stream, then hides again once
 * `__asciicity.tiles.pending === 0` + 1.5 s. With `?hud=0` it never shows.
 * Zero console errors throughout.
 */
import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ timeout: 120_000 });

/** Console lines that are not ours (analytics beacon blocked offline). */
const NOISE = /cloudflareinsights|ERR_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/;

type Api = {
  ready?: boolean;
  travel(key: string): boolean;
  tiles?: { pending: number };
};

/** Collect console errors / page errors that are not offline noise. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __asciicity?: Api }).__asciicity?.ready === true,
    undefined,
    { timeout: 90_000 },
  );
}

/**
 * Teleport to `key`, then sample `#busy` every 50 ms for `ms`: returns the
 * max computed opacity and the first non-empty text seen at opacity 1.
 */
async function travelAndWatch(
  page: Page,
  key: string,
  ms: number,
): Promise<{ ok: boolean; maxOpacity: number; text: string; maxPending: number }> {
  return page.evaluate(
    async ({ key, ms }) => {
      const api = (window as unknown as { __asciicity: Api }).__asciicity;
      const el = document.getElementById('busy');
      const ok = api.travel(key);
      let maxOpacity = 0;
      let maxPending = 0;
      let text = '';
      const end = performance.now() + ms;
      while (performance.now() < end) {
        maxPending = Math.max(maxPending, api.tiles?.pending ?? 0);
        if (el) {
          const o = Number(getComputedStyle(el).opacity);
          maxOpacity = Math.max(maxOpacity, o);
          if (o === 1 && text === '' && el.textContent) text = el.textContent;
          if (o === 1 && text !== '') break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return { ok, maxOpacity, text, maxPending };
    },
    { key, ms },
  );
}

/** Wait until `tiles.pending === 0`. */
async function waitDrained(page: Page): Promise<void> {
  await page.waitForFunction(
    () => ((window as unknown as { __asciicity?: Api }).__asciicity?.tiles?.pending ?? 0) === 0,
    undefined,
    { timeout: 60_000 },
  );
}

async function busyOpacity(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.getElementById('busy');
    return el ? Number(getComputedStyle(el).opacity) : -1;
  });
}

/**
 * Assert `#busy` is hidden: the `.on` class is gone and the 0.25 s fade has
 * finished. Both retry briefly — on SwiftShader a tile rebuild can stall the
 * main thread for ~0.6 s, freezing the frame loop and the CSS transition.
 */
async function expectHidden(page: Page): Promise<void> {
  await expect(page.locator('#busy')).not.toHaveClass(/\bon\b/, { timeout: 3000 });
  await expect.poll(() => busyOpacity(page), { timeout: 3000 }).toBe(0);
}

test('busy: ?city=london teleport shows the SYNC line, then hides after tiles drain', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/?city=london');
  await waitReady(page);
  await expect(page.locator('#busy')).toHaveCount(1);
  // Let the spawn ring settle so the teleport is what makes us busy.
  await waitDrained(page);
  await page.waitForTimeout(1500);
  await expectHidden(page);

  const seen = await travelAndWatch(page, 'tower', 5000);
  console.log(`#busy during teleport: "${seen.text}" (max pending ${seen.maxPending})`);
  expect(seen.ok).toBe(true);
  expect(seen.maxOpacity).toBe(1);
  expect(seen.text).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (SYNC|BOOT) [▰▱]{8} SECTORS \d+/);

  await waitDrained(page);
  await page.waitForTimeout(1500);
  await expectHidden(page);
  expect(errors).toEqual([]);
});

test('busy: ?hud=0 never shows the line', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?city=london&hud=0');
  await waitReady(page);
  const seen = await travelAndWatch(page, 'tower', 3000);
  expect(seen.ok).toBe(true);
  expect(seen.maxOpacity).toBe(0);
  await waitDrained(page);
  await page.waitForTimeout(1500);
  await expectHidden(page);
  expect(errors).toEqual([]);
});
