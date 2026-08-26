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
- 2026-08-24 — Look tuning done by the PM (C3 judgment) in a `pm/tune` worktree with a GPU screenshot loop, not by workers: glyph density from `max(r,g,b)` (hue-independent), gamma 0.45 (≈ linear→sRGB), exposure 1.7. Shader in architecture.md §4.8 is the contract again.
- 2026-08-24 — SwiftShader blanks render targets ≤ 64 rows; e2e keeps SwiftShader (assertions tolerate it) but visual review uses the RTX 3090 (`--use-angle=gl-egl`).

- 2026-08-26 — **Wave 5 = 3D.** User: "London is flat — do something 3D; central Kyiv." Interpretation: real terrain. Design locked by the PM (architecture.md §4.9/§4.10, data-format.md §Terrain): SRTM 1″ from the public AWS skadi mirror (`N50E030.hgt.gz`, 4.7 MB, verified reachable; Kyiv bbox spans 89–215 m ASL: Dnipro 94, Maidan 156, Lavra 191, Sophia 197) → `terrain` grid (step 20 m, heights relative to the origin `datum`) + `waterLevels` (10th-percentile of DEM at ring vertices; river-bed nodes flattened to it). Sampler and heightfield share one triangulation so draped geometry never floats. Every builder takes a `HeightFn` (default `FLAT_HEIGHT`) so London stays byte-identical. Bridges: straight deck between abutments, `max(lerp, terrain)`; `makeGroundAt = max(terrain, deck)` for player/buses/sky; boats ride the flattened river bed + 1 m.
- 2026-08-26 — Multi-city (user: "don't remove London, let the user choose on startup"): one JSON per city (`city.json` London unchanged, `kyiv.json` new, `--lang en` names), `src/data/cities.ts` registry, `?city=`, picker on the start overlay when `?city=` absent. Esc pause menu (user request): `COPY LINK TO HERE` (`?city=…&at=lon,lat,bearing`, pure `buildShareUrl`) + `SWITCH CITY`.
- 2026-08-26 — Kyiv pedestrian bridges are OSM footways → converter now keeps footways with `bridge≠no` as `pedestrian` + `bridge: true` (data-format.md road table).

## Board snapshot
- 2026-08-24 01:00 — **Wave 1+2 complete: 20/20 accepted.** Playable at `npm run dev`: real City of London data validates and loads, ASCII pass, HUD (6 rows), minimap, landmark row, CRT overlay, favicon, e2e smoke green in-container, GitHub Pages workflow on main. PM look-tuning merged (850ee7f): max-channel glyph density, gamma 0.45, exposure 1.7, brighter wall base, 3-px mipmapped floor grid. Verified on the RTX 3090 via `--use-angle=gl-egl`: 60 fps at 213×60 cells; screenshot in `docs/screenshot.png`.
- 2026-08-23 23:55 — wave 1 planned: T-0001 (P0 bootstrap) → T-0002…T-0009 fan-out (data, buildings, roads/ground, ascii, collision, controls, HUD) + T-0012 (Pages) → T-0010 (integration, C3) → T-0011 (e2e).
- 2026-08-24 00:10 — T-0001 accepted (ds-1, clean). Fan-out restarted after the staging incident; 6 instances on 9 claimable tickets.
- 2026-08-24 00:20 — T-0002 (ds-1) and T-0005 (grok-2) accepted first pass; both in-container check.sh green, all enumerated tests present. In flight: T-0003 ds-2, T-0004 grok-1, T-0006 opus-1, T-0007 opus-2, T-0008 ds-1, T-0009 grok-2.
- 2026-08-24 00:35 — T-0006 (opus-1), T-0007 (opus-2), T-0008 (ds-1) accepted first pass. Wave-2 note: Controls zeroes an axis when either key of the pair lifts (W held + S released ⇒ stop) — polish ticket later (track a held-key Set). In flight: T-0003, T-0004, T-0009, T-0012.
- 2026-08-24 00:55 — T-0012 (opus-1), T-0004 (grok-1), T-0003 (ds-2: 3118 buildings / 10307 roads / 43 places, 1.76 MB, real tower heights), T-0009 (grok-2) accepted first pass. 10/12 wave-1 tickets done; merged main gate green (80 unit tests). T-0013 (controls held-key polish) added and claimed by grok-2. T-0010 (integration, C3) now claimable.

- 2026-08-24 01:40 — 25/29 done. Wave 3 landed: minimap contrast, `?at=` presets + coordinates, Thames/dock water (data + render + collision), **Westminster dataset** (bbox −0.130…−0.070 / 51.497…51.521, origin still Bank, footways dropped: 9061 buildings / 7803 roads / 99 places / 31 water, 2.8 MB). User playtested and asked for a Big Ben start → T-0027 done, T-0028 (default spawn on Westminster Bridge @268°, verified visually via `?at=-0.12235,51.50085,268`: tower dead ahead) claimable; T-0025 touch, T-0026 landmark spawns, T-0029 landmark colours queued.

- 2026-08-24 02:20 — **29/30 done.** Big Ben default spawn (T-0028) + walkable bridges (T-0030: `Road.bridge` flag, `CollisionGrid` corridors override water) + touch controls (T-0025) + landmark colours (T-0029) merged. Verified on GPU: default `/` spawns mid-Westminster-Bridge at x≈−2331, ZONE WESTMINSTER BRIDGE, walking west works. Pushed to origin. Remaining: T-0026 (data-driven landmark spawns).

- 2026-08-24 02:45 — **30/30 done; board empty.** T-0026 data-driven landmark spawns merged (`?at=gherkin` → 70 m from 30 St Mary Axe facing it; verified on GPU). Wave-4 candidates (not queued, awaiting user): landmark spawn distance scaled by building height; tone down water saturation; bridge deck rendering/Tower Bridge; minimap zoom; day/night palette; sound; `?cell=` presets in the HUD help.

- 2026-08-24 04:20 — Wave 4 boarded after user discussion: T-0031 mobile HUD (P0: HUD was intercepting touches — 320px panel on a 390px phone; verified via touch-emulation harness that the joystick itself works), T-0032 idle joystick ring, T-0033 gloom mode (`G`/`?gloom=1` — Ctrl+0 is browser zoom so G chosen), T-0034 sun/moon/stars (`?time=`), T-0035 double-deckers, T-0036 Thames boats (rivers contract added to types.ts). main.ts chain serialised T-0031→33→34→35→36. Traffic is pass-through by user decision ("rideable later").

- 2026-08-24 15:05 — **Wave 4 complete: 38/38 accepted.** Landed since the last checkpoint: mobile HUD (click-through + compact) & idle joystick ring, theme system (G cycles cyber/gloom/solarized, hot cells keep the sun/moon/lit windows bright — user-driven two-pass contrast tuning), astronomically correct sun/moon/stars (`?time=`; one rework: sky must ride with the camera — spec bug), double-deckers on the road graph (visually verified via seeded ambush), Thames boats on OSM river centre-lines (verified from London Bridge). All gates green (257 unit tests + e2e).

- 2026-08-26 21:15 — **Wave 5 boarded (8 tickets, 38 done).** Contract commit be2e146, board 353d698. Graph: T-0039 dem.mjs (P0) · T-0041 validator+synthetic hills (P0) · T-0042 terrain.ts (P0) all claimable now → T-0040 pipeline + `kyiv.json` (needs 39, 41) · T-0043 drape builders (needs 42) → T-0044 traffic heights (needs 43) → T-0045 main.ts integration, `?city=`, Kyiv presets, ALT row, hills e2e (C3, needs 40/42/43/44) → T-0046 city picker + Esc pause menu + share link (needs 45). PM follow-ups after T-0045: GPU visual review from `?city=kyiv&at=maidan` / `hydropark` / `parkbridge`, look-tune the slope shade if hills read badly, then T-0046 review and push.

## Next actions
1. Wave 5 in flight — process digests (review/ then blocked/). After T-0045 lands: GPU screenshots of Kyiv (`?city=kyiv&at=maidan|hydropark|parkbridge|lavra`) before accepting; the slope shade (`0.6 + 0.5·n·L`) and fog (0.0018) are PM tuning knobs.
2. After T-0046: push main; the GitHub Pages deploy picks up `kyiv.json` (~5 MB) automatically. Later ideas: touch pause button (no Esc on phones), remember last city, bus pitch on slopes, Kyiv landmark colours table, more cities (bbox+origin+`--lang` are all CLI args).
2. User must set GitHub → Settings → Pages → Source: **GitHub Actions** for the deploy job to succeed (main pushed 2026-08-24).
3. PM visual harness: `node node_modules/.pm-shot.mjs <worktree> <out.png> ['?synthetic=1']` (copy lives in scratchpad `shot.mjs`); default args use the GPU (`--use-angle=gl-egl`). Never judge frames from SwiftShader at 60 rows (see architecture.md §8).
4. Later ideas: Westminster dataset option (bbox is a CLI arg), sound, day/night palette, `?cell=` presets in the HUD help.

## How to resume
1. Read this file.
2. `tigerteam status` (or `bash .tigerteam/scripts/board-status.sh`)
3. Process review/ first (`tigerteam accept` / `rework`), then blocked/ (`tigerteam answer`).
4. `git worktree list` — tigerteam/* entries are unmerged ticket branches.
5. Supervisor is normally already up in the cockpit; `tigerteam check` confirms. Re-arm `tigerteam events --wait` (exactly one for this root: `for p in $(pgrep -f 'tigerteam events --wait'); do readlink /proc/$p/cwd; done`).
6. Continue from Next actions.
