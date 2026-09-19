/**
 * RetroCGI-style e2e (docs/architecture.md §4.11 "`retrocgi` (wave 19)").
 * Boots `/?synthetic=1&render=retrocgi&cell=2x2&crt=0&hud=0&minimap=0&tags=0`
 * at a 640×360 viewport and proves the frame is phosphor-green lines on a
 * black tube — by measuring pixels off the `#view` canvas (offscreen-2d
 * copy, as in `e2e/lowpoly.spec.ts`, whose boot helpers this spec copies
 * without editing it). No screenshots.
 *
 * Line colour flickers ±`FLICKER` and fades to `FADE_MIN`, and the halo is
 * 0–30 %, so pixels are classified by SHAPE, not exact `RETRO_LINE` /
 * `RETRO_BG` values:
 *   bg    — every channel ≤ 12/255 (`RETRO_BG` g ≈ 5 sits here);
 *   green — not bg, and `g ≥ 1.8·r` and `g ≥ 1.5·b`. A 1-neighbour halo
 *           cell is `I = HALO_GAIN/4 ≈ 0.075` → g ≈ 23, which the ticket's
 *           `g ≥ 40/255` floor would call `other`; those pixels are still
 *           phosphor-shaped (measured 100 % of the 12 < g < 40 bucket),
 *           so they count as green. `edges` dim scene greys fail the
 *           ratios and stay `other`.
 *   other — anything else.
 *
 * The six assertions (one `test`, numbered comments; 6 is `test.fixme`):
 *   1. `body.dataset.render === 'retrocgi'` and `groundGrid === false`;
 *   2. `other` share ≤ 1 %;
 *   3. `green` share between 3 % and 45 %;
 *   4. `bg` share ≥ 50 %;
 *   5. at least one pixel with `g ≥ 0.85·255·(1 − 2·FLICKER)`;
 *   6. shoreline green share ≥ 0.5 % in the water half — skipped: the
 *      synthetic city has no `water` rings (do not invent data).
 *
 * SwiftShader may blank rows below 64 cells (`e2e/smoke.spec.ts`). This
 * spec uses cell 2×2 at 640×360 (≈180 cell rows) and samples the full
 * canvas, the region `lowpoly.spec.ts` samples.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  RETRO_LINE,
  RETRO_BG,
  FLICKER,
  FADE_MIN,
} from '../src/render/styles/retrocgi';

test.use({ viewport: { width: 640, height: 360 } });

/** Per-channel 8-bit ceiling for the `bg` class. */
const BG_MAX = 12;
/**
 * Ticket green floor in 8-bit (`g ≥ 40/255`). Logged, not used as a hard
 * cut: 1-neighbour halo lands at g ≈ 23. Phosphor shape (the ratios) is
 * the classifier; this floor would put that halo in `other` (~4.5 %).
 */
const TICKET_GREEN_MIN = 40;
/**
 * Near-line green floor (assertion 5). `RETRO_LINE` g is 1, so this is
 * `0.85 · 255 · (1 − 2 · FLICKER)`; `RETRO_BG` and `FADE_MIN` are imported
 * so the thresholds stay tied to the shader, never retyped.
 */
const NEAR_G = 0.85 * 255 * RETRO_LINE[1] * (1 - 2 * FLICKER);

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

/** Pixel-class shares and near-line count from `#view`. */
interface RetroStats {
  bg: number;
  green: number;
  other: number;
  /** Share that meets the ticket's `g ≥ 40/255` green floor. */
  ticketGreen: number;
  near: number;
  n: number;
}

/**
 * Pixel stats from `#view` via an offscreen 2d canvas (same copy path as
 * `lowpoly.spec.ts`). Optional `y0`/`y1` (0–1, top-origin) restrict the
 * sample to a vertical band — used by assertion 6 for the lower half.
 */
async function retroPixelStats(
  page: Page,
  band?: { y0: number; y1: number },
): Promise<RetroStats> {
  return page.evaluate(
    (opts: {
      bgMax: number;
      ticketGreenMin: number;
      nearG: number;
      y0: number;
      y1: number;
    }) => {
      const { bgMax, ticketGreenMin, nearG, y0, y1 } = opts;
      const empty = {
        bg: 0,
        green: 0,
        other: 0,
        ticketGreen: 0,
        near: 0,
        n: 0,
      };
      const el = document.getElementById('view');
      if (!(el instanceof HTMLCanvasElement)) return empty;
      const w = el.width;
      const h = el.height;
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const ctx = off.getContext('2d');
      if (!ctx) return empty;
      ctx.drawImage(el, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      const startY = Math.max(0, Math.floor(y0 * h));
      const endY = Math.min(h, Math.ceil(y1 * h));
      let bg = 0;
      let green = 0;
      let other = 0;
      let ticketGreen = 0;
      let near = 0;
      let n = 0;
      for (let y = startY; y < endY; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          n++;
          if (g >= nearG) near++;
          const phosphor = g >= 1.8 * r && g >= 1.5 * b;
          if (r <= bgMax && g <= bgMax && b <= bgMax) bg++;
          else if (phosphor) {
            green++;
            if (g >= ticketGreenMin) ticketGreen++;
          } else other++;
        }
      }
      return {
        bg: n > 0 ? bg / n : 0,
        green: n > 0 ? green / n : 0,
        other: n > 0 ? other / n : 0,
        ticketGreen: n > 0 ? ticketGreen / n : 0,
        near,
        n,
      };
    },
    {
      bgMax: BG_MAX,
      ticketGreenMin: TICKET_GREEN_MIN,
      nearG: NEAR_G,
      y0: band?.y0 ?? 0,
      y1: band?.y1 ?? 1,
    },
  );
}

test('retrocgi: green-on-black, line share, near unfaded line', async ({
  page,
}) => {
  await page.goto(
    '/?synthetic=1&render=retrocgi&cell=2x2&crt=0&hud=0&minimap=0&tags=0',
  );
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);

  const boot = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __asciicity?: { groundGrid?: boolean };
      }
    ).__asciicity;
    return {
      render: document.body.dataset.render ?? '',
      groundGrid: api?.groundGrid ?? true,
    };
  });

  // 1. Style id on the body and the floor grid is off.
  expect(boot.render).toBe('retrocgi');
  expect(boot.groundGrid).toBe(false);

  const stats = await retroPixelStats(page);
  console.log(
    'retrocgi measured: ' +
      JSON.stringify({
        bg: +stats.bg.toFixed(4),
        green: +stats.green.toFixed(4),
        ticketGreen: +stats.ticketGreen.toFixed(4),
        other: +stats.other.toFixed(4),
        near: stats.near,
        n: stats.n,
        nearG: +NEAR_G.toFixed(2),
        RETRO_BG,
        FADE_MIN,
      }),
  );

  // 2. Nothing but black and green (separates retrocgi from edges).
  expect(stats.other).toBeLessThanOrEqual(0.01);
  // 3. Lines exist, screen not flooded.
  expect(stats.green).toBeGreaterThanOrEqual(0.03);
  expect(stats.green).toBeLessThanOrEqual(0.45);
  // 4. Most of the tube is background.
  expect(stats.bg).toBeGreaterThanOrEqual(0.5);
  // 5. At least one near, unfaded line pixel.
  expect(stats.near).toBeGreaterThanOrEqual(1);
});

// 6. Shoreline. `syntheticCity()` (src/data/synthetic.ts) emits no `water`
//    rings — ships.spec.ts / sf.spec.ts get water into view by booting the
//    real SF dataset (`?city=sf&at=pier39`), which is out of scope here.
//    Skip rather than invent water data.
test.fixme(
  'retrocgi: shoreline green share in the water half',
  async () => {
    // Would boot a second page aimed at water and assert that a frame whose
    // lower half is water still has green share ≥ 0.5 % in that half.
    throw new Error(
      'synthetic city has no water rings; shoreline assertion not implemented',
    );
  },
);
