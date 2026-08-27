/**
 * AsciiCity end-to-end smoke test (docs/architecture.md §8, docs/testing.md).
 * Boots the game in a headless Chromium against `/?synthetic=1`, proves it
 * renders non-black ASCII output, moves the player, and shows the HUD, then
 * saves a screenshot the PM can review at `e2e/__shots__/smoke.png`.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { syntheticCity } from '../src/data/synthetic';
import { terrainHeightAt } from '../src/world/terrain';

/** Shape of the T-0010 debug contract exposed on `window.__asciicity`. */
interface AsciiApi {
  ready: boolean;
  state: { x: number; z: number };
  render?: string;
  styles?: string[];
  fps?: number;
}

/** Read the live player x/z from `window.__asciicity.state` (mirrors §5). */
function readPos(page: Page): Promise<{ x: number; z: number }> {
  return test.step('read player state', async () =>
    page.evaluate(() => {
      const api = (
        window as unknown as { __asciicity?: Partial<AsciiApi> }
      ).__asciicity;
      const s = api?.state;
      return { x: s?.x ?? NaN, z: s?.z ?? NaN };
    }),
  );
}

test('smoke: boots, renders, moves, shows HUD, saves screenshot', async ({
  page,
}) => {
  // 1. Boot the game against the deterministic synthetic city.
  await page.goto('/?synthetic=1');

  // 2. Wait until the frame loop has run and exposed the ready contract.
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

  // 3. Read the starting position, then click the canvas centre to enter.
  const start = await readPos(page);
  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // 4. Hold W for 600 ms and confirm the player moved ≥ 0.5 m north.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyW');
  const moved = await readPos(page);
  const distance = Math.hypot(moved.x - start.x, moved.z - start.z);
  expect(distance).toBeGreaterThanOrEqual(0.5);

  // 5. The HUD must be showing BEARING and ZONE rows.
  const hud = page.locator('#hud');
  await expect(hud).toContainText('BEARING');
  await expect(hud).toContainText('ZONE');

  // 6. The rendered output must have > 2% non-black pixels. The WebGL canvas
  //    is copied onto a 2D canvas (preserveDrawingBuffer: true) so pixel data
  //    is readable. The ASCII glyphs are thin (1–2 px strokes inside 6×12 px
  //    cells), so a coarse fixed-step sample (e.g. every 8th pixel) aliases
  //    into the gaps between strokes and under-reports; sampling every pixel
  //    robustly detects the glyph coverage (deterministic ≈3.9% on the
  //    synthetic city).
  const nonBlackFraction = await page.evaluate(() => {
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
  expect(nonBlackFraction).toBeGreaterThan(0.02);

  // 7. Save a screenshot for the PM; the directory is gitignored.
  const shotPath = 'e2e/__shots__/smoke.png';
  mkdirSync('e2e/__shots__', { recursive: true });
  await page.screenshot({ path: shotPath });
});

test('smoke: hills exposes eye height above the synthetic heightfield and an ALT row', async ({
  page,
}) => {
  // The default synthetic seed is 1, blocks 12; hills=1 adds the terrain grid.
  // Compute the expected eye height in node from the same seed the browser boots.
  const hills = syntheticCity(1, 12, true);
  if (!hills.terrain) throw new Error('syntheticCity(1, 12, true) must include terrain');
  const expectedY = 1.7 + terrainHeightAt(hills.terrain, 0, 0);

  await page.goto('/?synthetic=1&hills=1');
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

  // Read `y` and `city` from the extended debug contract.
  const observed = await page.evaluate(() => {
    const api = (
      window as unknown as {
        __asciicity?: { y?: number; city?: string };
      }
    ).__asciicity;
    return { y: api?.y ?? NaN, city: api?.city ?? '' };
  });
  expect(observed.city).toBe('synthetic');
  expect(Math.abs(observed.y - expectedY)).toBeLessThan(0.5);

  // The HUD must render the ALT row when terrain is present.
  const hud = page.locator('#hud');
  await expect(hud).toContainText('ALT');
});

test('smoke: fly — Space climbs in fly mode, HUD shows MODE/FLY', async ({
  page,
}) => {
  // `?fly=1` boots airborne; holding Space rises (up axis) in fly mode.
  await page.goto('/?synthetic=1&fly=1');
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

  const canvas = page.locator('#view');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const readFly = () =>
    page.evaluate(() => {
      const api = (
        window as unknown as { __asciicity?: { y?: number; fly?: boolean } }
      ).__asciicity;
      return { y: api?.y ?? NaN, fly: api?.fly ?? false };
    });

  const before = await readFly();
  expect(before.fly).toBe(true);

  // Hold Space 500 ms — the player should climb several metres.
  await page.keyboard.down('Space');
  await page.waitForTimeout(500);
  await page.keyboard.up('Space');
  const after = await readFly();
  expect(after.y - before.y).toBeGreaterThanOrEqual(5);
  expect(after.fly).toBe(true);

  const hud = page.locator('#hud');
  await expect(hud).toContainText('MODE');
  await expect(hud).toContainText('FLY');
});

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

test('smoke: R cycles every render style and each paints', async ({ page }) => {
  test.setTimeout(120_000);
  // `?cell=3x6` so SwiftShader's 64-row blanking does not hide the lower half.
  await page.goto('/?synthetic=1&cell=3x6');
  await waitReady(page);

  const styles = await page.evaluate(() => {
    const api = (
      window as unknown as { __asciicity?: { styles?: string[] } }
    ).__asciicity;
    return api?.styles ?? [];
  });
  expect(styles.length).toBe(12);

  mkdirSync('e2e/__shots__', { recursive: true });

  for (let i = 0; i < styles.length; i++) {
    const current = await page.evaluate(() => {
      const api = (
        window as unknown as { __asciicity?: { render?: string } }
      ).__asciicity;
      return api?.render ?? '';
    });
    const nextId = styles[(styles.indexOf(current) + 1) % styles.length];
    await page.keyboard.press('KeyR');
    await page.waitForFunction(
      (id) => {
        const api = (
          window as unknown as { __asciicity?: { render?: string } }
        ).__asciicity;
        return api?.render === id;
      },
      nextId,
    );
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const painted = await nonBlackFraction(page);
    expect(painted, nextId).toBeGreaterThan(0.02);
    await page.screenshot({ path: `e2e/__shots__/style-${nextId}.png` });
  }
});

test('smoke: ?render= aliases and R / Shift+R cycle', async ({ page }) => {
  await page.goto('/?synthetic=1&render=solarized');
  await waitReady(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __asciicity?: { render?: string } }).__asciicity
          ?.render,
    ),
  ).toBe('solarized');

  await page.keyboard.press('KeyR');
  await page.waitForFunction(
    () =>
      (window as unknown as { __asciicity?: { render?: string } }).__asciicity
        ?.render === 'braille',
  );

  await page.keyboard.press('Shift+KeyR');
  await page.keyboard.press('Shift+KeyR');
  await page.waitForFunction(
    () =>
      (window as unknown as { __asciicity?: { render?: string } }).__asciicity
        ?.render === 'gloom',
  );

  await page.goto('/?synthetic=1&theme=gloom');
  await waitReady(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __asciicity?: { render?: string } }).__asciicity
          ?.render,
    ),
  ).toBe('gloom');

  await page.goto('/?synthetic=1&render=nope');
  await waitReady(page);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __asciicity?: { render?: string } }).__asciicity
          ?.render,
    ),
  ).toBe('ascii');
});

/** Axis-aligned bounding box of a positioned element. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True when two boxes have empty intersection (edges touching is OK). */
function noOverlap(a: Box, b: Box): boolean {
  return a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
}

/** Read `#mini` / `#hud` / `#gear` / `#credits` bounding boxes. */
async function panelBoxes(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const ids = ['mini', 'hud', 'gear', 'credits'] as const;
    const out: Record<string, Box> = {};
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) {
        out[id] = { x: 0, y: 0, w: 0, h: 0 };
        continue;
      }
      const r = el.getBoundingClientRect();
      out[id] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  });
}

test('smoke: panels', async ({ page }) => {
  await page.goto('/?synthetic=1');
  await waitReady(page);

  const mini = page.locator('#mini');
  const hud = page.locator('#hud');
  await expect(mini).toBeVisible();
  await expect(hud).toBeVisible();

  const boxes = await panelBoxes(page);
  console.log('desktop boxes', JSON.stringify(boxes));
  expect(boxes.mini.w).toBeGreaterThan(0);
  expect(boxes.hud.w).toBeGreaterThan(0);
  expect(boxes.gear.w).toBeGreaterThan(0);
  expect(boxes.credits.w).toBeGreaterThan(0);
  expect(noOverlap(boxes.mini, boxes.hud), `mini vs hud ${JSON.stringify(boxes)}`).toBe(
    true,
  );
  expect(noOverlap(boxes.mini, boxes.gear), `mini vs gear ${JSON.stringify(boxes)}`).toBe(
    true,
  );
  expect(
    noOverlap(boxes.mini, boxes.credits),
    `mini vs credits ${JSON.stringify(boxes)}`,
  ).toBe(true);
  expect(noOverlap(boxes.hud, boxes.gear), `hud vs gear ${JSON.stringify(boxes)}`).toBe(
    true,
  );
  expect(
    noOverlap(boxes.hud, boxes.credits),
    `hud vs credits ${JSON.stringify(boxes)}`,
  ).toBe(true);
  expect(
    noOverlap(boxes.gear, boxes.credits),
    `gear vs credits ${JSON.stringify(boxes)}`,
  ).toBe(true);

  await page.keyboard.press('KeyM');
  await expect(mini).toBeHidden();
  const stored = await page.evaluate(() => localStorage.getItem('asciicity.settings'));
  expect(stored).toContain('"minimap":false');

  await page.keyboard.press('KeyH');
  await expect(hud).toBeHidden();

  await page.locator('#gear').click();
  await expect(page.locator('#overlay')).toBeVisible();
  await expect(page.locator('#menu')).toContainText('HUD: OFF');
  await expect(page.locator('#menu')).toContainText('MINIMAP: OFF');

  await page.getByRole('button', { name: 'MINIMAP: OFF' }).click();
  await expect(mini).toBeVisible();

  const credits = page.locator('#credits');
  await expect(credits).toContainText('@ubyjvovk');
  await expect(credits).toHaveAttribute(
    'href',
    'https://github.com/ubyjvovk/asciicity',
  );
});

test.describe('smoke: panels (touch 390×844)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('gear is visible, opens the menu, and does not move the player', async ({
    page,
  }) => {
    await page.goto('/?synthetic=1');
    await waitReady(page);

    const gear = page.locator('#gear');
    await expect(gear).toBeVisible();
    await expect(page.locator('#mini')).toBeVisible();
    await expect(page.locator('#hud')).toBeVisible();

    const boxes = await panelBoxes(page);
    console.log('touch 390x844 boxes', JSON.stringify(boxes));
    expect(noOverlap(boxes.mini, boxes.hud), `mini vs hud ${JSON.stringify(boxes)}`).toBe(
      true,
    );
    expect(noOverlap(boxes.mini, boxes.gear), `mini vs gear ${JSON.stringify(boxes)}`).toBe(
      true,
    );
    expect(
      noOverlap(boxes.mini, boxes.credits),
      `mini vs credits ${JSON.stringify(boxes)}`,
    ).toBe(true);
    expect(noOverlap(boxes.hud, boxes.gear), `hud vs gear ${JSON.stringify(boxes)}`).toBe(
      true,
    );
    expect(
      noOverlap(boxes.hud, boxes.credits),
      `hud vs credits ${JSON.stringify(boxes)}`,
    ).toBe(true);
    expect(
      noOverlap(boxes.gear, boxes.credits),
      `gear vs credits ${JSON.stringify(boxes)}`,
    ).toBe(true);
    expect(boxes.mini.w).toBeGreaterThan(0);
    expect(boxes.hud.w).toBeGreaterThan(0);

    // Dismiss the start overlay so a tap on the gear could otherwise reach
    // the joystick / look handler. Tap the overlay *heading* (centre of the
    // screen) so the ⚙ button is not the hit target.
    await page.locator('#overlay h1').tap();
    await expect(page.locator('#overlay')).toBeHidden();

    const before = await page.evaluate(() => {
      const s = (
        window as unknown as {
          __asciicity?: {
            state?: {
              x: number;
              z: number;
              y: number;
              yaw: number;
              pitch: number;
              fly: boolean;
            };
          };
        }
      ).__asciicity?.state;
      return s
        ? { x: s.x, z: s.z, y: s.y, yaw: s.yaw, pitch: s.pitch, fly: s.fly }
        : null;
    });
    expect(before).not.toBeNull();

    // Coordinate tap: Playwright's locator.tap() treats the WebGL canvas as
    // intercepting the ⚙ button (SwiftShader compositor). A real touch at the
    // gear's centre must not move the player and must open the menu.
    const gbox = await gear.boundingBox();
    if (!gbox) throw new Error('gear has no bounding box');
    await page.touchscreen.tap(gbox.x + gbox.width / 2, gbox.y + gbox.height / 2);
    await expect(page.locator('#overlay')).toBeVisible();
    await expect(page.locator('#menu')).toContainText('HUD:');

    const after = await page.evaluate(() => {
      const s = (
        window as unknown as {
          __asciicity?: {
            state?: {
              x: number;
              z: number;
              y: number;
              yaw: number;
              pitch: number;
              fly: boolean;
            };
          };
        }
      ).__asciicity?.state;
      return s
        ? { x: s.x, z: s.z, y: s.y, yaw: s.yaw, pitch: s.pitch, fly: s.fly }
        : null;
    });
    expect(after).toEqual(before);
  });
});

