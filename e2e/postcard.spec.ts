/**
 * End-to-end tests for postcard PNG export (T-0072, docs/architecture.md
 * §4.15). Verifies the `__asciicity.postcard('png')` hook (real PNG bytes +
 * IHDR dimensions), the `P` key download, and the touch pause-menu SAVE PNG
 * button download.
 */
import { test, expect, type Page } from '@playwright/test';

/** Shape of the `__asciicity` fields this spec exercises. */
interface AsciiApi {
  ready: boolean;
  postcard(kind: string): Promise<Blob>;
}

/** Wait until `__asciicity.ready` is true (mirrors smoke.spec.ts). */
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

/** The 8-byte PNG signature. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test('postcard: postcard("png") resolves to a real PNG of canvas + 28 px caption', async ({
  page,
}) => {
  await page.goto('/?synthetic=1&cell=3x6');
  await waitReady(page);

  const info = await page.evaluate(async () => {
    const api = (
      window as unknown as { __asciicity?: Partial<AsciiApi> }
    ).__asciicity;
    if (!api?.postcard) throw new Error('__asciicity.postcard missing');
    const blob = await api.postcard('png');
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    // IHDR: after the 8-byte magic, 4-byte length, 4-byte "IHDR", then
    // 4-byte width and 4-byte height (both big-endian).
    const width = dv.getUint32(16, false);
    const height = dv.getUint32(20, false);
    const canvas = document.getElementById('view');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no #view canvas');
    return {
      magic: Array.from(buf.slice(0, 8)),
      width,
      height,
      canvasW: canvas.width,
      canvasH: canvas.height,
    };
  });

  expect(info.magic).toEqual(PNG_MAGIC);
  expect(info.width).toBe(info.canvasW);
  expect(info.height).toBe(info.canvasH + 28);
});

test('postcard: P key fires a download with an asciicity-*.png filename', async ({
  page,
}) => {
  await page.goto('/?synthetic=1');
  await waitReady(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('KeyP'),
  ]);
  expect(download.suggestedFilename()).toMatch(/^asciicity-\w+-\d{8}-\d{6}\.png$/);
});

test.describe('postcard (touch 390×844)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('gear → SAVE PNG fires a download', async ({ page }) => {
    await page.goto('/?synthetic=1');
    await waitReady(page);

    // Dismiss the start overlay so the ⚙ is the hit target (smoke.pattern).
    await page.locator('#overlay h1').tap();
    await expect(page.locator('#overlay')).toBeHidden();

    await page.locator('#gear').tap();
    await expect(page.locator('#overlay')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'SAVE PNG' }).tap(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^asciicity-\w+-\d{8}-\d{6}\.png$/);
  });
});
