# Deployment

AsciiCity is deployed to GitHub Pages by
`.github/workflows/pages.yml` (workflow name: `pages`).

## What the workflow does

Trigger: every push to `main` and on manual `workflow_dispatch`.
Concurrency group `pages` cancels any in-flight run when a newer commit lands.

Permissions: `contents: read`, `pages: write`, `id-token: write` — the minimum
GitHub Pages needs to publish via OIDC.

### `build` job (ubuntu-latest)

1. `actions/checkout@v4`.
2. `actions/setup-node@v4` — Node 22 with `cache: npm`.
3. `npm ci` — install from the lockfile.
4. `npm test` — vitest gate; the deploy is blocked if unit tests fail.
5. `VITE_BASE=/asciicity/ npm run build` — Vite reads `VITE_BASE` and emits
   asset URLs under `/asciicity/`, matching the project-site path.
6. `actions/configure-pages@v5`.
7. `actions/upload-pages-artifact@v3` uploads `dist/` as the Pages artifact.

### `deploy` job

Needs `build`. Runs `actions/deploy-pages@v4` in the `github-pages`
environment and exposes the live URL as the environment URL.

Live URL: `https://ubyjvovk.github.io/asciicity/`.

## One-time manual setup

The repo owner must do this once, in the GitHub UI:

- **Settings → Pages → Source: GitHub Actions**

Without that, `actions/deploy-pages@v4` has nowhere to publish and the
workflow fails on the first run. No custom domain, no branch-based Pages
source — the artifact from the workflow is the only input.
