---
id: DRAFT
title: Spark spike — Gaussian-splat scene layer inside the low-res style target (assignee pm)
priority: P2
complexity: C3
depends_on: []
assignee: pm
scope: [package.json, package-lock.json, src/render/splats.ts, src/main.ts, docs/spikes/spark.md]
---

## Goal
Answer, with evidence, whether `@sparkjsdev/spark` (3D Gaussian splatting for
three.js, MIT, 2.2.0, peer three ≥ 0.180) can render splats INTO our
low-res scene target (`StyleRenderer.render` → `renderer.setRenderTarget(target)`)
so every existing style (ascii, lowpoly, …) applies on top, and what it
costs. Reference: the author's "Splat Doom" demo converts a Doom WAD to one
splat per texture texel plus 1.06 M sprite splats — procedural, not
captured; that is the route open to us (no city-scale captures exist).

## Context
- PM-only (package.json is PM-owned; the outcome is a decision, not a feature).
- Steps: `npm install @sparkjsdev/spark`; `src/render/splats.ts` builds a
  `SparkRenderer({ renderer })` + one `SplatMesh({ constructSplats })` that
  pushes ~200k splats sampled on the synthetic city's building walls
  (`buildBuildingsMesh` output, one splat per ~1 m² with the vertex colour),
  behind `?splats=1`; add it to the scene next to the meshes.
- Measure and record in `docs/spikes/spark.md`: (1) does the splat layer
  appear in the styled frame at all (target compatibility), (2) depth
  interaction with the opaque meshes (`depthTest` true / `depthWrite`
  false — the `edges`/`lowpoly` outline rules will not see splats),
  (3) fps at 640×360 on the RTX 3090 (`--use-angle=gl-egl`) and the
  SwiftShader path, (4) `vite build` size delta for GitHub Pages,
  (5) sort latency (`minSortIntervalMs`) when walking.
- Decision output: GO (→ C2 ticket "splatify buildings" + optional
  landmark captures) or NO-GO with the blocking finding.

## Acceptance criteria
- [ ] `bash scripts/check.sh` exits 0 with `?splats=1` off by default
      (existing e2e unchanged)
- [ ] `docs/spikes/spark.md` records measurements 1–5 and the decision
- [ ] Screenshot `e2e/__shots__/spark-spike.png` of `?synthetic=1&splats=1&render=ascii`
- [ ] No files changed outside scope

## Out of scope
- Any captured splat asset, LOD, dyno shader graphs, shipping the flag on.

## Worker report
