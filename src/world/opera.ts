/**
 * Synthesised Sydney Opera House sail shells (docs/architecture.md §4.22).
 * A spec-table module in the shape of `bridge.ts`: `OPERA_HOUSES[cityId]`
 * (sydney only) → `buildOperaHouse` (pure `MeshData`) →
 * `makeOperaObject` (three.js mesh, empty for every other city). The OSM
 * podium (T-0116) keeps supplying the base prism and the floating tag; this
 * module adds no anchor. Visual-only, no collision.
 */
import * as THREE from 'three';
import { FLAT_HEIGHT, type CityData, type HeightFn } from '../data/types';
import { project } from '../geo';
import { MeshBuilder, toGeometry, type MeshData, type UV, type Vec3 } from './mesh';

const UV_ZERO: UV = [0, 0];
/** Ridge samples per sail (apex to base arc). */
const NU = 8;
/** Half-count of base-arc samples per sail: total = 2*NV+1. */
const NV = 6;
/** Mouth wall inset toward the sphere centre (m). */
const MOUTH_INSET = 1;
/** Tip forward-lean, as a fraction of `sphereR`. */
const TIP_LEAN_FRAC = 0.35;
/** Back-sail half-width as a fraction of the group's landward main halfWidth. */
const BACK_HW_FRAC = 0.6;

/** One shell group on the podium (architecture.md §4.22). */
export interface OperaShellGroup {
  /** WGS84 `[lon, lat]` of the group's landward sail base. */
  base: [number, number];
  /** Direction the sails open toward (the harbour ≈ 23°). */
  bearingDeg: number;
  /** Ridge-tip heights above sea level, landward → seaward. */
  sails: number[];
  /** Per-sail half-width at the base (m). */
  halfWidths: number[];
  /** Consecutive sail bases along the axis (m). */
  spacing: number;
  /** Smaller sails leaning bearing + 180 at the landward end. */
  backSails?: number[];
}

/** Per-city Opera-House spec (architecture.md §4.22). */
export interface OperaHouseSpec {
  groups: OperaShellGroup[];
  /** Sail bases sit at this ASL height (m); ≈ the podium deck. */
  podiumASL: number;
  /** Every sail face is a patch of this same-radius sphere (m). */
  sphereR: number;
  /** Gloss white shell colour. */
  color: number;
  /** Dark recessed mouth-wall colour. */
  mouthColor: number;
}

/**
 * Per-city Opera-House table. Sydney only.
 *
 * As-built reconciliation against the shipped Sydney Opera House podium
 * (id 9596872, T-0116 refetch — polygon bbox x 316.9…452.0, z −552.3…−372.7):
 * the northmost end of the podium (small z) points into the harbour; the
 * three shell groups nest with bases spaced landward → seaward along
 * bearing 23°. The table values below place every sail base and base-arc
 * vertex inside the podium footprint expanded by 6 m (verified in
 * `tests/opera.test.ts`).
 *
 *  - Concert Hall (west): landward base ≈ (345, −430) — the podium's
 *    south-west quarter; three main sails at spacing 35 m end at (367.4,
 *    −494.5), 121 m short of the north tip. One backSail (tip 24 m ASL)
 *    leans landward.
 *  - Joan Sutherland (east): base ≈ (386.4, −412.4) — 45 m ENE of the
 *    Concert Hall base; three main sails at spacing 30 m; one backSail
 *    (20 m ASL) leans landward.
 *  - Bennelong Restaurant: a single 16 m ASL shell on the SE bulge at
 *    (425, −510).
 */
export const OPERA_HOUSES: Readonly<Record<string, OperaHouseSpec>> = {
  sydney: {
    groups: [
      {
        base: [151.21473, -33.85741],
        bearingDeg: 23,
        sails: [47, 58, 67],
        halfWidths: [22, 25, 28],
        spacing: 35,
        backSails: [24],
      },
      {
        base: [151.21518, -33.85757],
        bearingDeg: 23,
        sails: [40, 48, 54],
        halfWidths: [18, 21, 24],
        spacing: 30,
        backSails: [20],
      },
      {
        base: [151.21560, -33.85669],
        bearingDeg: 23,
        sails: [16],
        halfWidths: [14],
        spacing: 0,
      },
    ],
    podiumASL: 8,
    sphereR: 75,
    color: 0xf7f4ec,
    mouthColor: 0x2a2f36,
  },
};

/** Linear rgb of `hex` via `THREE.Color` (working colour space). */
function linearRgb(hex: number): Vec3 {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Slerp two unit direction vectors on the unit sphere. */
function slerpDir(a: Vec3, b: Vec3, t: number): Vec3 {
  const cosAng = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const ang = Math.acos(cosAng);
  const sinAng = Math.sin(ang);
  if (sinAng < 1e-6) return [a[0], a[1], a[2]];
  const wA = Math.sin((1 - t) * ang) / sinAng;
  const wB = Math.sin(t * ang) / sinAng;
  return [a[0] * wA + b[0] * wB, a[1] * wA + b[1] * wB, a[2] * wA + b[2] * wB];
}

/**
 * Sphere centre (F, e) for a sail with landward base at the origin, apex at
 * `(leanDist, rise)`, base half-width `halfWidth`, and sphere radius `R`.
 *
 * Solves the two-equation system that puts the two base corners
 * `(0, 0, ±halfWidth)` AND the apex `(leanDist, rise, 0)` on the sphere of
 * radius `R` centred at `(F, e, 0)`. `F < 0` (behind base) is the root
 * that makes the base arc bow forward. Returns `null` when the geometry is
 * infeasible (base + tip further apart than the sphere allows).
 */
function sphereCentre(
  leanDist: number,
  rise: number,
  halfWidth: number,
  R: number,
): { F: number; e: number } | null {
  const K = (leanDist * leanDist + rise * rise - halfWidth * halfWidth) / 2;
  const D = R * R - halfWidth * halfWidth;
  if (D <= 0) return null;
  const a = rise * rise + leanDist * leanDist;
  if (a < 1e-6) return null;
  const b = -2 * K * leanDist;
  const c = K * K - D * rise * rise;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const F = (-b - sq) / (2 * a); // the negative-F root
  const e = (K - leanDist * F) / rise;
  // Guard against numerical drift.
  if (!Number.isFinite(F) || !Number.isFinite(e)) return null;
  return { F, e };
}

/**
 * Emit one spherical-patch sail into `mesh`.
 *
 *  - `basePos`: sail-base anchor in world coords (mid of the base chord).
 *  - `bearingRad`: opening direction (radians).
 *  - `tipY`: apex y (world).
 *  - `halfWidth`: base half-width across the axis (m).
 *  - `R`: sphere radius (m).
 *
 * The sail's three boundaries — apex, left meridian, right meridian, and
 * the base arc — all lie exactly on a sphere of radius `R` centred at the
 * computed `C`. Emitted double-sided so the concave face reads from the
 * mouth side too. Adds a flat mouth-wall triangle in `mouthColor`, inset
 * `MOUTH_INSET` m along the mouth's outward normal.
 */
function appendSail(
  mesh: MeshBuilder,
  basePos: Vec3,
  bearingRad: number,
  tipY: number,
  halfWidth: number,
  R: number,
  color: Vec3,
  mouthColor: Vec3,
): void {
  const baseY = basePos[1];
  const rise = tipY - baseY;
  if (rise < 0.5 || halfWidth < 0.5) return;

  const fwdX = Math.sin(bearingRad);
  const fwdZ = -Math.cos(bearingRad);
  const acrossX = Math.cos(bearingRad);
  const acrossZ = Math.sin(bearingRad);

  const leanDist = Math.min(R * TIP_LEAN_FRAC, rise * 0.6);
  const cen = sphereCentre(leanDist, rise, halfWidth, R);
  if (cen === null) return;
  const { F, e } = cen;

  // Apex world.
  const apex: Vec3 = [
    basePos[0] + fwdX * leanDist,
    baseY + rise,
    basePos[2] + fwdZ * leanDist,
  ];
  // Sphere centre world.
  const C: Vec3 = [
    basePos[0] + fwdX * F,
    baseY + e,
    basePos[2] + fwdZ * F,
  ];
  // Left/right base corners (both on the sphere, at y = baseY).
  const leftBase: Vec3 = [
    basePos[0] - acrossX * halfWidth,
    baseY,
    basePos[2] - acrossZ * halfWidth,
  ];
  const rightBase: Vec3 = [
    basePos[0] + acrossX * halfWidth,
    baseY,
    basePos[2] + acrossZ * halfWidth,
  ];

  // Base arc: sphere ∩ horizontal plane y = baseY is a small circle
  // centred at (C.x, baseY, C.z) with radius r_pod.
  const r_pod = Math.sqrt(Math.max(0, R * R - e * e));
  // Angles of leftBase and rightBase around that horizontal circle,
  // measured relative to the +forward direction from (C.x, C.z) in the
  // world xz plane. F < 0 → the +forward direction from C points TOWARD
  // basePos; leftBase is at −across and rightBase at +across from basePos.
  const thetaSpan = Math.atan2(halfWidth, -F); // half-angle, > 0

  const apexDir: Vec3 = [(apex[0] - C[0]) / R, (apex[1] - C[1]) / R, (apex[2] - C[2]) / R];
  const baseAtDir = (v: number): Vec3 => {
    // v ∈ [-1, 1] → theta ∈ [-thetaSpan, +thetaSpan] around the horizontal
    // circle at y = baseY. The circle centre is at (C.x, baseY, C.z) with
    // radius r_pod; the direction from C to a circle point has horizontal
    // component r_pod·(cos θ · forward + sin θ · across) and vertical
    // component (baseY − C.y) = −e. Magnitude equals R by construction.
    const theta = v * thetaSpan;
    const rcos = r_pod * Math.cos(theta);
    const rsin = r_pod * Math.sin(theta);
    const dx = rcos * fwdX + rsin * acrossX;
    const dz = rcos * fwdZ + rsin * acrossZ;
    return [dx / R, -e / R, dz / R];
  };

  // Vertex grid: (NU + 1) × (2*NV + 1).
  const positions: Vec3[][] = [];
  const normals: Vec3[][] = [];
  for (let i = 0; i <= NU; i++) {
    const u = i / NU;
    const row: Vec3[] = [];
    const nrow: Vec3[] = [];
    for (let j = 0; j <= 2 * NV; j++) {
      const v = -1 + j / NV;
      const bDir = baseAtDir(v);
      const n = slerpDir(apexDir, bDir, u);
      const p: Vec3 = [C[0] + R * n[0], C[1] + R * n[1], C[2] + R * n[2]];
      row.push(p);
      nrow.push(n);
    }
    positions.push(row);
    normals.push(nrow);
  }

  // Emit quads (double-sided for visibility from the mouth side too).
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < 2 * NV; j++) {
      const a = positions[i]![j]!;
      const b = positions[i + 1]![j]!;
      const c = positions[i + 1]![j + 1]!;
      const d = positions[i]![j + 1]!;
      const na = normals[i]![j]!;
      // Outward face (normals pointing away from sphere centre).
      mesh.quad(a, b, c, d, na, UV_ZERO, UV_ZERO, UV_ZERO, UV_ZERO, color);
      const nInv: Vec3 = [-na[0], -na[1], -na[2]];
      mesh.quad(a, d, c, b, nInv, UV_ZERO, UV_ZERO, UV_ZERO, UV_ZERO, color);
    }
  }

  // Mouth wall: flat triangle leftBase → apex → rightBase, inset
  // MOUTH_INSET m toward the sphere centre (visually recessed behind the
  // shell edges). Emitted double-sided so it reads from either side.
  const centroidX = (leftBase[0] + rightBase[0] + apex[0]) / 3;
  const centroidY = (leftBase[1] + rightBase[1] + apex[1]) / 3;
  const centroidZ = (leftBase[2] + rightBase[2] + apex[2]) / 3;
  let insetX = C[0] - centroidX;
  let insetY = C[1] - centroidY;
  let insetZ = C[2] - centroidZ;
  const insetLen = Math.hypot(insetX, insetY, insetZ);
  if (insetLen > 1e-6) {
    insetX = (insetX / insetLen) * MOUTH_INSET;
    insetY = (insetY / insetLen) * MOUTH_INSET;
    insetZ = (insetZ / insetLen) * MOUTH_INSET;
  } else {
    insetX = 0;
    insetY = 0;
    insetZ = 0;
  }
  const lb: Vec3 = [leftBase[0] + insetX, leftBase[1] + insetY, leftBase[2] + insetZ];
  const rb: Vec3 = [rightBase[0] + insetX, rightBase[1] + insetY, rightBase[2] + insetZ];
  const ap: Vec3 = [apex[0] + insetX, apex[1] + insetY, apex[2] + insetZ];
  // Mouth-wall normal: perpendicular to the wall plane, facing bearing.
  const e1x = ap[0] - lb[0];
  const e1y = ap[1] - lb[1];
  const e1z = ap[2] - lb[2];
  const e2x = rb[0] - lb[0];
  const e2y = rb[1] - lb[1];
  const e2z = rb[2] - lb[2];
  let mnx = e1y * e2z - e1z * e2y;
  let mny = e1z * e2x - e1x * e2z;
  let mnz = e1x * e2y - e1y * e2x;
  const mnLen = Math.hypot(mnx, mny, mnz);
  if (mnLen > 1e-6) {
    mnx /= mnLen;
    mny /= mnLen;
    mnz /= mnLen;
    if (mnx * fwdX + mnz * fwdZ < 0) {
      mnx = -mnx;
      mny = -mny;
      mnz = -mnz;
    }
  }
  const mn: Vec3 = [mnx, mny, mnz];
  const mnInv: Vec3 = [-mnx, -mny, -mnz];
  mesh.triangle(lb, ap, rb, mn, UV_ZERO, UV_ZERO, UV_ZERO, mouthColor);
  mesh.triangle(lb, rb, ap, mnInv, UV_ZERO, UV_ZERO, UV_ZERO, mouthColor);
}

/** Emit every sail of `spec` into `mesh`. Groups are independent. */
function appendOperaHouse(mesh: MeshBuilder, spec: OperaHouseSpec, city: CityData): void {
  const datum = city.terrain?.datum ?? 0;
  const baseY = spec.podiumASL - datum;
  const color = linearRgb(spec.color);
  const mouth = linearRgb(spec.mouthColor);
  for (const g of spec.groups) {
    const [gx, gz] = project(g.base[0], g.base[1], city.origin);
    const bearingRad = (g.bearingDeg * Math.PI) / 180;
    const axisX = Math.sin(bearingRad);
    const axisZ = -Math.cos(bearingRad);
    // Main sails: landward → seaward.
    for (let i = 0; i < g.sails.length; i++) {
      const tipY = g.sails[i]! - datum;
      const hw = g.halfWidths[i] ?? g.halfWidths[g.halfWidths.length - 1] ?? 20;
      const bx = gx + axisX * g.spacing * i;
      const bz = gz + axisZ * g.spacing * i;
      appendSail(mesh, [bx, baseY, bz], bearingRad, tipY, hw, spec.sphereR, color, mouth);
    }
    // Back sails: at the same landward base, leaning bearing + 180°.
    if (g.backSails && g.backSails.length > 0) {
      const backHw = (g.halfWidths[0] ?? 20) * BACK_HW_FRAC;
      const backBearing = bearingRad + Math.PI;
      for (const tipASL of g.backSails) {
        const tipY = tipASL - datum;
        appendSail(mesh, [gx, baseY, gz], backBearing, tipY, backHw, spec.sphereR, color, mouth);
      }
    }
  }
}

/**
 * Build the Sydney Opera House sails' geometry as a triangle soup. Pure —
 * safe under vitest, does not touch `document` / `window`.
 */
export function buildOperaHouse(
  spec: OperaHouseSpec,
  city: CityData,
  _heightAt: HeightFn = FLAT_HEIGHT,
): MeshData {
  const mesh = new MeshBuilder();
  appendOperaHouse(mesh, spec, city);
  return mesh.build();
}

/**
 * Merge the spec for `cityId` (sydney only, empty otherwise) into one
 * Lambert mesh. Wired once in `main.ts` beside `makeBridgesObject`.
 */
export function makeOperaObject(
  cityId: string,
  city: CityData,
  _heightAt: HeightFn = FLAT_HEIGHT,
): THREE.Object3D {
  const spec = OPERA_HOUSES[cityId];
  if (!spec) return new THREE.Object3D();
  const mesh = new MeshBuilder();
  appendOperaHouse(mesh, spec, city);
  const geom = toGeometry(mesh.build());
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geom, mat);
}
