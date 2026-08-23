# Tiger Team state

Written for a cold-start PM who has read nothing else. Keep it current: update
after every review cycle and before ending any session, then commit.

## Mission
**AsciiCity** — a static browser minigame: first-person walk around the City of
London rendered as coloured ASCII glyphs with a green NAVIGATION HUD (reference:
the user's screenshot of a similar live app — dense coloured glyph buildings,
perspective floor grid, black sky, HUD rows SECTOR/WORLD/BEARING/ZONE). Stack
locked in `docs/architecture.md`: Vite + TS + three.js, GPU ASCII post-pass,
OSM building footprints via Overpass (`docs/data-format.md`). "Done" for wave 1
= playable at `npm run dev` and on GitHub Pages with ≥ 55 fps, e2e smoke green.

## Configuration notes
- Mode: single-branch (accepts merge straight into main; no staging worktree).
- Fleet (`tigerteam.toml`): `grok` ×2 (C3), `opus` ×2 (claude, login_auth, C3),
  `ds` ×2 (pi → DeepSeek V4 Flash on DeepInfra, C2). `glm` parked: DeepInfra
  only has GLM-5.2 (user: too slow; also 400'd via pi) — enable when GLM-5.3
  ships. `max_concurrent = 6`.
- Secrets in `<root>/.env` (DEEPINFRA_KEY, GITHUB_TOKEN). The supervisor must be
  restarted after `.env` changes (it was restarted 2026-08-23 23:40 for this).
- `test_cmd = bash scripts/test.sh` (vitest; self-installs node_modules);
  `verify_cmds = bash scripts/check.sh` (typecheck+unit+build+e2e) runs on the
  host in `_staging` — host has playwright chromium-1193 installed
  (`npx playwright@1.55.1 install chromium`, 2026-08-23).
- Worker image `tigerteam-agents:base` has node 22 + chromium-1193 baked
  (`/opt/pw-browsers`) → `@playwright/test` pinned to 1.55.1.
- GitHub: `[github] repo = ubyjvovk/asciicity`, `sync = true` (board → issues,
  tt:* labels), `watch = true`. `gh` CLI is not installed; use `tigerteam gh`.
- The cockpit tmux session is `tigerteam-asciicity` (pane %5 = supervisor).
- PM-owned files: `src/data/types.ts`, `src/world/mesh.ts`, `docs/architecture.md`,
  `docs/data-format.md`, `AGENTS.md`, `package.json`/lock after T-0001.

## Decision log (append-only)
- 2026-08-23 — Stack: Vite+TS+three, GPU ASCII pass (render at cell res → glyph atlas shader) — the only way to get "decent fps" at ~320×90 cells; fully specified in architecture.md §4.8 so it's a C2 ticket.
- 2026-08-23 — Area: City of London bbox `-0.106,51.506,-0.070,51.521`, origin Bank junction; tall buildings match the reference look; bbox is a CLI arg so Westminster can be fetched later.
- 2026-08-23 — Data is fetched once (`scripts/fetch-osm.mjs`) and COMMITTED as `public/data/city.json` (<6 MB) — no runtime Overpass dependency; synthetic city is the offline/test fallback.
- 2026-08-23 — Pure builders return `MeshData` (typed arrays) so geometry is unit-tested in node; browser-only code is thin and covered by the e2e smoke + PM visual review.
- 2026-08-23 — GLM worker dropped (user), Opus worker added (user: "quota to burn").
- 2026-08-23 — Integration ticket T-0010 is C3 (grok/opus only): most judgment lives there.
- 2026-08-24 — **Single-branch mode** (`staging = false`). Staging mode diverged `main`/`staging` on the very first accept (board commit lands on main, merge on staging → `--ff-only` can never advance main) AND worker worktrees are cut from HEAD=main, so the whole fan-out started without T-0001's files. Killed the 6 attempts (KILL.<instance>, strike-free), merged staging into main (77c4ca2), deleted the six stale branches/worktrees and the staging branch, lifted STOP. PM verifies every landing in-container before accept instead.
- 2026-08-24 — Process rule: COMMIT the board/scaffold BEFORE moving tickets into todo/ — workers claim within seconds and cut worktrees from HEAD.

## Board snapshot
- 2026-08-23 23:55 — wave 1 planned: T-0001 (P0 bootstrap) → T-0002…T-0009 fan-out (data, buildings, roads/ground, ascii, collision, controls, HUD) + T-0012 (Pages) → T-0010 (integration, C3) → T-0011 (e2e).
- 2026-08-24 00:10 — T-0001 accepted (ds-1, clean). Fan-out restarted after the staging incident; 6 instances on 9 claimable tickets.
- 2026-08-24 00:20 — T-0002 (ds-1) and T-0005 (grok-2) accepted first pass; both in-container check.sh green, all enumerated tests present. In flight: T-0003 ds-2, T-0004 grok-1, T-0006 opus-1, T-0007 opus-2, T-0008 ds-1, T-0009 grok-2.

## Next actions
1. Review T-0001 when it lands (check `scripts/*.sh` verbatim, playwright pin, lockfile) — accepting it releases the fan-out.
2. Review fan-out tickets oldest-first; verify tests listed in criteria exist by name.
3. After T-0010: run `npm run dev` on the host and look at it (claude-in-chrome or playwright screenshot) — compare with the reference screenshot; tune fog/palette/cell size via follow-up tickets.
4. Wave 2 backlog (draft after T-0010 review): CRT scanline/glow overlay, minimap, landmark name callout when facing a named building, touch controls, Westminster dataset option, start-position presets (`?at=stpauls`).
5. Tell the user to set Pages source = GitHub Actions once T-0012 merges.

## How to resume
1. Read this file.
2. `tigerteam status` (or `bash .tigerteam/scripts/board-status.sh`)
3. Process review/ first (`tigerteam accept` / `rework`), then blocked/ (`tigerteam answer`).
4. `git worktree list` — tigerteam/* entries are unmerged ticket branches.
5. Supervisor is normally already up in the cockpit; `tigerteam check` confirms. Re-arm `tigerteam events --wait` (exactly one for this root: `for p in $(pgrep -f 'tigerteam events --wait'); do readlink /proc/$p/cwd; done`).
6. Continue from Next actions.
