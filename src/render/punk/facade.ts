/**
 * Cyberpunk facade materials (wave 20b): dark weathered walls + bitumen roofs.
 * Decisions live in `facademath.ts`; this file is the TSL graph over them.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Facades" and
 * "Facades × OSM (wave 21)" (the `*Osm` variants read the `extra` attribute).
 */
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  attribute,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  min,
  normalize,
  normalView,
  positionView,
  positionWorld,
  select,
  smoothstep,
  step,
  uv,
  vec2,
  vec3,
  vertexColor,
} from 'three/tsl';
import { fbm2Node, hash2Node, vnoiseNode } from './noise';
import { rippleNormal, type WetUniforms } from './ripples';
import {
  decodeNormal,
  horizontalPbrNormal,
  makeWallSamplers,
  pbrAlbedoMul,
  samplePbr,
  uvPerturbNormal,
  wallSetUniform,
  type PbrSets,
} from './pbr';
import {
  ALBEDO_CHROMA,
  ALBEDO_MIN,
  ALBEDO_RANGE,
  ATLAS_CELL_PX,
  BLINDS_SHARE,
  BRICK_FADE_FAR_M,
  BRICK_FADE_NEAR_M,
  DARK_BUILDING_SHARE,
  DETAIL_FADE_FAR_M,
  DETAIL_FADE_NEAR_M,
  DARK_WINDOW_LIT_P,
  FLICKER_SHARE,
  FLOOR_BAND_DARKEN,
  FLOOR_BAND_M,
  FLOOR_BAND_WIDTH_M,
  FACADE_PATTERNS,
  GLASS_ALBEDO,
  GLASS_LIT_MAX,
  GLASS_LIT_MULT,
  GLASS_METALNESS,
  GLASS_ROUGHNESS,
  HASH_SALT_BLINDS,
  HASH_SALT_PBR_OU,
  HASH_SALT_PBR_OV,
  HASH_SALT_PBR_SWAP,
  HASH_SALT_DARK,
  HASH_SALT_FLICKER,
  HASH_SALT_INT,
  HASH_SALT_LIT,
  HASH_SALT_SHOP,
  HASH_SALT_SHOP_INT,
  HASH_SALT_SHOP_TINT,
  HASH_SALT_SHUTTER,
  HASH_SALT_TINT,
  INTENSITY_MIN,
  INTENSITY_RANGE,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  MAT_BRICK,
  MAT_GLASS,
  MAT_METAL,
  MAT_PLASTER,
  MAT_STONE,
  MAT_WOOD,
  MULLION_M,
  OSM_GRIME_KEEP,
  OSM_ROOF_NIGHT,
  OSM_WALL_NIGHT,
  PANEL_SEAM_M,
  PBR_FADE_FAR_M,
  PBR_FADE_NEAR_M,
  PBR_NORMAL_STRENGTH,
  PBR_ROOF_M,
  PBR_ROUGH_MIX,
  PBR_STONE_TINT,
  PBR_WALL_UV_SCALE,
  RIPPLE_SCALE,
  ROOF_ALBEDO_MIN,
  ROOF_ALBEDO_RANGE,
  ROOF_PUDDLE_FREQ,
  ROOF_PUDDLE_HI,
  ROOF_PUDDLE_LO,
  SEAM_BUMP,
  SHOP_EMISSIVE_MIN,
  SHOP_EMISSIVE_RANGE,
  SHOPFRONT_HEIGHT_M,
  SHOPFRONT_SEGMENT_M,
  SHOP_PIER_M,
  SHUTTER_ALBEDO_MIN,
  SHUTTER_ALBEDO_RANGE,
  SHUTTER_RIDGE_M,
  SHUTTER_SHARE,
  STREAK_DARKEN,
  STREAK_ROUGHNESS_DROP,
  STREAK_U_SCALE,
  STREAK_V_SCALE,
  TINT_THRESH,
  UV_TILE_M,
  WALL_METALNESS,
  WALL_ROUGHNESS,
  WINDOW_CELL_M,
  WINDOW_LIT_P,
  WINDOW_PX_X0,
  WINDOW_PX_X1,
  WINDOW_PX_Y0,
  WINDOW_PX_Y1,
  WINDOW_TINTS,
} from './facademath';

/**
 * The building materials, in the `[walls, roof]` group order of
 * `makeBuildingsObject`. `walls` / `roof` never read an attribute beyond
 * position / normal / uv / color; `wallsOsm` / `roofOsm` also read `extra`
 * and must only go on geometry that has it.
 */
export interface FacadeMaterials {
  walls: THREE.MeshStandardNodeMaterial;
  roof: THREE.MeshStandardNodeMaterial;
  wallsOsm: THREE.MeshStandardNodeMaterial;
  roofOsm: THREE.MeshStandardNodeMaterial;
}

const TUNGSTEN = vec3(WINDOW_TINTS[0][0], WINDOW_TINTS[0][1], WINDOW_TINTS[0][2]);
const FLUORO = vec3(WINDOW_TINTS[1][0], WINDOW_TINTS[1][1], WINDOW_TINTS[1][2]);
const CYAN = vec3(WINDOW_TINTS[2][0], WINDOW_TINTS[2][1], WINDOW_TINTS[2][2]);
const MAGENTA = vec3(WINDOW_TINTS[3][0], WINDOW_TINTS[3][1], WINDOW_TINTS[3][2]);
const GLASS = vec3(GLASS_ALBEDO, GLASS_ALBEDO, GLASS_ALBEDO);
const SHUTTER_TINT = vec3(1, 0.95, 0.88);
const MULLION = vec3(0.012, 0.011, 0.01);

/**
 * Build the facade materials. `windowTex` is the 64×64 window atlas
 * (`world/textures.ts`) or null for stone cities (Minas Tirith) — then no
 * windows or shopfronts, just the weathered material. With `pbr` (wave 23,
 * T-0167) the CC0 detail textures modulate albedo / roughness / normal;
 * without it the graphs are exactly the procedural ones.
 */
export function makeFacadeMaterials(windowTex: THREE.Texture | null, u: WetUniforms, pbr?: PbrSets): FacadeMaterials {
  const withWindows = windowTex !== null;
  return {
    walls: makeWalls(u, withWindows, false, pbr),
    roof: makeRoof(u, false, pbr),
    wallsOsm: makeWalls(u, withWindows, true, pbr),
    roofOsm: makeRoof(u, true, pbr),
  };
}

/** Texture detail weight: 1 → 0 over 15 → 60 m (mirror of `pbrFade`). */
function pbrFadeNode(): F {
  return float(1).sub(smoothstep(PBR_FADE_NEAR_M, PBR_FADE_FAR_M, length(positionView)));
}

/** Bitumen roof; with `osm`, an OSM roof colour (rgb ≥ 0) replaces the bitumen as `roofColor · 0.15`. */
function makeRoof(u: WetUniforms, osm: boolean, pbr?: PbrSets): THREE.MeshStandardNodeMaterial {
  const roof = new THREE.MeshStandardNodeMaterial();
  const xz = positionWorld.xz;
  const nRoof = vnoiseNode(xz.mul(0.4));
  const bitumen = float(ROOF_ALBEDO_MIN).add(nRoof.mul(ROOF_ALBEDO_RANGE));
  let dry: Node<'vec3'> = vec3(bitumen, bitumen, bitumen);
  if (osm) {
    const extra = attribute<'vec4'>('extra', 'vec4');
    dry = mix(dry, extra.xyz.mul(OSM_ROOF_NIGHT), step(0, extra.x));
  }
  const puddle = smoothstep(ROOF_PUDDLE_LO, ROOF_PUDDLE_HI, fbm2Node(xz.mul(ROOF_PUDDLE_FREQ)));
  roof.colorNode = mix(dry, vec3(0.02, 0.02, 0.022), puddle);
  roof.roughnessNode = mix(float(0.52), float(0.03), puddle);
  roof.metalnessNode = mix(float(0.15), float(0.9), puddle);
  const ripple = rippleNormal(u, RIPPLE_SCALE, mix(float(0.12), float(1.2), puddle));
  roof.normalNode = ripple;
  if (pbr) {
    // Concrete, 6 m per repeat on world xz (u = x, v = −z); fades under puddles.
    const c = pbr.concrete;
    const tex = samplePbr(c, vec2(xz.x, xz.y.negate()).div(PBR_ROOF_M));
    const dryAmt = c.ready.mul(puddle.oneMinus());
    roof.colorNode = mix(dry.mul(pbrAlbedoMul(tex.col, c.mean, pbrFadeNode().mul(c.ready))), vec3(0.02, 0.02, 0.022), puddle);
    roof.roughnessNode = mix(mix(float(0.52), tex.rough, c.ready.mul(PBR_ROUGH_MIX)), float(0.03), puddle);
    roof.normalNode = horizontalPbrNormal(ripple, tex.tn, pbrFadeNode().mul(dryAmt));
  }
  return roof;
}

/** Wall material; `osm` switches on the `extra`-driven colour and material patterns. */
function makeWalls(u: WetUniforms, withWindows: boolean, osm: boolean, pbr?: PbrSets): THREE.MeshStandardNodeMaterial {
  const walls = new THREE.MeshStandardNodeMaterial();
  const st = wallNodes(u, withWindows, osm);
  walls.colorNode = st.color;
  walls.roughnessNode = st.roughness;
  walls.metalnessNode = st.metalness;
  walls.emissiveNode = st.emissive;
  let baseN: Node<'vec3'> = normalView;
  if (pbr) {
    // Detail textures (§4.11 "PBR detail textures"): 4 m per repeat, per-building
    // offset (+ 0/90° swap for the isotropic sets), one set per fragment.
    const seed = st.seed;
    const uvB = uv().mul(PBR_WALL_UV_SCALE);
    // 1 when the swap roll < 0.5 (mirror of `pbrAntiTile`); arithmetic, no branch.
    const swap = float(1).sub(step(0.5, hash2Node(vec2(seed.mul(29), HASH_SALT_PBR_SWAP))));
    const off = vec2(hash2Node(vec2(seed.mul(31), HASH_SALT_PBR_OU)), hash2Node(vec2(seed.mul(37), HASH_SALT_PBR_OV)));
    const uvAniso = uvB.add(off);
    const uvIso = mix(uvB, uvB.yx, swap).add(off);
    const samplers = makeWallSamplers(pbr);
    const col = samplers.color(st.pbrIdx, uvIso, uvAniso);
    const rough = samplers.rough(st.pbrIdx, uvIso, uvAniso).x;
    const nt = samplers.normal(st.pbrIdx, uvIso, uvAniso);
    const on = wallSetUniform(pbr, st.pbrIdx, 'ready').mul(st.texMask);
    const amt = st.fade.mul(on);
    const tint = mix(vec3(1, 1, 1), st.tint, on);
    walls.colorNode = st.color.mul(pbrAlbedoMul(col, wallSetUniform(pbr, st.pbrIdx, 'mean'), amt)).mul(tint);
    walls.roughnessNode = mix(st.roughness, rough, on.mul(PBR_ROUGH_MIX));
    // Concrete / plaster (1 / 4) read the swapped uv: swap the tangent axes back.
    // Arithmetic (not `select`): a select here compiles to an if/else that
    // would nest the sampling branch and its derivatives.
    const isoF = step(abs(st.pbrIdx.sub(1)), float(0.5)).add(step(abs(st.pbrIdx.sub(4)), float(0.5)));
    const swapF = swap.mul(isoF);
    const tn = decodeNormal(nt);
    const txy = mix(tn.xy, tn.yx, swapF).mul(amt.mul(PBR_NORMAL_STRENGTH));
    baseN = uvPerturbNormal(txy, uvB);
  }
  // Screen-space bumpMap of a tall height graph fails to compile in time on
  // the WebGL2 fallback and races style restore; perturb the view normal instead
  // (architecture.md: "bumpMap on a height node or perturb normalNode").
  walls.normalNode = normalize(baseN.add(vec3(st.seam.mul(SEAM_BUMP), st.band.mul(0.2), st.ridge.mul(0.25))));
  return walls;
}

type F = Node<'float'>;

/** 1 on a joint line of width `width` (m) centred on multiples of `spacing` along `coordM`. */
function jointLine(coordM: F, spacing: number, width: number): F {
  const t = fract(coordM.div(spacing));
  return jointAt(t, spacing, width);
}

/** 1 on a joint of width `width` (m) at the edges of a unit whose fractional position is `t` and length `unit` (m). */
function jointAt(t: F, unit: number, width: number): F {
  const d = min(t, t.oneMinus()).mul(unit);
  return float(1).sub(smoothstep(width * 0.3, width * 0.5, d));
}

/** 1 when the `extra.w` material code equals `k`. */
function isMat(code: F, k: number): F {
  return float(1).sub(step(0.5, abs(code.sub(k))));
}

/**
 * Material-code pattern (architecture.md §4.11 "Facades × OSM"): albedo
 * multiplier, vertical / horizontal joint heights for the normal perturb, PBR,
 * and the glass curtain-wall mask / mullions.
 */
function osmPattern(code: F, uM: F, vM: F, seed: F, fade: F, fine: F, seamH: F) {
  const mBrick = isMat(code, MAT_BRICK);
  const mStone = isMat(code, MAT_STONE);
  const mGlass = isMat(code, MAT_GLASS);
  const mMetal = isMat(code, MAT_METAL);
  const mWood = isMat(code, MAT_WOOD);
  const mPlaster = isMat(code, MAT_PLASTER);
  const mPanels = float(1).sub(mBrick).sub(mStone).sub(mGlass).sub(mMetal).sub(mWood).sub(mPlaster);
  const P = FACADE_PATTERNS;

  // Brick: running-bond courses, half-brick offset every other course, recessed mortar.
  const bP = P[MAT_BRICK];
  const bRow = floor(vM.div(bP.size));
  const bX = uM.div(bP.unitLength).add(fract(bRow.mul(0.5)));
  const bH = jointAt(fract(vM.div(bP.size)), bP.size, bP.joint).mul(fine);
  const bV = jointAt(fract(bX), bP.unitLength, bP.joint).mul(fine);
  const bVar = hash2Node(vec2(floor(bX).add(seed.mul(31)), bRow)).sub(0.5).mul(2 * bP.variation).mul(fine).add(1);
  const brickMul = bVar.mul(float(1).sub(max(bH, bV).mul(0.35)));

  // Stone: ashlar blocks, half-block offset every other course.
  const sP = P[MAT_STONE];
  const sRow = floor(vM.div(sP.size));
  const sX = uM.div(sP.unitLength).add(fract(sRow.mul(0.5)));
  const sH = jointAt(fract(vM.div(sP.size)), sP.size, sP.joint).mul(fade);
  const sV = jointAt(fract(sX), sP.unitLength, sP.joint).mul(fade);
  const sVar = hash2Node(vec2(floor(sX).add(seed.mul(37)), sRow)).sub(0.5).mul(2 * sP.variation).add(1);
  const stoneMul = sVar.mul(float(1).sub(max(sH, sV).mul(0.3)));

  // Glass curtain wall: vertical mullions every 1.5 m, transoms on the 3 m floor lines.
  const gP = P[MAT_GLASS];
  const gV = jointLine(uM, gP.size, gP.joint).mul(fade);
  const gH = jointLine(vM, FLOOR_BAND_M, 0.1).mul(fade);
  const mullion = max(gV, gH);

  // Metal: 0.5 m vertical standing seams (raised, catch a little light).
  const mP = P[MAT_METAL];
  const mV = jointLine(uM, mP.size, mP.joint).mul(fade);
  const metalMul = mV.mul(0.25).add(1);

  // Wood: 0.2 m vertical boards, per-board tone, dark gaps.
  const wP = P[MAT_WOOD];
  const wIdx = floor(uM.div(wP.size));
  const wV = jointLine(uM, wP.size, wP.joint).mul(fine);
  const wVar = hash2Node(vec2(wIdx.add(seed.mul(43)), seed)).sub(0.5).mul(2 * wP.variation).add(1);
  const woodMul = wVar.mul(float(1).sub(wV.mul(0.5)));

  // Plaster: smooth, low-contrast broad stains.
  const pP = P[MAT_PLASTER];
  const stain = vnoiseNode(vec2(uM.mul(0.35), vM.mul(0.2)));
  const plasterMul = float(1).sub(stain.mul(pP.variation));

  const albedoMul = mBrick
    .mul(brickMul)
    .add(mStone.mul(stoneMul))
    .add(mMetal.mul(metalMul))
    .add(mWood.mul(woodMul))
    .add(mPlaster.mul(plasterMul))
    .add(mPanels.add(mGlass));
  const vLine = mPanels
    .mul(seamH)
    .add(mBrick.mul(bV))
    .add(mStone.mul(sV))
    .add(mGlass.mul(gV))
    .add(mMetal.mul(mV))
    .add(mWood.mul(wV));
  const hLine = mBrick.mul(bH).add(mStone.mul(sH)).add(mGlass.mul(gH));
  const byMat = (pick: (p: (typeof P)[number]) => number): F =>
    mPanels
      .mul(pick(P[0]))
      .add(mBrick.mul(pick(bP)))
      .add(mStone.mul(pick(sP)))
      .add(mGlass.mul(pick(gP)))
      .add(mMetal.mul(pick(mP)))
      .add(mWood.mul(pick(wP)))
      .add(mPlaster.mul(pick(pP)));
  return {
    mGlass,
    mullion,
    albedoMul,
    vLine,
    hLine,
    roughness: byMat((p) => p.roughness),
    metalness: byMat((p) => p.metalness),
    glassAlbedo: gP.albedo,
  };
}

/** Wall colour / PBR / bump / emissive for one fragment. */
function wallNodes(u: WetUniforms, withWindows: boolean, osm: boolean) {
  const uv2 = uv();
  const vc = vertexColor().rgb;
  const seed = hash2Node(vec2(vc.r.mul(97).add(vc.b.mul(13)), vc.g.mul(97).add(vc.b.mul(13))));
  const uM = uv2.x.mul(UV_TILE_M);
  const vM = uv2.y.mul(UV_TILE_M);

  const lum = vc.r.mul(LUMA_R).add(vc.g.mul(LUMA_G)).add(vc.b.mul(LUMA_B));
  const base = mix(vec3(lum, lum, lum), vc, ALBEDO_CHROMA).mul(float(ALBEDO_MIN).add(seed.mul(ALBEDO_RANGE)));

  const floorT = fract(vM.div(FLOOR_BAND_M));
  const distFloor = min(floorT, floorT.oneMinus()).mul(FLOOR_BAND_M);
  const bandH = float(1).sub(smoothstep(0, FLOOR_BAND_WIDTH_M / 2, distFloor));

  const seamT = fract(uM.div(PANEL_SEAM_M));
  const distSeam = min(seamT, seamT.oneMinus()).mul(PANEL_SEAM_M);
  // Fine detail (seams / mullions / blinds / ridges) fades with distance so it
  // never aliases into sub-pixel vertical stripes (PM GPU review).
  const fade = float(1).sub(smoothstep(DETAIL_FADE_NEAR_M, DETAIL_FADE_FAR_M, length(positionView)));
  const seamH = float(1).sub(smoothstep(0, 0.04, distSeam)).mul(fade);

  const streak = vnoiseNode(vec2(uv2.x.mul(STREAK_U_SCALE), uv2.y.mul(STREAK_V_SCALE)));
  const belowCornice = float(1).sub(smoothstep(0, 0.4, floorT));
  const streakAmt = streak.mul(mix(float(0.45), float(1), belowCornice));

  const grime = mix(float(1), float(1 - FLOOR_BAND_DARKEN), bandH).mul(float(1).sub(streakAmt.mul(STREAK_DARKEN)));
  let wallCol = base.mul(grime);
  let wallR = float(WALL_ROUGHNESS).sub(streakAmt.mul(STREAK_ROUGHNESS_DROP));
  let wallM: F = float(WALL_METALNESS);
  let vLine: F = seamH;
  let hBump: F = bandH;
  let glassR: F = float(GLASS_ROUGHNESS);
  let glassM: F = float(GLASS_METALNESS);
  let mGlass: F | null = null;
  let curtainMullion: F = float(0);
  let litMul: F = float(1);
  // PBR set branch index (`PBR_WALL_SETS`, mirror of `pbrWallIndex(pbrFacadeSet(code).set)`)
  // and albedo tint; only read when detail textures are on.
  let pbrIdx: F = float(1);
  let tint: Node<'vec3'> = vec3(1, 1, 1);
  if (osm) {
    const code = attribute<'vec4'>('extra', 'vec4').w;
    pbrIdx = float(1)
      .add(isMat(code, MAT_BRICK))
      .add(isMat(code, MAT_METAL).mul(2))
      .add(isMat(code, MAT_PLASTER).mul(3))
      .sub(isMat(code, MAT_GLASS).add(isMat(code, MAT_WOOD)));
    tint = mix(vec3(1, 1, 1), vec3(PBR_STONE_TINT[0], PBR_STONE_TINT[1], PBR_STONE_TINT[2]), isMat(code, MAT_STONE));
  }
  if (osm) {
    // Facades × OSM: rgb ≥ 0 → `osm · 0.18` night albedo with 25 % of the
    // procedural grime / bands on top; rgb < 0 → the procedural look above.
    const extra = attribute<'vec4'>('extra', 'vec4');
    const hasCol = step(0, extra.x);
    const keep = mix(float(1), float(OSM_GRIME_KEEP), hasCol);
    const fine = float(1).sub(smoothstep(BRICK_FADE_NEAR_M, BRICK_FADE_FAR_M, length(positionView)));
    const pat = osmPattern(extra.w, uM, vM, seed, fade, fine, seamH);
    const osmBase = mix(base, extra.xyz.mul(OSM_WALL_NIGHT), hasCol);
    const patCol = osmBase.mul(mix(float(1), grime, keep)).mul(pat.albedoMul);
    const curtain = mix(vec3(pat.glassAlbedo, pat.glassAlbedo, pat.glassAlbedo), MULLION, pat.mullion);
    wallCol = mix(patCol, curtain, pat.mGlass);
    wallR = pat.roughness.sub(streakAmt.mul(STREAK_ROUGHNESS_DROP).mul(keep).mul(pat.mGlass.oneMinus()));
    wallM = pat.metalness;
    vLine = pat.vLine;
    hBump = bandH.mul(keep).add(pat.hLine);
    glassR = mix(glassR, pat.roughness, pat.mGlass);
    glassM = mix(glassM, pat.metalness, pat.mGlass);
    mGlass = pat.mGlass;
    curtainMullion = pat.mullion;
    litMul = mix(float(1), float(GLASS_LIT_MULT), pat.mGlass);
  }

  const ridge = abs(fract(vM.div(SHUTTER_RIDGE_M)).sub(0.5)).mul(2).mul(fade);

  if (!withWindows) {
    return {
      color: wallCol,
      roughness: wallR,
      metalness: wallM,
      emissive: vec3(0, 0, 0),
      seam: vLine,
      band: hBump,
      ridge: float(0),
      seed,
      fade,
      pbrIdx,
      tint,
      texMask: float(1),
    };
  }

  const cell = floor(uv2.mul(ATLAS_CELL_PX));
  const cellU = cell.x;
  const cellV = cell.y;
  const f = fract(uv2.mul(ATLAS_CELL_PX));
  const inWinX = step(WINDOW_PX_X0 / ATLAS_CELL_PX, f.x).mul(float(1).sub(step(WINDOW_PX_X1 / ATLAS_CELL_PX, f.x)));
  const inWinY = step(WINDOW_PX_Y0 / ATLAS_CELL_PX, f.y).mul(float(1).sub(step(WINDOW_PX_Y1 / ATLAS_CELL_PX, f.y)));
  // Glass curtain wall: every pane between mullions is window.
  const inWindow = mGlass === null ? inWinX.mul(inWinY) : mix(inWinX.mul(inWinY), curtainMullion.oneMinus(), mGlass);

  const dark = hash2Node(vec2(seed, HASH_SALT_DARK)).lessThan(DARK_BUILDING_SHARE);
  const pLit0 = select(dark, float(DARK_WINDOW_LIT_P), float(WINDOW_LIT_P));
  // Offices (glass): lit ×1.5, capped at 0.3 (`windowLitP`).
  const pLit = osm ? min(pLit0.mul(litMul), GLASS_LIT_MAX) : pLit0;
  const hLit = hash2Node(vec2(cellU.add(seed.mul(17)), cellV.add(seed.mul(9)).add(HASH_SALT_LIT)));
  // cellV·3 ≥ 4 (same cut as windowLight): step is 1 on/above the shopfront.
  const aboveShopCell = step(SHOPFRONT_HEIGHT_M, cellV.mul(WINDOW_CELL_M));
  const litF = float(1).sub(step(pLit, hLit)).mul(aboveShopCell);

  const rInt = hash2Node(vec2(cellU.add(seed.mul(5)), cellV.add(HASH_SALT_INT)));
  const intensity = float(INTENSITY_MIN).add(float(INTENSITY_RANGE).mul(rInt).mul(rInt).mul(rInt));
  const rTint = hash2Node(vec2(cellU.add(seed.mul(2)), cellV.add(HASH_SALT_TINT)));
  const tintCol = select(
    rTint.lessThan(TINT_THRESH[0]),
    TUNGSTEN,
    select(rTint.lessThan(TINT_THRESH[1]), FLUORO, select(rTint.lessThan(TINT_THRESH[2]), CYAN, MAGENTA)),
  );
  const rBlinds = hash2Node(vec2(cellU.add(seed.mul(13)), cellV.add(HASH_SALT_BLINDS)));
  const hasBlinds = rBlinds.lessThan(BLINDS_SHARE);
  const wy = f.y.sub(WINDOW_PX_Y0 / ATLAS_CELL_PX).div((WINDOW_PX_Y1 - WINDOW_PX_Y0) / ATLAS_CELL_PX);
  const stripe = fract(wy.mul(3));
  const inStripe = step(0.38, stripe).mul(float(1).sub(step(0.62, stripe)));
  const blindsMask = select(hasBlinds, float(1).sub(inStripe.mul(0.88).mul(fade)), float(1));
  const rFlick = hash2Node(vec2(cellU.add(seed.mul(7)), cellV.add(HASH_SALT_FLICKER)));
  const flick = select(
    rFlick.lessThan(FLICKER_SHARE),
    fract(u.uTime.mul(rFlick.add(0.55)).mul(3.5)).step(0.14).oneMinus(),
    float(1),
  );
  const winEm = tintCol.mul(intensity).mul(blindsMask).mul(flick).mul(inWindow).mul(litF);

  const inShop = vM.lessThan(SHOPFRONT_HEIGHT_M);
  const segment = floor(uM.div(SHOPFRONT_SEGMENT_M));
  const isShutter = hash2Node(vec2(segment.add(seed.mul(8)), HASH_SALT_SHOP)).lessThan(SHUTTER_SHARE);
  const mullionT = fract(uM.div(MULLION_M));
  const mullionDist = min(mullionT, mullionT.oneMinus()).mul(MULLION_M);
  const mullion = select(mullionDist.lessThan(0.07), float(1), float(0)).mul(fade);
  // Shop glass lights only the middle 3.6 m of its segment; 1.2 m dark piers each side.
  const segX = uM.sub(segment.mul(SHOPFRONT_SEGMENT_M));
  const inSpan = step(SHOP_PIER_M, segX).mul(float(1).sub(step(SHOPFRONT_SEGMENT_M - SHOP_PIER_M, segX)));
  const rShopI = hash2Node(vec2(segment.add(seed.mul(3)), HASH_SALT_SHOP_INT));
  const shopI = float(SHOP_EMISSIVE_MIN).add(float(SHOP_EMISSIVE_RANGE).mul(rShopI));
  const rShopT = hash2Node(vec2(segment.add(seed.mul(4)), HASH_SALT_SHOP_TINT));
  const shopTint = select(rShopT.lessThan(0.5), TUNGSTEN, select(rShopT.lessThan(0.75), CYAN, MAGENTA));
  const shopEm = shopTint.mul(shopI).mul(mullion.oneMinus()).mul(inSpan);
  const rShutter = hash2Node(vec2(segment.add(seed.mul(6)), HASH_SALT_SHUTTER));
  const shutterCol = SHUTTER_TINT.mul(float(SHUTTER_ALBEDO_MIN).add(rShutter.mul(SHUTTER_ALBEDO_RANGE)));

  const shutterOn = select(inShop, select(isShutter, float(1), float(0)), float(0));

  const glassCol = mix(mix(wallCol, GLASS, inSpan), MULLION, mullion.mul(inSpan));
  const shopCol = select(isShutter, shutterCol, glassCol);
  const color = select(inShop, shopCol, mix(wallCol, GLASS, inWindow));
  const roughness = select(
    inShop,
    select(isShutter, float(0.38), mix(wallR, glassR, inSpan)),
    mix(wallR, glassR, inWindow),
  );
  const metalness = select(
    inShop,
    select(isShutter, float(0.72), mix(wallM, glassM, inSpan)),
    mix(wallM, glassM, inWindow),
  );
  // Shutters never emit.
  const emissive = select(inShop, select(isShutter, vec3(0, 0, 0), shopEm), winEm);

  // No panel seams across glass: they read as vertical stripes inside windows.
  const seam = vLine.mul(inWindow.oneMinus());
  // Detail textures: shutters are metal; glass (windows, lit shop span) is untextured.
  const texMask = select(inShop, select(isShutter, float(1), inSpan.oneMinus()), inWindow.oneMinus());
  return {
    color,
    roughness,
    metalness,
    emissive,
    seam,
    band: hBump,
    ridge: ridge.mul(shutterOn),
    seed,
    fade,
    pbrIdx: mix(pbrIdx, float(3), shutterOn),
    tint: mix(tint, vec3(1, 1, 1), shutterOn),
    texMask,
  };
}
