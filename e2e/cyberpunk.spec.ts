/**
 * Cyberpunk style e2e (wave 20). Boots
 * `/?synthetic=1&render=cyberpunk&crt=0&hud=0&minimap=0&tags=0`.
 *
 * The CI browser is SwiftShader with no WebGPU adapter, so this exercises
 * the WebGPURenderer's WebGL2 fallback backend — the path a browser without
 * WebGPU takes. Asserts:
 *   1. the lazily imported view reaches `status === 'ready'` and `#punk` is
 *      shown over `#view`;
 *   2. the frame is not black (lit windows / wet ground / rain);
 *   3. the rain height probe sees the ground under the player (collision map
 *      exists and is populated);
 *   4. `L` cycles the look and `G` toggles the lens rain;
 *   5. `R` hands the frame back to the WebGL path (`#punk` hidden, scene
 *      restored) and `Shift+R` returns to cyberpunk.
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 640, height: 360 } });

type PunkApi = {
  status: string;
  backend: string;
  look: string;
  glass: boolean;
  probe(x: number, z: number): Promise<number | null>;
};
type Api = {
  ready: boolean;
  render: string;
  state: { x: number; z: number; y: number };
  punk: PunkApi;
};

async function waitPunk(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as unknown as { __asciicity?: Api }).__asciicity;
      return api?.ready === true && (api.punk.status === 'ready' || api.punk.status === 'failed');
    },
    undefined,
    { timeout: 60_000 },
  );
}

/** Mean luminance (0–255) of a screenshot of `#punk`. */
async function punkLuma(page: Page): Promise<number> {
  const png = await page.locator('#punk').screenshot();
  return page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (d.length / 4);
  }, png.toString('base64'));
}

test('cyberpunk: WebGPU view (fallback backend), rain collision, look keys, style round-trip', async ({ page }) => {
  await page.goto('/?synthetic=1&render=cyberpunk&crt=0&hud=0&minimap=0&tags=0');
  await waitPunk(page);

  // 1. ready + canvas shown.
  const punk = await page.evaluate(() => (window as unknown as { __asciicity: Api }).__asciicity.punk);
  expect(punk.status, `punk failed: ${JSON.stringify(punk)}`).toBe('ready');
  await expect(page.locator('#punk')).toBeVisible();

  // Let a few frames (and the height pass) run.
  await page.waitForTimeout(1500);

  // 2. something is lit.
  const luma = await punkLuma(page);
  expect(luma).toBeGreaterThan(2);

  // 3. the collision map under the player is the ground (synthetic city is flat).
  const h = await page.evaluate(async () => {
    const a = (window as unknown as { __asciicity: Api }).__asciicity;
    return a.punk.probe(a.state.x, a.state.z);
  });
  expect(h).not.toBeNull();
  expect(Math.abs((h ?? 1e9) - 0)).toBeLessThan(2);

  // 4. look + lens-rain keys.
  const before = await page.evaluate(() => (window as unknown as { __asciicity: Api }).__asciicity.punk.look);
  await page.keyboard.press('KeyL');
  const after = await page.evaluate(() => (window as unknown as { __asciicity: Api }).__asciicity.punk.look);
  expect(after).not.toBe(before);
  const glass0 = await page.evaluate(() => (window as unknown as { __asciicity: Api }).__asciicity.punk.glass);
  await page.keyboard.press('KeyG');
  const glass1 = await page.evaluate(() => (window as unknown as { __asciicity: Api }).__asciicity.punk.glass);
  expect(glass1).toBe(!glass0);

  // 5. R → back to WebGL (first style), Shift+R → cyberpunk again.
  await page.keyboard.press('KeyR');
  await expect(page.locator('#punk')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __asciicity: Api }).__asciicity.render)).toBe('ascii');
  await page.keyboard.press('Shift+KeyR');
  await expect(page.locator('#punk')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __asciicity: Api }).__asciicity.render)).toBe('cyberpunk');
});
