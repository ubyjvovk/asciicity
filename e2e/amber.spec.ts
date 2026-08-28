/**
 * Amber-style e2e (docs/architecture.md §4.11 "`amber` (wave 8)").
 * Boots `/?synthetic=1&render=amber&cell=3x6&time=23:00` and checks that the
 * frame is painted, crushed-black, and warm-dominant. Boot helpers are copied
 * from `smoke.spec.ts`; that file is not edited.
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

/** Two rAF ticks so the style pass has presented a frame. */
async function doubleRaf(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
}

/** Pixel stats from `#view` via an offscreen 2d canvas (same copy path as smoke). */
async function amberPixelStats(page: Page): Promise<{
  nonBlack: number;
  darkFloor: number;
  meanR: number;
  meanB: number;
}> {
  return page.evaluate(() => {
    const el = document.getElementById('view');
    if (!(el instanceof HTMLCanvasElement)) {
      return { nonBlack: 0, darkFloor: 0, meanR: 0, meanB: 0 };
    }
    const w = el.width;
    const h = el.height;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return { nonBlack: 0, darkFloor: 0, meanR: 0, meanB: 0 };
    ctx.drawImage(el, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    let nonBlack = 0;
    let darkFloor = 0;
    let warmCount = 0;
    let sumR = 0;
    let sumB = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 0 || g > 0 || b > 0) nonBlack++;
      const mx = Math.max(r, g, b);
      if (mx < 13) darkFloor++;
      if (mx > 38) {
        warmCount++;
        sumR += r;
        sumB += b;
      }
    }
    return {
      nonBlack: nonBlack / n,
      darkFloor: darkFloor / n,
      meanR: warmCount > 0 ? sumR / warmCount : 0,
      meanB: warmCount > 0 ? sumB / warmCount : 0,
    };
  });
}

test('amber: paints, crushed blacks, warm-dominant at 23:00', async ({ page }) => {
  await page.goto('/?synthetic=1&render=amber&cell=3x6&time=23:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);

  const stats = await amberPixelStats(page);
  expect(stats.nonBlack).toBeGreaterThan(0.02);
  expect(stats.darkFloor).toBeGreaterThanOrEqual(0.35);
  expect(stats.meanR).toBeGreaterThanOrEqual(1.4 * stats.meanB);
});
