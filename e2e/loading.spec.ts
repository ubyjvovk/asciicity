/**
 * AsciiCity loading indicator end-to-end test (docs/architecture.md §4.18,
 * T-0085). Boots the real `sf.json` at Union Square, polls
 * `__asciicity.loading.phase` every 50 ms, and asserts the observed set
 * contains `build`, ends at `ready`, and the overlay `<p>` no longer carries
 * a `LOADING` or `BUILDING` banner. Never edits smoke/sf/ships specs.
 */
import { test, expect, type Page } from '@playwright/test';

/**
 * Poll `__asciicity.loading.phase` every 50 ms until `ready`, collecting the
 * distinct set of phases observed along the way. Times out at 90 s (SF loads
 * a 14.7 MB dataset).
 */
async function pollPhases(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const seen = new Set<string>();
    const deadline = performance.now() + 90_000;
    while (performance.now() < deadline) {
      const api = (
        window as unknown as {
          __asciicity?: { loading?: { phase?: string } };
        }
      ).__asciicity;
      const phase = api?.loading?.phase;
      if (typeof phase === 'string') seen.add(phase);
      if (phase === 'ready') return [...seen];
      await new Promise((r) => setTimeout(r, 50));
    }
    return [...seen];
  });
}

test('loading: phase progresses through build to ready and the overlay clears the banner', async ({
  page,
}) => {
  await page.goto('/?city=sf&at=unionsquare');

  const phases = await pollPhases(page);
  expect(phases).toContain('build');
  expect(phases[phases.length - 1]).toBe('ready');

  const overlayText = await page.locator('#overlay p').textContent();
  const text = overlayText ?? '';
  expect(text).not.toContain('LOADING');
  expect(text).not.toContain('BUILDING');
});
