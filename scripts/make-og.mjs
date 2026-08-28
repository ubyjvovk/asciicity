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
 *   already a devDependency. Set `PW_ARGS` to override the Chromium flags
 *   (the PM regenerates on a GPU host with `--use-angle=gl-egl`).
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
      // PW_ARGS overrides the Chromium flags (space-separated) — e.g.
      // `PW_ARGS='--use-angle=gl-egl --ignore-gpu-blocklist --no-sandbox'`
      // on a host with a real GPU captures a full-density 60-fps frame
      // instead of the SwiftShader default.
      args: (process.env.PW_ARGS ?? '--no-sandbox --disable-dev-shm-usage').split(' '),
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

      // Hide the start overlay and the boot-time style toast (`RENDER: ASCII`
      // is still fading on a fast GPU when the FPS row first goes non-zero)
      // so neither covers the frame.
      await page.evaluate(() => {
        for (const id of ['overlay', 'toast']) {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        }
      });

      // Wait until the HUD actually shows a non-zero FPS (the 1-second
      // moving average) so the committed preview never ships a frozen
      // `FPS........ 0` row. Timeout → dump HUD + exit non-zero.
      try {
        await page.waitForFunction(
          () => /FPS\.+\s*[1-9]/.test(document.querySelector('#hud')?.textContent ?? ''),
          undefined,
          { timeout: 20_000 },
        );
      } catch (err) {
        const hud = await page.evaluate(
          () => document.querySelector('#hud')?.textContent ?? '(no #hud)',
        );
        console.error('[make-og] timed out waiting for non-zero FPS; HUD was:');
        console.error(hud);
        throw err;
      }

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

      const fpsRow = await page.evaluate(() => {
        const text = document.querySelector('#hud')?.textContent ?? '';
        const m = /FPS\.+\s*\d+/.exec(text);
        return m ? m[0] : '';
      });
      console.log(`[make-og] ${fpsRow}`);
      if (!/FPS\.+\s*[1-9]/.test(fpsRow)) {
        throw new Error(
          `[make-og] refusing to write a 0-FPS image (${fpsRow || 'missing FPS row'})`,
        );
      }

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
