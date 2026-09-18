/**
 * Scribble-style e2e (docs/architecture.md §4.11 "`scribble` (wave 17)"),
 * the coloured-ink sketch style from T-0134. Boots
 * `/?synthetic=1&render=scribble&cell=3x3&time=12:00` (URL A) and
 * `time=23:00` (URL B) and proves the frame really draws coloured ink
 * strokes on white paper, orients them by surface (vertical on walls,
 * horizontal on the ground), and tangles the sky — by measuring pixels off
 * the `#view` canvas (offscreen-2d copy). Boot helpers (`waitReady`,
 * `doubleRaf`, the offscreen-canvas sampler, `aim`) are copied from
 * `e2e/quest.spec.ts` without editing it.
 *
 * The seven assertions:
 *   1. paper — in the un-aimed noon frame, paper pixels (within 10/255 per
 *      channel of `PAPER`) are between 0.20 and 0.85 of all pixels (it is
 *      a sketch on white, not solid ink);
 *   2. ink — ink pixels (max channel < 0.35) are between 0.05 and 0.60;
 *   3. coloured ink — ≥ 0.01 of pixels are coloured ink (max < 0.7 and
 *      `max − min` ≥ 0.15) and at least 3 distinct hue bins (12 × 30° bins)
 *      each hold ≥ 0.1 % of pixels — the buildings carry their own ink
 *      colours;
 *   4. wall strokes are vertical — over the middle third of the frame's
 *      width and the rows 0.10–0.45 of the height from the top, the count
 *      of vertical runs of ≥ 6 consecutive ink pixels exceeds the count of
 *      horizontal runs of ≥ 6 by a factor ≥ 1.5;
 *   5. ground strokes are horizontal — over the bottom 20 % of rows, the
 *      horizontal-run count exceeds the vertical-run count by a factor
 *      ≥ 1.5;
 *   6. sky tangle — (URL A, aimed north / pitch 1.1) the top 30 % of rows
 *      are ≥ 0.55 paper and hold ≥ 0.01 ink; (URL B, aimed) the ink
 *      fraction of the top 30 % is greater than URL A's (night tangle is
 *      denser);
 *   7. no full-width inked row — no row below the horizon (bottom 45 % of
 *      the un-aimed noon frame) has ≥ 0.98 ink pixels.
 */
import { test, expect, type Page } from '@playwright/test';
import { PAPER } from '../src/render/styles/scribble';

/** Per-channel paper tolerance in 8-bit steps (10/255 per the ticket). */
const PAPER_TOL = 10;
/** Ink = max channel below this (0–1). */
const INK_MAX = 0.35;
/** Coloured ink = max channel below this (0–1). */
const COLOUR_MAX = 0.7;
/** Coloured ink = max − min at least this (0–1). */
const COLOUR_SPAN = 0.15;
/** Orientation run length, in pixels. */
const RUN_LEN = 6;
/** 12 × 30° hue bins. */
const HUE_BINS = 12;
/** Wall/ground orientation factors. */
const VERT_FACTOR = 1.5;
const HORIZ_FACTOR = 1.5;

/** `PAPER` as 8-bit values, for the within-tolerance paper test. */
const PAPER8: readonly [number, number, number] = [
  Math.round(PAPER[0] * 255),
  Math.round(PAPER[1] * 255),
  Math.round(PAPER[2] * 255),
];

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
 * input). The sky tests face north with an up-tilt so the painted sky
 * covers the top of the frame.
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

/** Scribble pixel statistics returned by {@link scribblePixelStats}. */
interface ScribbleStats {
  paper: number;
  ink: number;
  coloured: number;
  hueBins: number[];
  distinctHueBins: number;
  wallVertRuns: number;
  wallHorizRuns: number;
  groundHorizRuns: number;
  groundVertRuns: number;
  skyPaper: number;
  skyInk: number;
  worstRowFrac: number;
  worstRow: number;
}

/** Empty stats used when the canvas is missing (mirrors `quest.spec.ts`). */
function emptyStats(): ScribbleStats {
  return {
    paper: 0,
    ink: 0,
    coloured: 0,
    hueBins: new Array(HUE_BINS).fill(0),
    distinctHueBins: 0,
    wallVertRuns: 0,
    wallHorizRuns: 0,
    groundHorizRuns: 0,
    groundVertRuns: 0,
    skyPaper: 0,
    skyInk: 0,
    worstRowFrac: 0,
    worstRow: -1,
  };
}

/**
 * Pixel stats from `#view` via an offscreen 2d canvas (same copy path as
 * `quest.spec.ts`): paper/ink/coloured-ink fractions, hue-bin histogram,
 * wall and ground stroke-run counts (vertical vs horizontal, ≥ 6 ink
 * pixels), the top-30 % sky paper/ink fractions, and the worst
 * below-horizon inked row.
 */
async function scribblePixelStats(page: Page): Promise<ScribbleStats> {
  return page.evaluate(
    (opts: {
      paper8: number[];
      tol: number;
      inkMax: number;
      colourMax: number;
      colourSpan: number;
      runLen: number;
      hueBins: number;
    }): ScribbleStats => {
      const { paper8, tol, inkMax, colourMax, colourSpan, runLen, hueBins } =
        opts;
      const el = document.getElementById('view');
      if (!(el instanceof HTMLCanvasElement)) return emptyStats();
      const w = el.width;
      const h = el.height;
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const ctx = off.getContext('2d');
      if (!ctx) return emptyStats();
      ctx.drawImage(el, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      const n = w * h;

      const pr = paper8[0];
      const pg = paper8[1];
      const pb = paper8[2];
      const inkMask = new Uint8Array(n);
      const hueCounts = new Array<number>(hueBins).fill(0);
      const rowInk = new Array<number>(h).fill(0);
      let paper = 0;
      let ink = 0;
      let coloured = 0;
      const skyLimit = Math.floor(h * 0.3);
      let skyN = 0;
      let skyPaper = 0;
      let skyInk = 0;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const row = Math.floor(i / 4 / w);
        if (Math.abs(r - pr) <= tol && Math.abs(g - pg) <= tol && Math.abs(b - pb) <= tol)
          paper++;
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const mx = Math.max(rn, gn, bn);
        const mn = Math.min(rn, gn, bn);
        if (mx < inkMax) {
          ink++;
          inkMask[i / 4] = 1;
          rowInk[row]++;
          if (row < skyLimit) skyInk++;
        }
        if (mx < colourMax && mx - mn >= colourSpan) {
          coloured++;
          let hue = 0;
          const d = mx - mn;
          if (d > 0) {
            if (mx === rn) hue = 60 * (((gn - bn) / d) % 6);
            else if (mx === gn) hue = 60 * ((bn - rn) / d + 2);
            else hue = 60 * ((rn - gn) / d + 4);
          }
          if (hue < 0) hue += 360;
          hueCounts[Math.floor(hue / (360 / hueBins)) % hueBins]++;
        }
        if (row < skyLimit) {
          skyN++;
          if (Math.abs(r - pr) <= tol && Math.abs(g - pg) <= tol && Math.abs(b - pb) <= tol)
            skyPaper++;
        }
      }

      // Run counts over a sub-rectangle (inclusive bounds).
      const runs = (
        x0: number,
        x1: number,
        y0: number,
        y1: number,
      ): { vert: number; horiz: number } => {
        let vert = 0;
        for (let c = x0; c <= x1; c++) {
          let run = 0;
          for (let y = y0; y <= y1; y++) {
            if (inkMask[y * w + c]) run++;
            else {
              if (run >= runLen) vert++;
              run = 0;
            }
          }
          if (run >= runLen) vert++;
        }
        let horiz = 0;
        for (let r = y0; r <= y1; r++) {
          let run = 0;
          for (let c = x0; c <= x1; c++) {
            if (inkMask[r * w + c]) run++;
            else {
              if (run >= runLen) horiz++;
              run = 0;
            }
          }
          if (run >= runLen) horiz++;
        }
        return { vert, horiz };
      };

      // Wall region: middle third of the width, rows 0.10–0.45 of height.
      const wallX0 = Math.floor(w / 3);
      const wallX1 = Math.floor((2 * w) / 3);
      const wallY0 = Math.floor(h * 0.1);
      const wallY1 = Math.floor(h * 0.45);
      const wall = runs(wallX0, wallX1, wallY0, wallY1);
      // Ground region: bottom 20 % of rows, full width.
      const groundY0 = Math.floor(h * 0.8);
      const ground = runs(0, w - 1, groundY0, h - 1);

      // Worst below-horizon row (bottom 45 %) by inked-pixel fraction.
      const horizon = Math.floor(h * 0.55);
      let worstFrac = 0;
      let worstRow = -1;
      for (let y = horizon; y < h; y++) {
        const frac = rowInk[y] / w;
        if (frac > worstFrac) {
          worstFrac = frac;
          worstRow = y;
        }
      }

      let distinctHueBins = 0;
      for (const c of hueCounts) if (c >= n * 0.001) distinctHueBins++;

      return {
        paper: paper / n,
        ink: ink / n,
        coloured: coloured / n,
        hueBins: hueCounts,
        distinctHueBins,
        wallVertRuns: wall.vert,
        wallHorizRuns: wall.horiz,
        groundHorizRuns: ground.horiz,
        groundVertRuns: ground.vert,
        skyPaper: skyN > 0 ? skyPaper / skyN : 0,
        skyInk: skyN > 0 ? skyInk / skyN : 0,
        worstRowFrac: worstFrac,
        worstRow,
      };
    },
    {
      paper8: [...PAPER8],
      tol: PAPER_TOL,
      inkMax: INK_MAX,
      colourMax: COLOUR_MAX,
      colourSpan: COLOUR_SPAN,
      runLen: RUN_LEN,
      hueBins: HUE_BINS,
    },
  );
}

/** Noon aimed sky-ink fraction, captured in test 1 for test 2 to compare. */
let noonAimedSkyInk: number | null = null;

test('scribble: paper, ink, coloured ink, stroke orientation, sky, no full-width row', async ({
  page,
}) => {
  await page.goto('/?synthetic=1&render=scribble&cell=3x3&time=12:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);

  const unAimed = await scribblePixelStats(page);
  console.log(
    'scribble noon un-aimed: ' +
      JSON.stringify({
        paper: +unAimed.paper.toFixed(4),
        ink: +unAimed.ink.toFixed(4),
        coloured: +unAimed.coloured.toFixed(4),
        distinctHueBins: unAimed.distinctHueBins,
        hueBins: unAimed.hueBins,
        wallVertRuns: unAimed.wallVertRuns,
        wallHorizRuns: unAimed.wallHorizRuns,
        groundHorizRuns: unAimed.groundHorizRuns,
        groundVertRuns: unAimed.groundVertRuns,
        worstRowFrac: +unAimed.worstRowFrac.toFixed(4),
        worstRow: unAimed.worstRow,
      }),
  );

  // 1. Paper: a sketch on white, not solid ink (un-aimed noon frame).
  expect(unAimed.paper).toBeGreaterThanOrEqual(0.2);
  expect(unAimed.paper).toBeLessThanOrEqual(0.85);
  // 2. Ink: strokes present but not covering the page.
  expect(unAimed.ink).toBeGreaterThanOrEqual(0.05);
  expect(unAimed.ink).toBeLessThanOrEqual(0.6);
  // 3. Coloured ink: buildings carry their own ink colours across ≥ 3 hue bins.
  expect(unAimed.coloured).toBeGreaterThanOrEqual(0.01);
  expect(unAimed.distinctHueBins).toBeGreaterThanOrEqual(3);
  // 4. Wall strokes are vertical (walls above the horizon).
  expect(unAimed.wallVertRuns).toBeGreaterThan(
    VERT_FACTOR * unAimed.wallHorizRuns,
  );
  // 5. Ground strokes are horizontal (bottom 20 % of rows).
  expect(unAimed.groundHorizRuns).toBeGreaterThan(
    HORIZ_FACTOR * unAimed.groundVertRuns,
  );
  // 7. No full-width inked row below the horizon.
  expect(unAimed.worstRowFrac).toBeLessThan(0.98);

  await aim(page, 0, 1.1); // face north, tilted up, for the sky assertions
  const aimed = await scribblePixelStats(page);
  noonAimedSkyInk = aimed.skyInk;
  console.log(
    'scribble noon aimed: ' +
      JSON.stringify({
        skyPaper: +aimed.skyPaper.toFixed(4),
        skyInk: +aimed.skyInk.toFixed(4),
      }),
  );
  // 6A. Sky tangle (noon): top 30 % is mostly paper with a real ink tangle.
  expect(aimed.skyPaper).toBeGreaterThanOrEqual(0.55);
  expect(aimed.skyInk).toBeGreaterThanOrEqual(0.01);
});

test('scribble: night sky tangle is denser than noon', async ({ page }) => {
  await page.goto('/?synthetic=1&render=scribble&cell=3x3&time=23:00');
  await waitReady(page);
  await doubleRaf(page);
  await doubleRaf(page);
  await aim(page, 0, 1.1); // same aim as the noon sky sample

  const aimed = await scribblePixelStats(page);
  console.log(
    'scribble night aimed: ' +
      JSON.stringify({
        skyPaper: +aimed.skyPaper.toFixed(4),
        skyInk: +aimed.skyInk.toFixed(4),
      }),
  );
  // 6B. Night tangle is denser: more ink in the top 30 % than noon.
  expect(noonAimedSkyInk).not.toBeNull();
  expect(aimed.skyInk).toBeGreaterThan(noonAimedSkyInk as number);
});
