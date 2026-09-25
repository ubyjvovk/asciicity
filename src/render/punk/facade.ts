/**
 * Cyberpunk facade materials (wave 20b): dark weathered walls + bitumen roofs.
 * Decisions live in `facademath.ts`; this file is the TSL graph over them.
 * Contract: docs/architecture.md §4.11 "cyberpunk v2" → "Facades".
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  float,
  floor,
  fract,
  length,
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
  ALBEDO_CHROMA,
  ALBEDO_MIN,
  ALBEDO_RANGE,
  ATLAS_CELL_PX,
  BLINDS_SHARE,
  DARK_BUILDING_SHARE,
  DETAIL_FADE_FAR_M,
  DETAIL_FADE_NEAR_M,
  DARK_WINDOW_LIT_P,
  FLICKER_SHARE,
  FLOOR_BAND_DARKEN,
  FLOOR_BAND_M,
  FLOOR_BAND_WIDTH_M,
  GLASS_ALBEDO,
  GLASS_METALNESS,
  GLASS_ROUGHNESS,
  HASH_SALT_BLINDS,
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
  MULLION_M,
  PANEL_SEAM_M,
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

/** The two building materials, in the `[walls, roof]` group order of `makeBuildingsObject`. */
export interface FacadeMaterials {
  walls: THREE.MeshStandardNodeMaterial;
  roof: THREE.MeshStandardNodeMaterial;
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
 * windows or shopfronts, just the weathered material.
 */
export function makeFacadeMaterials(windowTex: THREE.Texture | null, u: WetUniforms): FacadeMaterials {
  const roof = new THREE.MeshStandardNodeMaterial();
  const xz = positionWorld.xz;
  const nRoof = vnoiseNode(xz.mul(0.4));
  const bitumen = float(ROOF_ALBEDO_MIN).add(nRoof.mul(ROOF_ALBEDO_RANGE));
  const puddle = smoothstep(ROOF_PUDDLE_LO, ROOF_PUDDLE_HI, fbm2Node(xz.mul(ROOF_PUDDLE_FREQ)));
  roof.colorNode = mix(vec3(bitumen, bitumen, bitumen), vec3(0.02, 0.02, 0.022), puddle);
  roof.roughnessNode = mix(float(0.52), float(0.03), puddle);
  roof.metalnessNode = mix(float(0.15), float(0.9), puddle);
  roof.normalNode = rippleNormal(u, RIPPLE_SCALE, mix(float(0.12), float(1.2), puddle));

  const walls = new THREE.MeshStandardNodeMaterial();
  const st = wallNodes(u, windowTex !== null);
  walls.colorNode = st.color;
  walls.roughnessNode = st.roughness;
  walls.metalnessNode = st.metalness;
  walls.emissiveNode = st.emissive;
  // Screen-space bumpMap of a tall height graph fails to compile in time on
  // the WebGL2 fallback and races style restore; perturb the view normal instead
  // (architecture.md: "bumpMap on a height node or perturb normalNode").
  walls.normalNode = normalize(normalView.add(vec3(st.seam.mul(SEAM_BUMP), st.band.mul(0.2), st.ridge.mul(0.25))));
  return { walls, roof };
}

/** Wall colour / PBR / bump / emissive for one fragment. */
function wallNodes(u: WetUniforms, withWindows: boolean) {
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

  const wallCol = base.mul(mix(float(1), float(1 - FLOOR_BAND_DARKEN), bandH)).mul(float(1).sub(streakAmt.mul(STREAK_DARKEN)));
  const wallR = float(WALL_ROUGHNESS).sub(streakAmt.mul(STREAK_ROUGHNESS_DROP));

  const ridge = abs(fract(vM.div(SHUTTER_RIDGE_M)).sub(0.5)).mul(2).mul(fade);

  if (!withWindows) {
    return {
      color: wallCol,
      roughness: wallR,
      metalness: float(WALL_METALNESS),
      emissive: vec3(0, 0, 0),
      seam: seamH,
      band: bandH,
      ridge: float(0),
    };
  }

  const cell = floor(uv2.mul(ATLAS_CELL_PX));
  const cellU = cell.x;
  const cellV = cell.y;
  const f = fract(uv2.mul(ATLAS_CELL_PX));
  const inWinX = step(WINDOW_PX_X0 / ATLAS_CELL_PX, f.x).mul(float(1).sub(step(WINDOW_PX_X1 / ATLAS_CELL_PX, f.x)));
  const inWinY = step(WINDOW_PX_Y0 / ATLAS_CELL_PX, f.y).mul(float(1).sub(step(WINDOW_PX_Y1 / ATLAS_CELL_PX, f.y)));
  const inWindow = inWinX.mul(inWinY);

  const dark = hash2Node(vec2(seed, HASH_SALT_DARK)).lessThan(DARK_BUILDING_SHARE);
  const pLit = select(dark, float(DARK_WINDOW_LIT_P), float(WINDOW_LIT_P));
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
    select(isShutter, float(0.38), mix(wallR, float(GLASS_ROUGHNESS), inSpan)),
    mix(wallR, float(GLASS_ROUGHNESS), inWindow),
  );
  const metalness = select(
    inShop,
    select(isShutter, float(0.72), mix(float(WALL_METALNESS), float(GLASS_METALNESS), inSpan)),
    mix(float(WALL_METALNESS), float(GLASS_METALNESS), inWindow),
  );
  // Shutters never emit.
  const emissive = select(inShop, select(isShutter, vec3(0, 0, 0), shopEm), winEm);

  // No panel seams across glass: they read as vertical stripes inside windows.
  const seam = seamH.mul(inWindow.oneMinus());
  return { color, roughness, metalness, emissive, seam, band: bandH, ridge: ridge.mul(shutterOn) };
}
