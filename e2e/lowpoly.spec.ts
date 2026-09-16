/**
 * Lowpoly-style e2e (docs/architecture.md §4.11 "`lowpoly` (wave 15)").
 * Boots `/?synthetic=1&render=lowpoly&cell=6x6&time=12:00` and proves the
 * frame really is flat palette facets with ink outlines, by measuring
 * pixels off the `#view` canvas (offscreen-2d copy, as in
 * `e2e/amber.spec.ts`, whose boot helpers this spec copies without
 * editing it).
 *
 * The four assertions:
 *   1. paints — non-black fraction > 0.02 (it renders at all);
 *   2. palette purity — ≥ 0.90 of all pixels within 12/255 per channel of
 *      some expected colour (every `LOWPOLY_HUES` × `LOWPOLY_LUM` combo,
 *      the grey `[1,1,1]` × lum ramp, `LOWPOLY_INK`, and black);
 *   3. outlines present but not dominant — the fraction of pixels within
 *      12/255 of `LOWPOLY_INK` or black is between 0.02 and 0.60;
 *   4. hue diversity — at least 3 of the 8 non-grey hues each appear on
 *      ≥ 0.5 % of pixels (the look must not collapse to one hue).
 */
import { test, expect, type Page } from '@playwright/test';
import { LOWPOLY_HUES, LOWPOLY_LUM, LOWPOLY_INK } from '../src/render/styles/lowpoly';

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
 * luminance bands first (index `h * 4 + l`), then the grey ramp, ink and
 * black. Mirrors the shader's discrete colour set term for term.
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
  flat.push(...to8(LOWPOLY_INK));
  flat.push(0, 0, 0);
  return flat;
})();

/** Ink and black as 8-bit triples for the outline-fraction check. */
const INK_8 = to8(LOWPOLY_INK);

/**
 * Pixel stats from `#view` via an offscreen 2d canvas (same copy path as
 * `amber.spec.ts`): `nonBlack`/`purity`/`ink` fractions plus the per-hue
 * fraction (`hueFracs[h]` = pixels within TOL of any `LOWPOLY_HUES[h]` ×
 * band colour).
 */
async function lowpolyPixelStats(page: Page): Promise<{
  nonBlack: number;
  purity: number;
  ink: number;
  hueFracs: number[];
}> {
  return page.evaluate(
    (opts: { pal: number[]; ink: number[]; tol: number; hueCount: number; lumCount: number }) => {
      const { pal, ink, tol, hueCount, lumCount } = opts;
      const el = document.getElementById('view');
      const empty = {
        nonBlack: 0,
        purity: 0,
        ink: 0,
        hueFracs: new Array(hueCount).fill(0),
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
      }
      return {
        nonBlack: nonBlack / n,
        purity: pure / n,
        ink: inkCount / n,
        hueFracs: hueCnt.map((c) => c / n),
      };
    },
    { pal: PALETTE, ink: INK_8, tol: TOL, hueCount: HUE_COUNT, lumCount: LUM_COUNT },
  );
}

test('lowpoly: paints, flat palette facets, ink outlines, hue diversity', async ({
  page,
}) => {
  await page.goto('/?synthetic=1&render=lowpoly&cell=6x6&time=12:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);

  const stats = await lowpolyPixelStats(page);
  console.log(
    'lowpoly measured: ' +
      JSON.stringify(
        {
          nonBlack: +stats.nonBlack.toFixed(4),
          purity: +stats.purity.toFixed(4),
          ink: +stats.ink.toFixed(4),
          hueFracs: stats.hueFracs.map((f) => +f.toFixed(4)),
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
});
