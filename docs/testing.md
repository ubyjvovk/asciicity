# Testing

How AsciiCity is tested, how to run the suites, and why the browser flags
below are set. See `docs/architecture.md` §8 for the strategy.

## Unit vs e2e

| | Unit (vitest) | e2e (Playwright) |
|---|---|---|
| Where | `tests/*.test.ts` | `e2e/smoke.spec.ts` |
| Environment | plain node (no DOM/WebGL) | headless Chromium |
| What it covers | every pure function/class: geometry builders, `stepPlayer`, formatters, `ZoneIndex`, the ASCII glyph atlas | browser-only wiring: `Controls` DOM events, `AsciiRenderer`, `Hud`, `main.ts` bootstrap |
| Runs via | `bash .tigerteam/scripts/run-tests.sh` | `npx playwright test` (wrapped by `bash scripts/check.sh`) |

Pure logic must never touch `document`/`window` so it runs in node; anything
that needs a canvas or a real DOM is thin and covered by the smoke test.

## Running the unit suite

```sh
bash .tigerteam/scripts/run-tests.sh            # all tests
bash .tigerteam/scripts/run-tests.sh tests/world/buildings.test.ts   # one file
```

This wrapper is the only supported way to run unit tests; it self-installs
`node_modules` from the lockfile and writes the full log to
`.tigerteam/logs/tests/`.

## Running the e2e smoke test

```sh
npx playwright test
```

or run the full gate:

```sh
bash scripts/check.sh   # install → typecheck → unit → build → e2e
```

The smoke test (`e2e/smoke.spec.ts`) boots the game at `/?synthetic=1`,
waits for `window.__asciicity.ready`, moves the player with `W`, and asserts:

1. the frame loop is `ready`.
2. holding `W` for 600 ms moves the player ≥ 0.5 m.
3. the `#hud` shows `BEARING` and `ZONE`.
4. the rendered frame has > 2% non-black pixels (sampled every pixel by
   copying the WebGL canvas onto a 2D canvas — requires
   `preserveDrawingBuffer: true` in `src/render/scene.ts` §6). The ASCII
   glyphs are thin (1–2 px strokes inside 6×12 px cells), so a coarse
   fixed-step sample aliases into the gaps between strokes and under-reports;
   sampling every pixel robustly detects the glyph coverage (æ≈3.9% on the
   synthetic city).
5. a screenshot is saved to `e2e/__shots__/smoke.png` (gitignored) for the PM.

## Playwright config

`playwright.config.ts` runs one headless Chromium project against a local Vite
dev server on port `4173` (strict), with `workers: 1`, `retries: 0`, and a
60 s per-test timeout. Chromium version is pinned by `@playwright/test`
1.55.1; the worker image bakes chromium-1193 at `/opt/pw-browsers`
(`PLAYWRIGHT_BROWSERS_PATH`), so **never run `playwright install`**.

## Chromium launch flags — why they are set

| Flag | Reason |
|---|---|
| `--enable-unsafe-swiftshader` | lets Chromium use its bundled software GL even though SwiftShader is officially "unsafe"; the CI/worker container has no GPU. |
| `--ignore-gpu-blocklist` | allows software rasterisation for GPU features that would otherwise be blocked on headless/VM hardware. |
| `--use-angle=swiftshader` | forces ANGLE → SwiftShader so WebGL works without a physical GPU. |
| `--disable-dev-shm-usage` | `/dev/shm` is tiny in containers; writes temp files instead so the tab doesn't OOM. |
| `--no-sandbox` | required to run Chromium as root / inside containers without a dedicated sandbox namespace. |

These trade away GPU acceleration for determinism in CI; they are harmless for
the smoke test because correctness is asserted on rendered pixels, not on raw
frame rates (see the performance budget in `docs/architecture.md` §7).

## Screenshots

`e2e/__shots__/` is gitignored; the PM looks at `smoke.png` to visually verify
the ASCII look. `test-results/` (Playwright's default output dir) is also
gitignored.
