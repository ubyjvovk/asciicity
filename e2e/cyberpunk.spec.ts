/**
 * Cyberpunk style e2e (wave 20 / 20b quality bar, docs/architecture.md
 * §4.11 "cyberpunk v2"). Boots `/?synthetic=1&crt=0&hud=0&minimap=0&tags=0`
 * in `ascii`, takes a scene census, then `Shift+R` into `cyberpunk`.
 *
 * The CI browser is SwiftShader with no WebGPU adapter, so this exercises
 * the WebGPURenderer's WebGL2 fallback backend. Asserts:
 *   1. the lazily imported view reaches `status === 'ready'` and `#punk` is shown;
 *   2. the frame is not black;
 *   3. the rain height probe sees the ground under the player;
 *   4. every registered layer reports stats (`detail.on`, `props.on`, `neon.on`);
 *   5. `L` cycles the look, `G` toggles lens rain, `N` toggles neon;
 *   6. `R` hands back to WebGL: `#punk` hidden, and the scene census equals
 *      the pre-cyberpunk census exactly (same mesh count, zero node materials);
 *   7. ZERO console errors / page errors for the whole run (third-party
 *      beacon noise excluded).
 */
import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 640, height: 360 } });

type Census = { meshes: number; nodeMaterials: number };
type PunkApi = {
  status: string;
  backend: string;
  look: string;
  glass: boolean;
  experimental: string[];
  probe(x: number, z: number): Promise<number | null>;
  stats(): Record<string, number>;
  census(): Census;
};
type Api = {
  ready: boolean;
  render: string;
  state: { x: number; z: number; y: number };
  punk: PunkApi;
};

/** Console lines that are not ours (analytics beacon blocked offline). */
const NOISE = /cloudflareinsights|ERR_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/;

async function api<T>(page: Page, fn: (a: Api) => T | Promise<T>): Promise<T> {
  return page.evaluate(`(${fn.toString()})(window.__asciicity)`) as Promise<T>;
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

test('cyberpunk: view, rain collision, layers, keys, exact scene restore, zero console errors', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));

  await page.goto('/?synthetic=1&render=ascii&crt=0&hud=0&minimap=0&tags=0');
  await page.waitForFunction(() => (window as unknown as { __asciicity?: Api }).__asciicity?.ready === true, undefined, {
    timeout: 60_000,
  });
  const before = await api(page, (a) => a.punk.census());
  expect(before.nodeMaterials).toBe(0);

  await page.keyboard.press('Shift+KeyR');
  await page.waitForFunction(
    () => {
      const p = (window as unknown as { __asciicity: Api }).__asciicity.punk;
      return p.status === 'ready' || p.status === 'failed';
    },
    undefined,
    { timeout: 60_000 },
  );
  // 1.
  const punk = await api(page, (a) => ({ status: a.punk.status, render: a.render }));
  expect(punk.status, JSON.stringify(punk)).toBe('ready');
  expect(punk.render).toBe('cyberpunk');
  await expect(page.locator('#punk')).toBeVisible();
  await page.waitForTimeout(2000);

  // 2.
  expect(await punkLuma(page)).toBeGreaterThan(2);

  // 3.
  const h = await api(page, (a) => a.punk.probe(a.state.x, a.state.z));
  expect(h).not.toBeNull();
  expect(Math.abs((h ?? 1e9) - 0)).toBeLessThan(2);

  // 4.
  const stats = await api(page, (a) => a.punk.stats());
  for (const id of ['detail', 'props', 'neon']) expect(Object.keys(stats), id).toContain(`${id}.on`);
  expect(stats['renderer.calls']).toBeGreaterThan(0);

  // 5.
  const look0 = await api(page, (a) => a.punk.look);
  await page.keyboard.press('KeyL');
  expect(await api(page, (a) => a.punk.look)).not.toBe(look0);
  const glass0 = await api(page, (a) => a.punk.glass);
  await page.keyboard.press('KeyG');
  expect(await api(page, (a) => a.punk.glass)).toBe(!glass0);
  const neon0 = await api(page, (a) => a.punk.stats()['neon.on']);
  await page.keyboard.press('KeyN');
  expect(await api(page, (a) => a.punk.stats()['neon.on'])).toBe(neon0 === 1 ? 0 : 1);
  await page.keyboard.press('KeyN');

  // 6.
  await page.keyboard.press('KeyR');
  await expect(page.locator('#punk')).toBeHidden();
  expect(await api(page, (a) => a.render)).toBe('ascii');
  const after = await api(page, (a) => a.punk.census());
  expect(after).toEqual(before);

  // 7.
  expect(errors, errors.join('\n')).toEqual([]);
});
