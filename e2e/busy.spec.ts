/**
 * Background-loading indicator e2e (T-0171, docs/hud-busy.md). Boots
 * `/?city=london` (tiled, SwiftShader / WebGL2), waits for `ready`, then
 * fast-travels to a preset in another tile and asserts the `#busy` line
 * fades in (opacity 1) while sectors stream, then hides again once
 * `__asciicity.tiles.pending === 0` + 1.5 s. With `?hud=0` it never shows
 * after ready. T-0174: with the city index fetch delayed 2 s, the boot line
 * (JACK-IN / DOWNLINK / DECRYPT / COMPILE) is visible before `ready` — also
 * with `?hud=0`. Zero console errors throughout.
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

/** One `#busy` sample taken by the boot sampler. */
type BootSample = { o: number; text: string; count: number };

/**
 * Delay the city index fetch by `ms` and install a 50 ms sampler that records
 * `#busy` (opacity, text, element count) into `window.__busySamples` until
 * `__asciicity.ready`.
 */
async function throttleAndSampleBoot(page: Page, ms: number): Promise<void> {
  await page.route('**/data/*/index.json', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __busySamples: BootSample[]; __asciicity?: Api };
    w.__busySamples = [];
    const id = setInterval(() => {
      if (w.__asciicity?.ready === true) {
        clearInterval(id);
        return;
      }
      const el = document.getElementById('busy');
      if (!el) return;
      w.__busySamples.push({
        o: Number(getComputedStyle(el).opacity),
        text: el.textContent ?? '',
        count: document.querySelectorAll('#busy').length,
      });
    }, 50);
  });
}

/** Boot samples at opacity 1; asserts they exist and use the lore wording. */
async function expectBootLine(page: Page): Promise<string[]> {
  const samples = await page.evaluate(
    () => (window as unknown as { __busySamples: BootSample[] }).__busySamples,
  );
  const shown = samples.filter((s) => s.o === 1);
  expect(shown.length).toBeGreaterThan(0);
  for (const s of shown) {
    expect(s.text).toMatch(/JACK-IN|DOWNLINK|DECRYPT|COMPILE/);
    expect(s.count).toBe(1);
  }
  // Distinct lines with the spinner stripped, in order of appearance.
  const seen: string[] = [];
  for (const s of shown) {
    const t = s.text.slice(2);
    if (!seen.includes(t)) seen.push(t);
  }
  return seen;
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

test('busy: throttled boot shows the JACK-IN line before ready, then hands over and hides', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await throttleAndSampleBoot(page, 2000);
  await page.goto('/?city=london');
  await waitReady(page);
  const lines = await expectBootLine(page);
  console.log(`#busy during boot:\n  ${lines.join('\n  ')}`);
  await expect(page.locator('#busy')).toHaveCount(1);
  await expect(page.locator('#busy')).not.toHaveClass(/\bboot\b/);
  await waitDrained(page);
  await page.waitForTimeout(1500);
  await expectHidden(page);
  expect(errors).toEqual([]);
});

test('busy: ?hud=0 shows the boot line but never after ready', async ({ page }) => {
  const errors = watchErrors(page);
  await throttleAndSampleBoot(page, 1500);
  await page.goto('/?city=london&hud=0');
  await waitReady(page);
  await expectBootLine(page);
  await expect(page.locator('#busy')).toHaveCount(1);
  await expect(page.locator('#busy')).not.toHaveClass(/\bon\b/);
  await expectHidden(page);
  const seen = await travelAndWatch(page, 'tower', 3000);
  expect(seen.ok).toBe(true);
  expect(seen.maxOpacity).toBe(0);
  await waitDrained(page);
  await page.waitForTimeout(1500);
  await expectHidden(page);
  expect(errors).toEqual([]);
});
