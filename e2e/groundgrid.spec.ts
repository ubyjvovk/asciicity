/**
 * Per-style ground grid e2e (docs/architecture.md §4.11 "Ground grid per
 * style", T-0132). Boots `/?synthetic=1&render=quest` and proves the
 * perspective floor grid is hidden under `quest` (`groundGrid === false`)
 * and restored under `ascii` (`groundGrid === true`), and that hiding it
 * actually removes the near-white grid lines from the frame (pixel check
 * aimed straight down at `time=12:00`). Boot helpers (`waitReady`,
 * `aim`, `doubleRaf`) are copied from `e2e/lowpoly.spec.ts` without
 * editing it.
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

/**
 * Point the camera (`yaw`/`pitch` radians) via the live pose exposed on
 * `window.__asciicity` (`stepPlayer` preserves `yaw`/`pitch` with no look
 * input). `pitch = -1.4` aims almost straight down so the floor fills the
 * frame.
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

/**
 * Fraction of near-white pixels in `#view` via an offscreen 2d copy (same
 * copy path as `e2e/amber.spec.ts`): all channels ≥ `thr` (0–255). The
 * perspective grid lines are bright green-white; with the grid hidden the
 * floor is a flat dark fill, so this fraction should stay tiny.
 */
async function nearWhiteFraction(page: Page, thr: number): Promise<number> {
  return page.evaluate(
    (t) => {
      const el = document.getElementById('view');
      if (!(el instanceof HTMLCanvasElement)) return 1;
      const w = el.width;
      const h = el.height;
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const ctx = off.getContext('2d');
      if (!ctx) return 1;
      ctx.drawImage(el, 0, 0);
      const data = ctx.getImageData(0, 0, w, h).data;
      const n = w * h;
      let near = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] >= t && data[i + 1] >= t && data[i + 2] >= t) near++;
      }
      return near / n;
    },
    thr,
  );
}

test('ground grid: quest hides it, ascii restores it, R cycles groundGrid', async ({
  page,
}) => {
  await page.goto('/?synthetic=1&render=quest');
  await waitReady(page);

  const read = (): Promise<{ render: string; groundGrid: boolean }> =>
    page.evaluate(() => {
      const api = (
        window as unknown as {
          __asciicity?: { render?: string; groundGrid?: boolean };
        }
      ).__asciicity;
      return { render: api?.render ?? '', groundGrid: api?.groundGrid ?? false };
    });

  // quest declares groundGrid: false → no grid.
  expect(await read()).toEqual({ render: 'quest', groundGrid: false });

  // Press R (forward cycle) until we land on ascii, asserting the grid
  // comes back with it.
  let cur = await read();
  let guard = 0;
  while (cur.render !== 'ascii' && guard++ < 30) {
    await page.keyboard.press('KeyR');
    await page.waitForFunction(
      (prev) => {
        const api = (
          window as unknown as { __asciicity?: { render?: string } }
        ).__asciicity;
        return api?.render !== prev;
      },
      cur.render,
    );
    await doubleRaf(page);
    cur = await read();
  }
  console.log(
    'ground grid cycle: reached ' +
      JSON.stringify(cur) +
      ' after ' +
      guard +
      ' presses',
  );

  expect(cur.render).toBe('ascii');
  expect(cur.groundGrid).toBe(true);
});

test('ground grid: no near-white grid lines with quest aimed straight down', async ({
  page,
}) => {
  await page.goto('/?synthetic=1&render=quest&time=12:00');
  await waitReady(page);
  await doubleRaf(page);
  await aim(page, 0, -1.4); // straight down — the floor fills the frame

  const frac = await nearWhiteFraction(page, 200);
  console.log('quest ground-grid near-white fraction: ' + frac.toFixed(4));

  // No grid lines: near-white (all channels ≥ 200/255) < 0.02 of pixels.
  expect(frac).toBeLessThan(0.02);
});
