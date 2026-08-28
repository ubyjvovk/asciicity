#!/usr/bin/env node
/**
 * Regenerate the committed social-preview image `public/og.png` (1200×630,
 * docs/architecture.md §4.15 "Open Graph / social meta").
 *
 * What: drives the built game in headless Chromium exactly like the e2e boot
 *   (e2e/smoke.spec.ts) and screenshots the rendered frame at a 1200×630
 *   viewport down to `public/og.png`. Vite copies `public/` into `dist/` at
 *   build, so the absolute `https://ubyjvovk.github.io/asciicity/og.png`
 *   og:image URL in index.html resolves once deployed.
 *
 * Why: shared links unfurl as a blank tab without a preview image; this is
 *   the single static image X/Reddit/Slack use.
 *
 * How to rerun: `node scripts/make-og.mjs` (node ≥ 22, deps from the
 *   lockfile already installed). No new dependencies — `@playwright/test` is
 *   already a devDependency.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

/** Port for the throwaway Vite server (strictStrict so a collision fails loudly). */
const PORT = 4311;
const BASE = `http://127.0.0.1:${PORT}`;
/** Absolute output path for the committed preview image. */
const OUT = resolve('public', 'og.png');

/** Wait until the Vite dev server answers on the port. */
async function waitForServer(cwd) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`vite did not start on :${PORT}`);
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* not up yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const vite = spawn(
    'npx',
    ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    {
      cwd: process.cwd(),
      stdio: 'ignore',
    },
  );
  try {
    await waitForServer(process.cwd());

    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 630 },
      });

      // `?city=london` bypasses the interactive city picker and loads the
      // London dataset; the default spawn (`?at=` absent) = Westminster
      // Bridge facing Big Ben, and `?time=22:30` gives the night look
      // (lit windows + moon).
      await page.goto(`${BASE}/?city=london&time=22:30`);

      // Same readiness contract as the e2e boot.
      await page.waitForFunction(
        () =>
          (window).__asciicity?.ready === true,
        undefined,
        { timeout: 30_000 },
      );

      // Hide the start overlay so it doesn't cover the frame.
      await page.evaluate(() => {
        const el = document.getElementById('overlay');
        if (el) el.style.display = 'none';
      });

      // Paint two frames (the screenshot target is copied out of the frame
      // loop) before capturing.
      const paint = () =>
        page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(() => r())),
            ),
        );
      await paint();
      await paint();

      await page.screenshot({ path: OUT });
    } finally {
      await browser.close();
    }
  } finally {
    vite.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
