# AsciiCity — tigerteam retrospective

PM retro, written 2026-08-31 for tigerteam feedback collection. Covers the full
run: 2026-08-23 → 2026-08-31, waves 1–13a, **109/109 tickets accepted**, board
empty at time of writing.

## What was built

A static browser minigame: first-person walking (and flying) through real
cities rendered as coloured ASCII glyphs, from a cold Vite+TS+three.js
bootstrap to a deployed GitHub Pages site in nine calendar days. Final scope:

- **Five streamed cities** — London/Westminster, Kyiv, San Francisco,
  Manhattan, Tokyo — all on the wave-11 tile pipeline (1 km tiles, TileManager
  hysteresis, ≤ 1 build/frame), fed by OSM/Overpass + SRTM DEMs with a
  bare-earth filter (wave 13a) for radar-surface contamination.
- **13 render styles** (ascii/gloom/solarized/amber, braille, blocks, teletext,
  dither, gameboy, pico8, edges, hatch, matrix with an embedded katakana
  Unifont atlas), per-city defaults (Tokyo boots matrix).
- Real terrain with draped geometry, water flattening, walkable bridges with
  synthesized structure (GGB towers/cables/deck box, Brooklyn/Manhattan bridge
  humps), building parts (ESB/One WTC setbacks), curated landmark
  heights/shapes/tags, trees, buses, cars, Bay ships with night lights.
- Product chrome: HUD/minimap/settings shell, fast travel, city picker, pause
  menu with share links, touch controls, postcard PNG/GIF export, OG image,
  loading indicator, pointer-lock resilience, analytics, CI + Pages deploys.

## The numbers

- **109 tickets, 159 attempts, ~33 h worker wall time, $135.54 engine-reported**
  (49 early attempts, waves 1–3, predate usage capture — real total is higher).
- Fleet: `ds` ×2 (DeepSeek V4 Flash via pi, C2), `grok` ×2 (C3), `opus` ×2
  (login-auth claude, C3, weekly-quota priced for the user). GLM parked all
  run (only GLM-5.2 available; user vetoed).
- **Cost split is the headline**: opus lanes = **$118 of $135 (87 %)** across
  33 attempts; grok + DeepSeek together ≈ **$17 for 126 attempts**, including
  most C3s. Measured repeatedly: opus is 10–30× grok's price for equal C2/C3
  quality on this codebase. Every ticket > $4 was an opus attempt
  (T-0087 Manhattan dataset $13.71, T-0045 Kyiv integration $11.05, …), while
  the entire wave-9 C3 pair (GGB structure + ships) cost $1.43 on grok.
  Mitigation that worked: pin C3s `assignee: grok`, pin C1s `assignee: ds`;
  the user kept opus anyway because quota pricing made it free-ish to them.
- First-pass acceptance was the norm; roughly one rework per wave. Outliers:
  T-0057 hatch (7 attempts), T-0059 spawn corridor (3), T-0098 Tokyo vantages
  (5 attempts, $11.88 — the one expensive rework), T-0076 SF dataset
  (4 attempts / 2 legitimate blocked rounds / $0.29 total — DeepSeek at its
  best).

## What worked

1. **Contracts before tickets.** Locking design into numbered
   `architecture.md` §4.x / `data-format.md` sections and committing them
   *before* boarding converted almost everything to C2. Cheap models executed
   shader math, coastline topology, and bridge geometry reliably when the
   algorithm was written down; the moment judgment leaked into a ticket, cost
   and attempts spiked.
2. **Workers flagging contradictions instead of guessing.** This paid off
   constantly, and the flags were usually *right*: the 5×5-circle geometry
   contradiction in §4.19 (grok), PROTOCOL §6 correctly cited against my own
   bad answer text (opus), a false "already exported" claim in a ticket
   (opus), the mechanical proof that my requested Skytree vantage band had
   zero clean sightlines (opus), the proof that raw SRTM near Shibuya has no
   bare-earth sample at all (forcing a wider filter). Treating a flag as
   "the frozen protocol and landed code outrank my ticket text" was correct
   every single time.
3. **PM GPU visual review as a distinct gate.** Green tests lie about looks
   and about geometry. The screenshot probe loop (scripts kept under a
   worktree's `node_modules/` so playwright resolves) caught every bug the
   gates could not: fragmented bridge-deck lerp, per-piece road ribbons, flat
   deck-box tops, a 634 m tower rendered as a featureless red wall, matrix
   rain rising, sky mush, boot toast in the OG image. Rule that emerged:
   *every* contract-first look gets one GPU frame before its spec is trusted,
   and "when a surface is missing in a frame, probe geometry numerically per
   along-position" before blaming the renderer.
4. **Mechanical acceptance criteria beat aesthetic ones.** Point-clearance
   spawn rules failed twice; a view-corridor test (`blocked(pt+k·forward)`
   for k=4…40 m) worked. Zone-text e2e got criteria-shaped by a worker;
   sightline ray tests didn't. "Edges look right" failed; "< 15 % edge pixels
   on the synthetic city" worked. Terrain "≤ 30 m absolute" fought real
   relief; "adjacent deltas ≤ 3 m" was the true gate. Writing the criterion
   as a number a worker can compute is most of the PM job.
5. **Blocked questions as the highest-priority interrupt.** The T-0076 chain
   (coastline stitch bug → size guard) is the model case: two legitimate
   blocks, two same-hour answers with locked rules, and a 4-attempt dataset
   ticket still cost $0.29. A wrong guess in either spot would have been a
   rework cycle on a 57-minute fetch pipeline.
6. **Strike-free requeue on infrastructure death.** Host restart (exit 143),
   OOM kills (exit 137), and lane fast-fail auto-STOP all recovered cleanly;
   workers resumed their own half-done branches. This is the wrapper earning
   its keep.
7. **PM-owned aesthetic tuning in a `pm/tune` worktree** (glyph density
   curve, gamma/exposure, canopy colours, matrix contrast, fog experiments)
   — C3 judgment work that would have burned worker cycles on taste, done
   with a screenshot loop instead.

## What went wrong (incidents)

1. **Staging mode broke on the very first accept** (day 1): board commit
   lands on main while the merge lands on staging, so `--ff-only` can never
   advance main — *and* worker worktrees cut from HEAD=main missed T-0001's
   files entirely. Killed six attempts, merged by hand, ran single-branch for
   the rest of the project with the PM verifying every landing in-container
   before accept. This cost the fleet's whole first fan-out.
2. **Board-before-commit race**: workers claim within ~15 s, faster than
   proofreading. Boarded tickets before committing the scaffold once; never
   again. (Now a standing process rule: commit contracts + board, then move
   tickets into todo/.)
3. **Gate concurrency flakiness**: two in-container `check.sh` runs at once
   starve the SwiftShader e2e ("moved ≥ 0.5 m" fails); under fleet load
   *every* container e2e is suspect. Worst moment: three accepts chained
   after unread gate lines merged three tickets whose gates all said
   `e2e: FAIL` (all turned out to be starvation flakes, but that was luck).
   Rules that stuck: gates one at a time, never chain `accept` after a gate
   in one command, merged-main gate on the idle HOST, never run PM GPU probes
   during a host gate. Counter-lesson from T-0091: "passes in container,
   fails on host" can also be a *real* timing bug — replay with
   instrumentation before calling it flaky.
4. **Accept-cleanup aborts on root-owned container artifacts** (T-0102,
   T-0108, same failure twice): a container leaves a root-owned dir inside
   the worktree → `git worktree remove` dies mid-ritual *after* the merge
   landed, leaving board moves uncommitted. Recovery recipe exists (docker rm
   the dir, prune, hand-move ticket, commit) but it happened twice, the
   second time from the PM's own in-container gate run after the pre-check.
5. **Event delivery wobbles**: one armed `events --wait` silently missed a
   landing (supervisor nudge caught it); idle waiter processes get reaped by
   the harness; orphan waiters accumulated twice and had to be pgrep-killed.
   Ended the project relying on supervisor nudges rather than a standing
   waiter.
6. **Strike counter parked finished work** (T-0098): a complete attempt wrote
   `handoff: review`, then two idle re-claims exited 0 with no handoff
   (nothing left to do) and the counter struck the ticket into blocked/
   "(failed attempts)". `rework` refuses non-review lanes, so recovery was a
   manual note + `mv` + commit.
7. **Merge-conflict resolution slips**: two accept conflicts in main.ts/e2e;
   one bad resolution passed through a `&&`/`;` chain that swallowed the
   failure and was only caught by tsc post-commit. Rule: resolve → `tsc` →
   commit, and never let command chains hide a failing step.
8. **PM spec coordinates were the top bug source in the data waves.** GGB
   towers placed from memory (both wrong), `dumbo` facing a warehouse wall,
   `empirestate` inside a footprint — three misses in one week. Fix: verify
   every hand-written coordinate against road vertices / OSM before it enters
   a ticket, or better, make the ticket derive it from data with a mechanical
   test.
9. **Local-green ≠ CI-green**: the tile migration made tests fs-read 69
   files per reconstruction — fine on a 32-core host, 9.9 s on a shared
   runner, blowing vitest's 5 s default and silently killing the Pages
   deploy. Also learned: pushing a STATE commit while a Pages run is in
   flight cancels the run (concurrency group).

## Feedback for the tigerteam wrapper

- **Staging mode** needs the day-1 divergence fixed (board commit vs merge
  branch split) or a loud warning at init; it's currently a trap for exactly
  the boards it's designed for.
- **Accept should pre-check worktree file ownership** (`find <wt> ! -user
  <uid>`) and either chown/docker-clean itself or refuse *before* merging —
  aborting after the merge with uncommitted board moves is the worst spot to
  stop, and it happened twice.
- **The strike counter should not count no-op re-claims** (exit 0, no
  commits, no handoff, nothing to do) — it buried an accepted-quality landing.
  Related: `rework`/`answer` should work on (or offer to recover) a ticket in
  any lane, not just review/blocked.
- **Event feed**: a missed landing under an armed waiter and harness-reaped
  idle waiters both argue for the push-digest posture as default (it was the
  fix here). Multiple-waiter detection could be wrapper-side rather than a PM
  pgrep ritual.
- **Verification under load**: the wrapper could serialize container gates or
  flag "gate ran with N workers live" on the report — three unverified merges
  happened because a human chained commands past a load-flaked gate.
- **Accounting** was excellent once present (per-attempt ledger, `cost`,
  digest usage lines drove the fleet-routing decisions above); the 49
  early no-usage attempts suggest capture should fail loudly at `check` time.
  A `--sort cost` on `tigerteam cost --by ticket` would save a shell sort.
- Things that quietly worked and should not change: strike-free requeue on
  SIGKILL/143/137, per-ticket worktrees dying with their mess, `tigerteam gh`
  covering a host without the gh CLI, `tigerteam log` transcripts for
  post-mortems, hot-reloaded config, lane auto-STOP on fast-fail.

## Verdict

The PM/worker split held at scale: 109 tickets, five cities, thirteen
renderers, ~$135 of engine spend (plus quota-priced opus), and the expensive
model wrote roughly none of the shipped code after wave 1. The economics thesis
is confirmed with a sharp edge: **cheap-model workers are fully adequate once
the contract is mechanical** — the residual cost drivers were (a) opus on
tickets any lane could do, and (b) reworks whose root cause was the PM's own
contract, not the worker. Most of what I'd do differently is captured above as
process rules that now exist because we hit them; the wrapper feedback list is
short precisely because the mechanics mostly disappeared from view — which is
the point.
