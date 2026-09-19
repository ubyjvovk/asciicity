/**
 * AsciiCity Minas Tirith end-to-end tests (docs/architecture.md §4.23, T-0128).
 * Boots the synthesised tiled dataset at the Great Gate in the `crayon` style,
 * checks the HUD names a Minas Tirith place, walks into the first ramp, and
 * proves `?at=citadel` stands on the L7 plateau and the White Tower wears
 * the light running-bond stone facade (§4.23, T-0133). Boot helpers copied
 * from `e2e/tokyo.spec.ts`; aim/pixel helpers copied from
 * `e2e/lowpoly.spec.ts`. Never edits smoke/tiles/loading specs.
 */
import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ timeout: 300_000 });

/** Wait until `__asciicity.ready` is true (tiled boot — allow 90 s). */
async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __asciicity?: { ready?: boolean } }).__asciicity;
      return api?.ready === true;
    },
    undefined,
    { timeout: 90_000 },
  );
}

/**
 * Point the camera (`yaw`/`pitch` radians) via the live pose on
 * `window.__asciicity` (copied from `e2e/lowpoly.spec.ts` — `stepPlayer`
 * preserves `yaw`/`pitch` with no look input).
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

/**
 * Fraction of `#view` pixels that are near-black (all channels < 40/255),
 * via an offscreen 2d copy (same copy path as `e2e/lowpoly.spec.ts`).
 * The office-window map paints dark window squares; running-bond stone
 * (architecture.md §4.23 "Facade") is light masonry, so the fraction must
 * stay low when the camera faces the White Tower.
 */
async function nearBlackFraction(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.getElementById('view');
    if (!(el instanceof HTMLCanvasElement)) return -1;
    const w = el.width;
    const h = el.height;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return -1;
    ctx.drawImage(el, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 40) dark++;
    }
    return dark / (w * h);
  });
}

test('minas-tirith: boots ?city=minas-tirith at the Great Gate in crayon, HUD names the city, walking climbs the ramp', async ({
  page,
}) => {
  await page.goto('/?city=minas-tirith');
  await waitReady(page);

  const boot = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __asciicity?: { city?: string; render?: string; y?: number };
      }
    ).__asciicity;
    return {
      city: api?.city ?? '',
      render: api?.render ?? '',
      y: api?.y ?? NaN,
    };
  });
  expect(boot.city).toBe('minas-tirith');
  expect(boot.render).toBe('crayon');

  // HUD updates every 4th frame; `ready` flips on frame 1 so ZONE/LANDMARK
  // arrive a few frames later. Accept GREAT GATE (place/landmark) or any
  // other Minas Tirith name on those rows (The Climbing Way, Pelennor, …).
  const hud = page.locator('#hud');
  await expect(hud).toContainText(/ZONE|LANDMARK/, { timeout: 5_000 });
  const hudText = (await hud.textContent()) ?? '';
  expect(
    /great gate|climbing way|pelennor|ecthelion|citadel|rath|healing|fountain/i.test(
      hudText,
    ),
    `HUD had no Minas Tirith name:\n${hudText}`,
  ).toBe(true);

  // Enter the canvas (pointer lock) then walk west into the city. Spawn is
  // (R_1 + 40, 0) = 460 m east; the L2 ramp that yields ≥ 3 m of climb
  // starts ~82 m west (architecture.md §4.23). 1.5 s at WALK_SPEED 9 m/s
  // only covers 13.5 m of Pelennor, so we hold KeyW until y rises.
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const startY = boot.y;
  await page.keyboard.down('KeyW');
  // SwiftShader e2e runs well below WALK_SPEED (dt is capped at 0.1 s), so
  // the ~82 m to the L2 ramp can take tens of seconds. Hold until y rises.
  await page.waitForFunction(
    (y0) => {
      const api = (window as unknown as { __asciicity?: { y?: number } }).__asciicity;
      return typeof api?.y === 'number' && api.y - y0 >= 3;
    },
    startY,
    { timeout: 170_000 },
  );
  await page.keyboard.up('KeyW');
  const endY = await page.evaluate(() => {
    const api = (window as unknown as { __asciicity?: { y?: number } }).__asciicity;
    return api?.y ?? NaN;
  });
  expect(endY - startY).toBeGreaterThanOrEqual(3);
  console.log(
    `minas-tirith boot city=${boot.city} render=${boot.render} y0=${startY.toFixed(2)} y1=${endY.toFixed(2)} dy=${(endY - startY).toFixed(2)}`,
  );
});

test('minas-tirith: ?city=minas-tirith&at=citadel boots on the Citadel plateau (y ≥ 200)', async ({
  page,
}) => {
  await page.goto('/?city=minas-tirith&at=citadel');
  await waitReady(page);
  const out = await page.evaluate(() => {
    const api = (
      window as unknown as { __asciicity?: { y?: number; city?: string } }
    ).__asciicity;
    return { y: api?.y ?? NaN, city: api?.city ?? '' };
  });
  expect(out.city).toBe('minas-tirith');
  expect(out.y).toBeGreaterThanOrEqual(200);

  // Facade (architecture.md §4.23): face west (yaw −π/2) at the White Tower,
  // slightly tilted up, and sample the frame. Stone masonry is light; the
  // office-window map would paint dark window squares and fail this.
  await aim(page, -Math.PI / 2, 0.3);
  const nearBlack = await nearBlackFraction(page);
  expect(nearBlack).toBeGreaterThanOrEqual(0);
  expect(nearBlack).toBeLessThan(0.15);
  console.log(
    `minas-tirith citadel city=${out.city} y=${out.y.toFixed(2)} nearBlack=${nearBlack.toFixed(4)}`,
  );
});
