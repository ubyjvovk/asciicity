/**
 * AsciiCity Manhattan end-to-end tests (docs/integration.md, T-0087).
 * Boots the real `nyc.json` dataset twice: once at Times Square to prove it
 * renders (non-black glyphs) with terrain present (ALT row), and once with
 * the default spawn on the Brooklyn Bridge Promenade to prove the deck
 * spawn sits well above the datum (y > 20 means the walkway at mid-span,
 * not the East River). Manhattan is 10 MB with 41 k buildings and 3 k building parts, so
 * these tests may run up to a 90 s ready timeout. Never edits smoke.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';

/** Wait until `__asciicity.ready` is true (Manhattan loads a large JSON — allow 90 s). */
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

test('nyc: boots at Times Square, renders non-black, terrain present (ALT row)', async ({
  page,
}) => {
  await page.goto('/?city=nyc&at=timessquare');
  await waitReady(page);

  // The rendered output must have > 2 % non-black pixels (glyph coverage).
  const fraction = await nonBlackFraction(page);
  expect(fraction).toBeGreaterThan(0.02);

  // Times Square sits on SRTM terrain (datum ~12 m ASL), so the HUD must
  // show the ALT row.
  await expect(page.locator('#hud')).toContainText('ALT');
});

test('nyc: default spawn puts the player on the Brooklyn Bridge deck (y > 20)', async ({
  page,
}) => {
  await page.goto('/?city=nyc');
  await waitReady(page);

  // World y is relative to Union Square datum (~12 m ASL). The Brooklyn
  // Bridge Promenade deck is ~41 m ASL at mid-span → y ≈ 31; the East River
  // water sits around ≈ −10. y > 20 separates the walkway from the river
  // (and from the old approach-ramp spawn at y ≈ 10).
  const out = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __asciicity?: { state?: { y: number }; city?: string };
      }
    ).__asciicity;
    return { y: api?.state?.y ?? NaN, city: api?.city ?? '' };
  });
  expect(out.city).toBe('nyc');
  expect(out.y).toBeGreaterThan(20);
});
