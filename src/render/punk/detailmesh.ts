/**
 * Cyberpunk facade-detail geometry (wave 20b, T-0154). Pure: MeshBuilder
 * only, no `three/webgpu`. Contract: docs/architecture.md §4.11
 * "`cyberpunk` v2" → "Facade detail geometry".
 */
import { FLAT_HEIGHT, type Building, type HeightFn, type Vec2 } from '../../data/types';
import { pointInPolygon } from '../../world/collision';
import { MeshBuilder, type MeshData, type UV, type Vec3 } from '../../world/mesh';
import { normalizeRing, ringHeights } from '../../world/buildings';

const UV0: UV = [0, 0];
const GREY_LO = 0.08;
const GREY_HI = 0.18;
const MIN_H = 6;
const MIN_EDGE = 4;
const LEDGE_MIN_H = 15;
const LEDGE_STEP = 12;
const LEDGE_THICK = 0.25;
const LEDGE_OUT = 0.35;
const WIN = 3;
/** Spec is ~1 / 45 m²; 45 blew the 150 k max (192 k). 90 m² sits at ~148 k. */
const AC_AREA = 90;
const AC_PROB = (WIN * WIN) / AC_AREA;
const AC_W = 0.9;
const AC_H = 0.6;
const AC_D = 0.5;
const AC_FLOOR_OFF = 0.4;
const AC_MAX_Y = 40;
const PIPE_MIN = 10;
const PIPE_TWO = 25;
const PIPE_S = 0.2;
const BALC_P = 0.3;
const BALC_STEP = 6;
const BALC_MAX = 30;
const BALC_W = 2.4;
const BALC_THICK = 0.15;
const BALC_D = 1.1;
const RAIL_S = 0.05;
const RAIL_Y = 1.0;
const ROOF_INSET = 2;
const TANK_R = 1.2;
const TANK_H = 2.5;
const ROOF_AC: Vec3 = [2, 1, 1.2];
const MAST_S = 0.1;
const MAST_H = 6;

/** Copy of `mulberry32` from `world/textures.ts` (do not import that file). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grey(rng: () => number): Vec3 {
  const g = GREY_LO + (GREY_HI - GREY_LO) * rng();
  return [g, g, g];
}

/**
 * Oriented box: `along` / `up` / `out` are unit axes, `sx/sy/sz` full size,
 * centre at `(cx,cy,cz)`. Six quads, outward normals.
 */
function emitBox(
  mesh: MeshBuilder,
  cx: number,
  cy: number,
  cz: number,
  ax: number,
  ay: number,
  az: number,
  ux: number,
  uy: number,
  uz: number,
  ox: number,
  oy: number,
  oz: number,
  sx: number,
  sy: number,
  sz: number,
  color: Vec3,
): void {
  const hx = sx * 0.5;
  const hy = sy * 0.5;
  const hz = sz * 0.5;
  const c = (i: number, j: number, k: number): Vec3 => [
    cx + ax * i * hx + ux * j * hy + ox * k * hz,
    cy + ay * i * hx + uy * j * hy + oy * k * hz,
    cz + az * i * hx + uz * j * hy + oz * k * hz,
  ];
  const p = (i: -1 | 1, j: -1 | 1, k: -1 | 1): Vec3 => c(i, j, k);
  mesh.quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), [ox, oy, oz], UV0, UV0, UV0, UV0, color);
  mesh.quad(p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1), [-ox, -oy, -oz], UV0, UV0, UV0, UV0, color);
  mesh.quad(p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), [ax, ay, az], UV0, UV0, UV0, UV0, color);
  mesh.quad(p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1), [-ax, -ay, -az], UV0, UV0, UV0, UV0, color);
  mesh.quad(p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), p(-1, 1, -1), [ux, uy, uz], UV0, UV0, UV0, UV0, color);
  mesh.quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), [-ux, -uy, -uz], UV0, UV0, UV0, UV0, color);
}

function emitOctagonPrism(
  mesh: MeshBuilder,
  cx: number,
  y0: number,
  cz: number,
  r: number,
  h: number,
  color: Vec3,
): void {
  const n = 8;
  const y1 = y0 + h;
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * Math.PI) / 4;
    pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    const nn: Vec3 = [dz / len, 0, -dx / len];
    mesh.quad(
      [a[0], y0, a[1]],
      [a[0], y1, a[1]],
      [b[0], y1, b[1]],
      [b[0], y0, b[1]],
      nn,
      UV0,
      UV0,
      UV0,
      UV0,
      color,
    );
  }
  const top: Vec3 = [0, 1, 0];
  const mid: Vec3 = [cx, y1, cz];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    mesh.triangle(mid, [a[0], y1, a[1]], [b[0], y1, b[1]], top, UV0, UV0, UV0, color);
  }
}

function ringBBox(ring: readonly Vec2[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, maxX, minZ, maxZ };
}

function cornersInside(ring: Vec2[], corners: readonly Vec2[]): boolean {
  for (const c of corners) {
    if (!pointInPolygon(c, ring)) return false;
  }
  return true;
}

function tryPlace(
  rng: () => number,
  ring: Vec2[],
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number },
  halfX: number,
  halfZ: number,
  octagon: boolean,
): Vec2 | null {
  const minX = bbox.minX + ROOF_INSET + halfX;
  const maxX = bbox.maxX - ROOF_INSET - halfX;
  const minZ = bbox.minZ + ROOF_INSET + halfZ;
  const maxZ = bbox.maxZ - ROOF_INSET - halfZ;
  if (maxX <= minX || maxZ <= minZ) return null;
  for (let t = 0; t < 12; t++) {
    const x = minX + rng() * (maxX - minX);
    const z = minZ + rng() * (maxZ - minZ);
    const ok = octagon
      ? octagonInside(ring, x, z, TANK_R)
      : cornersInside(ring, [
          [x - halfX, z - halfZ],
          [x + halfX, z - halfZ],
          [x + halfX, z + halfZ],
          [x - halfX, z + halfZ],
        ]);
    if (ok) return [x, z];
  }
  return null;
}

function octagonInside(ring: Vec2[], cx: number, cz: number, r: number): boolean {
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    if (!pointInPolygon([cx + r * Math.cos(a), cz + r * Math.sin(a)], ring)) return false;
  }
  return true;
}

function emitBuilding(mesh: MeshBuilder, building: Building, heightAt: HeightFn): void {
  if (building.h < MIN_H || building.poly.length < 3) return;
  const ring = normalizeRing(building.poly);
  let maxEdge = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > maxEdge) maxEdge = len;
  }
  if (maxEdge < MIN_EDGE) return;

  const { base, top } = ringHeights(ring, heightAt);
  const wallBase = base + (building.minH ?? 0);
  const roofY = top + building.h;
  const wallH = roofY - wallBase;
  if (wallH <= 0) return;

  const rng = mulberry32(building.id);
  const hasBalconies = rng() < BALC_P;
  const bbox = ringBBox(ring);

  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len === 0) continue;
    const inv = 1 / len;
    const ax = dx * inv;
    const az = dz * inv;
    const nx = dz * inv;
    const nz = -dx * inv;

    if (building.h >= LEDGE_MIN_H) {
      for (let ly = LEDGE_STEP; ly < wallH; ly += LEDGE_STEP) {
        const cx = (a[0] + b[0]) * 0.5 + nx * (LEDGE_OUT * 0.5);
        const cz = (a[1] + b[1]) * 0.5 + nz * (LEDGE_OUT * 0.5);
        emitBox(
          mesh,
          cx,
          wallBase + ly,
          cz,
          ax,
          0,
          az,
          0,
          1,
          0,
          nx,
          0,
          nz,
          len,
          LEDGE_THICK,
          LEDGE_OUT,
          grey(rng),
        );
      }
    }

    const acHalf = AC_W * 0.5;
    const acTop = Math.min(wallH, AC_MAX_Y);
    for (let s = WIN * 0.5; s <= len - acHalf; s += WIN) {
      for (let f = 0; ; f++) {
        const floorY = f * WIN;
        const centerY = floorY + AC_FLOOR_OFF;
        const topY = centerY + AC_H * 0.5;
        const botY = centerY - AC_H * 0.5;
        if (topY > acTop || topY > wallH) break;
        if (botY < 0) continue;
        if (rng() >= AC_PROB) continue;
        const cx = a[0] + ax * s + nx * (AC_D * 0.5);
        const cy = wallBase + centerY;
        const cz = a[1] + az * s + nz * (AC_D * 0.5);
        emitBox(mesh, cx, cy, cz, ax, 0, az, 0, 1, 0, nx, 0, nz, AC_W, AC_H, AC_D, grey(rng));
      }
    }

    if (len >= PIPE_MIN) {
      const nPipes = len >= PIPE_TWO ? 2 : 1;
      for (let p = 0; p < nPipes; p++) {
        const t = nPipes === 1 ? 0.25 : (p + 1) / (nPipes + 1);
        const s = t * len;
        const cx = a[0] + ax * s + nx * (PIPE_S * 0.5);
        const cz = a[1] + az * s + nz * (PIPE_S * 0.5);
        const cy = wallBase + wallH * 0.5;
        emitBox(mesh, cx, cy, cz, ax, 0, az, 0, 1, 0, nx, 0, nz, PIPE_S, wallH, PIPE_S, grey(rng));
      }
    }

    if (hasBalconies && len >= BALC_W) {
      const count = Math.floor(len / BALC_STEP);
      const halfW = BALC_W * 0.5;
      for (let k = 0; k < count; k++) {
        const s = (k + 0.5) * BALC_STEP;
        if (s < halfW || s > len - halfW) continue;
        for (let fy = BALC_STEP; fy < Math.min(wallH, BALC_MAX); fy += BALC_STEP) {
          const cx = a[0] + ax * s + nx * (BALC_D * 0.5);
          const cz = a[1] + az * s + nz * (BALC_D * 0.5);
          emitBox(
            mesh,
            cx,
            wallBase + fy,
            cz,
            ax,
            0,
            az,
            0,
            1,
            0,
            nx,
            0,
            nz,
            BALC_W,
            BALC_THICK,
            BALC_D,
            grey(rng),
          );
          const rx = a[0] + ax * s + nx * (BALC_D - RAIL_S * 0.5);
          const rz = a[1] + az * s + nz * (BALC_D - RAIL_S * 0.5);
          emitBox(
            mesh,
            rx,
            wallBase + fy + RAIL_Y,
            rz,
            ax,
            0,
            az,
            0,
            1,
            0,
            nx,
            0,
            nz,
            BALC_W,
            RAIL_S,
            RAIL_S,
            grey(rng),
          );
        }
      }
    }
  }

  const nItems = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < nItems; i++) {
    const kind = Math.floor(rng() * 3);
    if (kind === 0) {
      const at = tryPlace(rng, ring, bbox, TANK_R, TANK_R, true);
      if (!at) continue;
      emitOctagonPrism(mesh, at[0], roofY, at[1], TANK_R, TANK_H, grey(rng));
    } else if (kind === 1) {
      const hx = ROOF_AC[0]! * 0.5;
      const hz = ROOF_AC[2]! * 0.5;
      const at = tryPlace(rng, ring, bbox, hx, hz, false);
      if (!at) continue;
      emitBox(
        mesh,
        at[0],
        roofY + ROOF_AC[1]! * 0.5,
        at[1],
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        ROOF_AC[0]!,
        ROOF_AC[1]!,
        ROOF_AC[2]!,
        grey(rng),
      );
    } else {
      const h = MAST_S * 0.5;
      const at = tryPlace(rng, ring, bbox, h, h, false);
      if (!at) continue;
      emitBox(
        mesh,
        at[0],
        roofY + MAST_H * 0.5,
        at[1],
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        MAST_S,
        MAST_H,
        MAST_S,
        grey(rng),
      );
    }
  }
}

/**
 * Ledges, AC units, balconies, pipes and rooftop clutter for `buildings`,
 * seated like walls (`ringHeights` + `normalizeRing`).
 */
export function buildDetailMesh(
  buildings: readonly Building[],
  heightAt: HeightFn = FLAT_HEIGHT,
): MeshData {
  const mesh = new MeshBuilder();
  for (const b of buildings) emitBuilding(mesh, b, heightAt);
  return mesh.build();
}
