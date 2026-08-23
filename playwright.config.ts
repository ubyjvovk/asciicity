/**
 * Playwright configuration for the AsciiCity e2e smoke test
 * (docs/architecture.md §8, docs/testing.md). Headless Chromium run through
 * a local Vite dev server; screenshots land in `e2e/__shots__/` (gitignored).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: [
        // Software rasteriser so the smoke test passes on machines without a
        // GPU (see docs/testing.md for why each flag is present).
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--use-angle=swiftshader',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // `--host 127.0.0.1` forces IPv4 so the `127.0.0.1` URL below is
    // reachable (Vite 6 otherwise binds only to `localhost`, i.e. ::1).
    command: 'npx vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
  outputDir: 'test-results',
});
