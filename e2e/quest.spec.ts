/**
 * Quest-style e2e (docs/architecture.md §4.11 "`quest` (wave 16)").
 * Boots `/?synthetic=1&render=quest&cell=3x3&time=12:00` (and `time=23:00`)
 * and proves the frame really paints with the 240 ramp colours, bands its
 * sky, and outlines edges, by measuring pixels off the `#view` canvas
 * (offscreen-2d copy). Boot helpers (`waitReady`, `doubleRaf`, the
 * offscreen-canvas sampler, `aim`) are copied from `e2e/lowpoly.spec.ts`
 * without editing it.
 *
 * The seven assertions:
 *   1. paints — non-black fraction > 0.02 (it renders at all);
 *   2. ramp purity — ≥ 0.95 of pixels within 6/255 per channel of some
 *      `QUEST_RAMPS` colour or black;
 *   3. distinct colours — ≥ 24 distinct expected colours each on ≥ 0.1 % of
 *      pixels (ramps are in use, not posterised to a few tones);
 *   4. day sky (URL A, aimed north / pitch 0.9) — ≥ 0.05 of pixels lie on
 *      ramp 8 (sky) and at least 4 distinct ramp-8 shades appear; ramp 9
 *      (night) < 0.005;
 *   5. night sky (URL B, same aim) — ≥ 0.05 on ramp 9; ramp 8 < 0.005;
 *   6. outlines — in the default (un-aimed) noon view, the fraction of
 *      pixels with shade index ≤ 4 on any ramp is between 0.02 and 0.40
 *      (v2: thin pencil lines);
 *   7. no full-width inked row below the horizon — in the same default
 *      noon view, no row with `y > 0.55·height` has ≥ 80 % of its pixels at
 *      a shade index ≤ 4 (the one-sided outline must not band flat ground).
 */
import { test, expect, type Page } from '@playwright/test';
import { QUEST_RAMPS } from '../src/render/styles/quest';

/** Per-channel tolerance in 8-bit steps (6/255 per the ticket). */
const TOL = 6;

const RAMP_COUNT = QUEST_RAMPS.length;
const SHADE_COUNT = QUEST_RAMPS[0].length;
/** 12 × 20 ramp colours, then black. */
const EXPECTED_COUNT = RAMP_COUNT * SHADE_COUNT + 1;
const SKY_RAMP = 8;
const NIGHT_RAMP = 9;

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
 * input). The sky tests face north with an up-tilt so the banded painted
 * sky covers ≥ 5 % of the frame.
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
 * Expected colour set as a flat `[r, g, b, ...]` array: shade `i` of ramp
 * `r` at index `(r * 20 + i) * 3`, then black. Mirrors the shader's
 * `QUEST_RAMPS` table plus the black that purity also accepts.
 */
const PALETTE: number[] = (() => {
  const flat: number[] = [];
  for (const ramp of QUEST_RAMPS) {
    for (const shade of ramp) flat.push(...to8(shade));
  }
  flat.push(0, 0, 0);
  return flat;
})();

/**
 * Pixel stats from `#view` via an offscreen 2d canvas (same copy path as
 * `lowpoly.spec.ts`): `nonBlack`/`purity` fractions, how many expected
 * colours each cover ≥ 0.1 % of pixels, per-ramp fractions, how many
 * distinct shades of ramps 8 and 9 appear, and the outline fraction
 * (closest match has shade index ≤ 4).
 */
async function questPixelStats(page: Page): Promise<{
  nonBlack: number;
  purity: number;
  distinct: number;
  rampFracs: number[];
  skyShades: number;
  nightShades: number;
  outline: number;
  worstRowFrac: number;
  worstRow: number;
}> {
  return page.evaluate(
    (opts: {
      pal: number[];
      tol: number;
      rampCount: number;
      shadeCount: number;
      expectedCount: number;
      skyRamp: number;
      nightRamp: number;
    }) => {
      const {
        pal,
        tol,
        rampCount,
        shadeCount,
        expectedCount,
        skyRamp,
        nightRamp,
      } = opts;
      const empty = {
        nonBlack: 0,
        purity: 0,
        distinct: 0,
        rampFracs: new Array(rampCount).fill(0),
        skyShades: 0,
        nightShades: 0,
        outline: 0,
        worstRowFrac: 0,
        worstRow: -1,
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
      const n = w * h;
      const colourCnt = new Array<number>(expectedCount).fill(0);
      const rampCnt = new Array<number>(rampCount).fill(0);
      const skyShadeSeen = new Array<boolean>(shadeCount).fill(false);
      const nightShadeSeen = new Array<boolean>(shadeCount).fill(false);
      let nonBlack = 0;
      let pure = 0;
      let outline = 0;
      const rowInk = new Array<number>(h).fill(0);
      const rampColours = rampCount * shadeCount;
      for (let i = 0; i < data.length; i += 4) {
        const row = Math.floor(i / 4 / w);
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r > 0 || g > 0 || b > 0) nonBlack++;
        let best = -1;
        let bestDist = Infinity;
        for (let p = 0, ci = 0; p < pal.length; p += 3, ci++) {
          const dr = Math.abs(r - pal[p]);
          const dg = Math.abs(g - pal[p + 1]);
          const db = Math.abs(b - pal[p + 2]);
          if (dr > tol || dg > tol || db > tol) continue;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) {
            bestDist = dist;
            best = ci;
          }
        }
        if (best < 0) continue;
        pure++;
        colourCnt[best]++;
        if (best < rampColours) {
          const ramp = Math.floor(best / shadeCount);
          const shade = best % shadeCount;
          rampCnt[ramp]++;
          if (shade <= 4) {
            outline++;
            rowInk[row]++;
          }
          if (ramp === skyRamp) skyShadeSeen[shade] = true;
          if (ramp === nightRamp) nightShadeSeen[shade] = true;
        }
      }
      const minDistinct = n * 0.001;
      let distinct = 0;
      for (const c of colourCnt) if (c >= minDistinct) distinct++;
      let skyShades = 0;
      let nightShades = 0;
      for (const seen of skyShadeSeen) if (seen) skyShades++;
      for (const seen of nightShadeSeen) if (seen) nightShades++;
      // Worst below-horizon row (row y > 0.55·height) by inked-pixel fraction.
      let worstFrac = 0;
      let worstRow = -1;
      const horizon = Math.floor(h * 0.55);
      for (let y = horizon; y < h; y++) {
        const frac = rowInk[y] / w;
        if (frac > worstFrac) {
          worstFrac = frac;
          worstRow = y;
        }
      }
      return {
        nonBlack: nonBlack / n,
        purity: pure / n,
        distinct,
        rampFracs: rampCnt.map((c) => c / n),
        skyShades,
        nightShades,
        outline: outline / n,
        worstRowFrac: worstFrac,
        worstRow,
      };
    },
    {
      pal: PALETTE,
      tol: TOL,
      rampCount: RAMP_COUNT,
      shadeCount: SHADE_COUNT,
      expectedCount: EXPECTED_COUNT,
      skyRamp: SKY_RAMP,
      nightRamp: NIGHT_RAMP,
    },
  );
}

test('quest: paints, ramp purity, distinct colours, outlines, day sky', async ({
  page,
}) => {
  await page.goto('/?synthetic=1&render=quest&cell=3x3&time=12:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);

  const unAimed = await questPixelStats(page);
  console.log(
    'quest noon un-aimed: ' +
      JSON.stringify({
        nonBlack: +unAimed.nonBlack.toFixed(4),
        purity: +unAimed.purity.toFixed(4),
        distinct: unAimed.distinct,
        outline: +unAimed.outline.toFixed(4),
        worstRowFrac: +unAimed.worstRowFrac.toFixed(4),
        worstRow: unAimed.worstRow,
        rampFracs: unAimed.rampFracs.map((f) => +f.toFixed(4)),
      }),
  );

  // 1. It renders at all.
  expect(unAimed.nonBlack).toBeGreaterThan(0.02);
  // 2. Ramp purity: nearly every pixel is a QUEST_RAMPS colour or black.
  expect(unAimed.purity).toBeGreaterThanOrEqual(0.95);
  // 3. Ramps in use — not posterised to a few tones.
  expect(unAimed.distinct).toBeGreaterThanOrEqual(24);
  // 6. Thin pencil outlines present but not dominant (default un-aimed noon view).
  expect(unAimed.outline).toBeGreaterThanOrEqual(0.02);
  expect(unAimed.outline).toBeLessThanOrEqual(0.4);
  // 7. No full-width inked row below the horizon (the one-sided outline must
  //    not band flat ground); quote the worst row.
  expect(unAimed.worstRowFrac).toBeLessThan(0.8);

  await aim(page, 0, 0.9); // face north, tilted up, for assertion 4
  const aimed = await questPixelStats(page);
  console.log(
    'quest noon aimed: ' +
      JSON.stringify({
        sky: +aimed.rampFracs[SKY_RAMP].toFixed(4),
        night: +aimed.rampFracs[NIGHT_RAMP].toFixed(4),
        skyShades: aimed.skyShades,
        purity: +aimed.purity.toFixed(4),
      }),
  );

  // 4. Day sky (time=12:00, aimed): ramp 8 ≥ 0.05 with ≥ 4 shades; ramp 9 < 0.005.
  expect(aimed.rampFracs[SKY_RAMP]).toBeGreaterThanOrEqual(0.05);
  expect(aimed.skyShades).toBeGreaterThanOrEqual(4);
  expect(aimed.rampFracs[NIGHT_RAMP]).toBeLessThan(0.005);
});

test('quest: night sky is ramp 9 at time=23:00', async ({ page }) => {
  await page.goto('/?synthetic=1&render=quest&cell=3x3&time=23:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);
  await aim(page, 0, 0.9); // same aim as assertion 4, for assertion 5

  const stats = await questPixelStats(page);
  console.log(
    'quest night aimed: ' +
      JSON.stringify({
        sky: +stats.rampFracs[SKY_RAMP].toFixed(4),
        night: +stats.rampFracs[NIGHT_RAMP].toFixed(4),
        nightShades: stats.nightShades,
        purity: +stats.purity.toFixed(4),
        nonBlack: +stats.nonBlack.toFixed(4),
      }),
  );

  // 5. Night sky (time=23:00, aimed): ramp 9 ≥ 0.05; ramp 8 < 0.005.
  expect(stats.rampFracs[NIGHT_RAMP]).toBeGreaterThanOrEqual(0.05);
  expect(stats.rampFracs[SKY_RAMP]).toBeLessThan(0.005);
});
