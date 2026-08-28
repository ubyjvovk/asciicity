/**
 * AsciiCity San Francisco end-to-end tests (docs/integration.md, T-0076).
 * Boots the real `sf.json` dataset twice: once at Union Square to prove it
 * renders (non-black output) with terrain present (ALT row in the HUD), and
 * once at the Golden Gate Bridge to prove the deck spawn sits well above the
 * datum (y > 20 means the bridge, not sea level). SF has 5× Kyiv's geometry,
 * so these tests may run up to a 90 s ready timeout. Never edits smoke.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';

/** Wait until `__asciicity.ready` is true (SF loads a large JSON — allow 90 s). */
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (
        window as unknown as { __asciicity?: { ready?: boolean } }
      ).__asciicity;
      return api?.ready === true;
    },
    undefined,
    { timeout: 90_000 },
  );
}

/** Fraction of canvas pixels that are not rgb(0,0,0). */
async function nonBlackFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
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
}

test('sf: boots at Union Square, renders non-black, terrain present (ALT row)', async ({
  page,
}) => {
  await page.goto('/?city=sf&at=unionsquare');
  await waitReady(page);

  // The rendered output must have > 2% non-black pixels (glyph coverage).
  const fraction = await nonBlackFraction(page);
  expect(fraction).toBeGreaterThan(0.02);

  // Union Square sits on SRTM terrain, so the HUD must show the ALT row.
  await expect(page.locator('#hud')).toContainText('ALT');
});

test('sf: boots at the Golden Gate Bridge deck well above the datum (y > 20)', async ({
  page,
}) => {
  await page.goto('/?city=sf&at=ggb');
  await waitReady(page);

  // World y is relative to the Union Square datum (~25 m ASL). The deck is
  // ~67 m ASL → y ≈ 35–45; a spawn fallen to sea level gives y ≈ −25. 20
  // separates the bridge from the water with margin either way.
  const out = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __asciicity?: { state?: { y: number }; city?: string };
      }
    ).__asciicity;
    return { y: api?.state?.y ?? NaN, city: api?.city ?? '' };
  });
  expect(out.city).toBe('sf');
  expect(out.y).toBeGreaterThan(20);
});
