/**
 * Lowpoly-style e2e (docs/architecture.md §4.11 "`lowpoly` (wave 15)").
 * Boots `/?synthetic=1&render=lowpoly&cell=6x6&time=12:00` and proves the
 * frame really is flat palette facets with ink outlines, by measuring
 * pixels off the `#view` canvas (offscreen-2d copy, as in
 * `e2e/amber.spec.ts`, whose boot helpers this spec copies without
 * editing it).
 *
 * The six assertions:
 *   1. paints — non-black fraction > 0.02 (it renders at all);
 *   2. palette purity — ≥ 0.90 of all pixels within 12/255 per channel of
 *      some expected colour (every `LOWPOLY_HUES` × `LOWPOLY_LUM` combo,
 *      the grey `[1,1,1]` × lum ramp, `LOWPOLY_INK`, the three
 *      `LOWPOLY_SKY` colours, and black);
 *   3. outlines present but not dominant — the fraction of pixels within
 *      12/255 of `LOWPOLY_INK` or black is between 0.02 and 0.60;
 *   4. hue diversity — at least 3 of the 8 non-grey hues each appear on
 *      ≥ 0.5 % of pixels (the look must not collapse to one hue);
 * For assertions 5–6 the camera is aimed (yaw 0 / pitch 1.0 rad in the day
 * test, the default yaw / pitch 0.6 rad in the night test) via the live
 * pose on `window.__asciicity` so the flat sky covers ≥ 5 % of the frame
 * and the sky-band fractions are free of building-facet contamination.
 *
 *   5. day sky — at `time=12:00`, `LOWPOLY_SKY[2]` (day blue) covers ≥ 0.05
 *      of the pixels and `LOWPOLY_SKY[0]` (night navy) < 0.005;
 *   6. night sky — booting `time=23:00` (same boot helpers),
 *      `LOWPOLY_SKY[0]` covers ≥ 0.05 and `LOWPOLY_SKY[2]` < 0.005.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  LOWPOLY_HUES,
  LOWPOLY_LUM,
  LOWPOLY_INK,
  LOWPOLY_SKY,
} from '../src/render/styles/lowpoly';

/** Per-channel tolerance in 8-bit steps (12/255 per the ticket). */
const TOL = 12;

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

/**
 * Point the camera (`yaw`/`pitch` radians) via the live pose exposed on
 * `window.__asciicity` (`stepPlayer` preserves `yaw`/`pitch` with no look
 * input). The day test turns to face north with a steep up-tilt: the flat
 * sky then covers ≥ 5 % of the frame and no dark-blue (hue 5, band 0)
 * building facet is within TOL of the night-navy reference.
 */
async function aim(page: Page, yaw: number, pitch: number): Promise<void> {
  await page.evaluate((o) => {
    const api = (
      window as unknown as {
        __asciicity?: { state?: { yaw: number; pitch: number } };
      }
    ).__asciicity;
    if (api?.state) {
      api.state.yaw = o.yaw;
      api.state.pitch = o.pitch;
    }
  }, { yaw, pitch });
  await doubleRaf(page);
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

/** 8-bit `[r, g, b]` for a normalised `[0, 1]` colour. */
function to8(c: readonly [number, number, number]): [number, number, number] {
  return [
    Math.round(c[0] * 255),
    Math.round(c[1] * 255),
    Math.round(c[2] * 255),
  ];
}

/**
 * The expected palette as a flat `[r, g, b, ...]` array: the 8 hues × 4
 * luminance bands first (index `h * 4 + l`), then the grey ramp, the three
 * `LOWPOLY_SKY` colours, ink and black. Mirrors the shader's discrete
 * colour set term for term.
 */
const HUE_COUNT = LOWPOLY_HUES.length;
const LUM_COUNT = LOWPOLY_LUM.length;
const PALETTE: number[] = (() => {
  const flat: number[] = [];
  for (const hue of LOWPOLY_HUES) {
    for (const lum of LOWPOLY_LUM) {
      flat.push(...to8([hue[0] * lum, hue[1] * lum, hue[2] * lum]));
    }
  }
  for (const lum of LOWPOLY_LUM) flat.push(...to8([lum, lum, lum]));
  for (const sky of LOWPOLY_SKY) flat.push(...to8(sky));
  flat.push(...to8(LOWPOLY_INK));
  flat.push(0, 0, 0);
  return flat;
})();

/** Ink and black as 8-bit triples for the outline-fraction check. */
const INK_8 = to8(LOWPOLY_INK);

/** The three `LOWPOLY_SKY` colours as 8-bit triples (flat, band-major). */
const SKY_8: number[] = LOWPOLY_SKY.flatMap((s) => to8(s));
const SKY_COUNT = LOWPOLY_SKY.length;

/**
 * Pixel stats from `#view` via an offscreen 2d canvas (same copy path as
 * `amber.spec.ts`): `nonBlack`/`purity`/`ink` fractions plus the per-hue
 * fraction (`hueFracs[h]` = pixels within TOL of any `LOWPOLY_HUES[h]` ×
 * band colour) and the per-sky-band fraction (`skyFracs[b]` = pixels
 * within TOL of `LOWPOLY_SKY[b]`).
 */
async function lowpolyPixelStats(page: Page): Promise<{
  nonBlack: number;
  purity: number;
  ink: number;
  hueFracs: number[];
  skyFracs: number[];
}> {
  return page.evaluate(
    (opts: {
      pal: number[];
      ink: number[];
      sky: number[];
      tol: number;
      hueCount: number;
      lumCount: number;
      skyCount: number;
    }) => {
      const { pal, ink, sky, tol, hueCount, lumCount, skyCount } = opts;
      const el = document.getElementById('view');
      const empty = {
        nonBlack: 0,
        purity: 0,
        ink: 0,
        hueFracs: new Array(hueCount).fill(0),
        skyFracs: new Array(skyCount).fill(0),
      };
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
      const n = w * h;
      let nonBlack = 0;
      let pure = 0;
      let inkCount = 0;
      const hueCnt = new Array<number>(hueCount).fill(0);
      const skyCnt = new Array<number>(skyCount).fill(0);
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r > 0 || g > 0 || b > 0) nonBlack++;
        // Palette purity: within `tol` per channel of any expected colour.
        let isPure = false;
        for (let p = 0; p < pal.length; p += 3) {
          if (
            Math.abs(r - pal[p]) <= tol &&
            Math.abs(g - pal[p + 1]) <= tol &&
            Math.abs(b - pal[p + 2]) <= tol
          ) {
            isPure = true;
            break;
          }
        }
        if (isPure) pure++;
        // Outline fraction: within `tol` of ink or black.
        if (
          (Math.abs(r - ink[0]) <= tol &&
            Math.abs(g - ink[1]) <= tol &&
            Math.abs(b - ink[2]) <= tol) ||
          (r <= tol && g <= tol && b <= tol)
        ) {
          inkCount++;
        }
        // Hue attribution: first hue whose band colour matches.
        let matched = -1;
        for (let hh = 0; hh < hueCount && matched < 0; hh++) {
          for (let l = 0; l < lumCount; l++) {
            const p = (hh * lumCount + l) * 3;
            if (
              Math.abs(r - pal[p]) <= tol &&
              Math.abs(g - pal[p + 1]) <= tol &&
              Math.abs(b - pal[p + 2]) <= tol
            ) {
              matched = hh;
              break;
            }
          }
        }
        if (matched >= 0) hueCnt[matched]++;
        // Sky attribution: the LOWPOLY_SKY band this pixel is within TOL of.
        for (let s = 0; s < skyCount; s++) {
          const p = s * 3;
          if (
            Math.abs(r - sky[p]) <= tol &&
            Math.abs(g - sky[p + 1]) <= tol &&
            Math.abs(b - sky[p + 2]) <= tol
          ) {
            skyCnt[s]++;
          }
        }
      }
      return {
        nonBlack: nonBlack / n,
        purity: pure / n,
        ink: inkCount / n,
        hueFracs: hueCnt.map((c) => c / n),
        skyFracs: skyCnt.map((c) => c / n),
      };
    },
    {
      pal: PALETTE,
      ink: INK_8,
      sky: SKY_8,
      tol: TOL,
      hueCount: HUE_COUNT,
      lumCount: LUM_COUNT,
      skyCount: SKY_COUNT,
    },
  );
}

test('lowpoly: paints, flat palette facets, ink outlines, hue diversity', async ({
  page,
}) => {
  await page.goto('/?synthetic=1&render=lowpoly&cell=6x6&time=12:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);
  await aim(page, 0, 1.0); // face north, steep up-tilt, for assertion 5

  const stats = await lowpolyPixelStats(page);
  console.log(
    'lowpoly measured: ' +
      JSON.stringify(
        {
          nonBlack: +stats.nonBlack.toFixed(4),
          purity: +stats.purity.toFixed(4),
          ink: +stats.ink.toFixed(4),
          hueFracs: stats.hueFracs.map((f) => +f.toFixed(4)),
          skyFracs: stats.skyFracs.map((f) => +f.toFixed(4)),
        },
      ),
  );

  // 1. It renders at all.
  expect(stats.nonBlack).toBeGreaterThan(0.02);
  // 2. Palette purity: nearly every pixel is an exact palette colour.
  expect(stats.purity).toBeGreaterThanOrEqual(0.9);
  // 3. Outlines present but not dominant.
  expect(stats.ink).toBeGreaterThanOrEqual(0.02);
  expect(stats.ink).toBeLessThanOrEqual(0.6);
  // 4. At least 3 non-grey hues, each on ≥ 0.5 % of pixels.
  const strongHues = stats.hueFracs.filter((f) => f >= 0.005).length;
  expect(strongHues).toBeGreaterThanOrEqual(3);
  // 5. Day sky (time=12:00): day blue covers ≥ 0.05, night navy < 0.005.
  expect(stats.skyFracs[2]).toBeGreaterThanOrEqual(0.05);
  expect(stats.skyFracs[0]).toBeLessThan(0.005);
});

test('lowpoly: night sky is navy at time=23:00', async ({ page }) => {
  await page.goto('/?synthetic=1&render=lowpoly&cell=6x6&time=23:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);
  await aim(page, -Math.PI / 2, 0.6); // default view tilted up, for assertion 6

  const stats = await lowpolyPixelStats(page);
  console.log(
    'lowpoly night measured: ' +
      JSON.stringify({ skyFracs: stats.skyFracs.map((f) => +f.toFixed(4)) }),
  );

  // 6. Night sky (time=23:00): night navy covers ≥ 0.05, day blue < 0.005.
  expect(stats.skyFracs[0]).toBeGreaterThanOrEqual(0.05);
  expect(stats.skyFracs[2]).toBeLessThan(0.005);
});
