/**
 * Houses, Citadel landmarks and trees for the Minas Tirith generator
 * (architecture.md §4.23 "Houses" and "Citadel and landmarks").
 *
 * Pure: no fs, no tiling. `scripts/gen-minas-tirith.mjs` imports these in
 * `buildCity`. Lane / prow / gate skip rules match T-0126's geometry.
 */

const DEG = Math.PI / 180;
const RAMP = 25;
const RING_INSET = 14;
const HOUSE_GAP = 3;
const LANE_CLEAR = 6;
const GATE_CLEAR_DEG = 10;
const PROW_PAD = 10;
const PROW_INNER_W = 24;
const PROW_OUTER_W = 8;
const LANE_AZ = Object.freeze([22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5]);
const HOUSE_COLORS = Object.freeze([0xd8d4c8, 0xcfcbc0, 0xe2ded2, 0xbfbab0]);
const COLOR_CITADEL = 0xf2efe6;
const COLOR_RATH = 0xb8b4aa;
const COLOR_GUEST = 0xcfc3a8;

/** Round a local-metre value to 0.1 m. */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Point at radius `r` and azimuth `deg` (clockwise from north).
 * @param {number} r metres
 * @param {number} deg degrees
 * @returns {[number, number]}
 */
function atAz(r, deg) {
  const a = deg * DEG;
  return [round1(r * Math.sin(a)), round1(-r * Math.cos(a))];
}

/** Azimuth in degrees clockwise from north, in [0, 360). */
function azimuthOf(x, z) {
  let d = Math.atan2(x, -z) / DEG;
  if (d < 0) d += 360;
  return d;
}

/** Shortest absolute angular distance in degrees, in [0, 180]. */
function angDist(a, b) {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/**
 * Rectangle centred at `(cx, cz)`, `halfDepth` along unit radial `ur`,
 * `halfWidth` along unit tangent `ut`.
 * @param {number} cx
 * @param {number} cz
 * @param {[number, number]} ur
 * @param {[number, number]} ut
 * @param {number} halfDepth
 * @param {number} halfWidth
 * @returns {Array<[number, number]>}
 */
function orientedRect(cx, cz, ur, ut, halfDepth, halfWidth) {
  const corners = [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
  ];
  return corners.map(([a, b]) => [
    round1(cx + a * halfDepth * ur[0] + b * halfWidth * ut[0]),
    round1(cz + a * halfDepth * ur[1] + b * halfWidth * ut[1]),
  ]);
}

/**
 * Axis-aligned rectangle centred at `(cx, cz)` of size `sx` (east) × `sz` (south).
 * @param {number} cx
 * @param {number} cz
 * @param {number} sx
 * @param {number} sz
 * @returns {Array<[number, number]>}
 */
function axisRect(cx, cz, sx, sz) {
  const hx = sx / 2;
  const hz = sz / 2;
  return [
    [round1(cx + hx), round1(cz + hz)],
    [round1(cx + hx), round1(cz - hz)],
    [round1(cx - hx), round1(cz - hz)],
    [round1(cx - hx), round1(cz + hz)],
  ];
}

/** Vertex-mean centroid of a ring. */
function centroid(poly) {
  let sx = 0;
  let sz = 0;
  for (const [x, z] of poly) {
    sx += x;
    sz += z;
  }
  const n = poly.length;
  return [sx / n, sz / n];
}

/** Axis-aligned bounding box of a ring. */
function aabb(poly) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of poly) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** True when two AABBs overlap in interior (touching edges is allowed). */
function aabbOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

/**
 * Prow half-width in metres: 24 m at `R_7` down to 8 m at `R_2`.
 * @param {number} r
 * @param {number} r7
 * @param {number} r2
 */
function prowHalfWidth(r, r7, r2) {
  const t = (r - r7) / (r2 - r7);
  return PROW_INNER_W + t * (PROW_OUTER_W - PROW_INNER_W);
}

/**
 * Radial lane segments on tiers 1–6 (same geometry as `buildRoads` in T-0126).
 * @param {ReadonlyArray<{r: number}>} tiers
 * @returns {Array<{a: [number, number], b: [number, number]}>}
 */
function laneSegments(tiers) {
  const lanes = [];
  for (let t = 0; t < 6; t++) {
    const rOuter = tiers[t].r - RING_INSET;
    const rInner = tiers[t + 1].r + 30;
    for (const az of LANE_AZ) {
      if (t >= 1) {
        const d = Math.abs(((((az - 90) % 360) + 540) % 360) - 180);
        if (d <= 12) continue;
      }
      lanes.push({ a: atAz(rOuter, az), b: atAz(rInner, az) });
    }
  }
  return lanes;
}

/** Distance from point `(px, pz)` to segment `a→b`. */
function distPointSeg(px, pz, a, b) {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const apx = px - a[0];
  const apz = pz - a[1];
  const len2 = abx * abx + abz * abz;
  let t = len2 === 0 ? 0 : (apx * abx + apz * abz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * abx), pz - (a[1] + t * abz));
}

/** True when segments `a→b` and `c→d` properly intersect. */
function segmentsIntersect(a, b, c, d) {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const cdx = d[0] - c[0];
  const cdz = d[1] - c[1];
  const den = abx * cdz - abz * cdx;
  if (den === 0) return false;
  const acx = c[0] - a[0];
  const acz = c[1] - a[1];
  const t = (acx * cdz - acz * cdx) / den;
  const u = (acx * abz - acz * abx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Even-odd point-in-polygon. */
function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance from a ring to a line segment. */
function distPolySeg(poly, a, b) {
  if (pointInPoly(a[0], a[1], poly) || pointInPoly(b[0], b[1], poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (segmentsIntersect(p, q, a, b)) return 0;
    d = Math.min(d, distPointSeg(p[0], p[1], a, b));
    d = Math.min(d, distPointSeg(a[0], a[1], p, q));
    d = Math.min(d, distPointSeg(b[0], b[1], p, q));
  }
  return d;
}

/**
 * True when `(x, z)` sits in the expanded prow skip (`±(w + 10)` m of east).
 * @param {number} x
 * @param {number} z
 * @param {number} r7
 * @param {number} r2
 */
function inProwSkip(x, z, r7, r2) {
  if (x < 0) return false;
  const r = Math.hypot(x, z);
  if (r < r7 || r > r2) return false;
  return Math.abs(z) <= prowHalfWidth(r, r7, r2) + PROW_PAD;
}

/**
 * Citadel halls, Rath Dínen tombs, Houses of Healing, Old Guesthouse.
 * Thirteen named buildings; ids `20000 + n`; colour `#F2EFE6` unless stated.
 * @returns {Array<{id: number, h: number, color: number, poly: Array<[number, number]>, name: string, shape?: string}>}
 */
export function buildLandmarks() {
  const buildings = [];
  let n = 0;
  const add = (name, poly, h, color, shape) => {
    /** @type {{id: number, h: number, color: number, poly: Array<[number, number]>, name: string, shape?: string}} */
    const b = { id: 20000 + n, h, color, poly, name };
    n += 1;
    if (shape) b.shape = shape;
    buildings.push(b);
  };

  add('White Tower of Ecthelion', axisRect(-40, 0, 22, 22), 90, COLOR_CITADEL, 'tower');
  add('Tower Hall', axisRect(52, 0, 44, 18), 22, COLOR_CITADEL);
  add('Merethrond', axisRect(-10, -40, 40, 16), 16, COLOR_CITADEL);
  add("The King's House", axisRect(-10, 40, 30, 16), 14, COLOR_CITADEL);

  {
    const a = 150 * DEG;
    const ur = [Math.sin(a), -Math.cos(a)];
    const ut = [Math.cos(a), Math.sin(a)];
    const [cx, cz] = atAz(165, 150);
    add('Houses of Healing', orientedRect(cx, cz, ur, ut, 16 / 2, 40 / 2), 12, COLOR_CITADEL);
  }

  {
    const [cx, cz] = atAz(112, 270);
    add('House of the Stewards', axisRect(cx, cz, 12, 12), 8, COLOR_RATH, 'dome');
  }
  for (const az of [262, 278]) {
    for (const r of [112, 124, 136]) {
      const [cx, cz] = atAz(r, az);
      add('Rath Dínen', axisRect(cx, cz, 8, 8), 6, COLOR_RATH, 'dome');
    }
  }

  {
    const a = 120 * DEG;
    const ur = [Math.sin(a), -Math.cos(a)];
    const ut = [Math.cos(a), Math.sin(a)];
    const [cx, cz] = atAz(395, 120);
    add('The Old Guesthouse', orientedRect(cx, cz, ur, ut, 12 / 2, 24 / 2), 10, COLOR_GUEST);
  }

  return buildings;
}

/**
 * White Tree plus six garden trees (architecture.md §4.23).
 * @returns {Array<[number, number, number, number]>}
 */
export function buildTrees() {
  const trees = [[0, 0, 8, 3]];
  const rs = [150, 155, 160, 165, 170, 175];
  const azs = [155, 157, 159, 161, 163, 165];
  for (let i = 0; i < 6; i++) {
    const [x, z] = atAz(rs[i], azs[i]);
    trees.push([x, z, 7, 3]);
  }
  return trees;
}

/**
 * Tangential house rows on tiers 1–6 (architecture.md §4.23 Houses).
 * Ids `10000 + k·1000 + n`; colour from the four stone tints by `id % 4`.
 * @param {ReadonlyArray<{k: number, r: number, h: number, wallH: number, color: number}>} tiers
 * @param {ReadonlyArray<number>} gateAz
 * @param {() => number} rand mulberry32 stream in [0, 1)
 * @returns {Array<{id: number, h: number, color: number, poly: Array<[number, number]>}>}
 */
export function buildHouses(tiers, gateAz, rand) {
  const houses = [];
  const boxes = [];
  const lanes = laneSegments(tiers);
  const landmarkBoxes = buildLandmarks().map((b) => aabb(b.poly));
  const r7 = tiers[6].r;
  const r2 = tiers[1].r;

  const blocked = (box) => {
    for (const other of boxes) {
      if (aabbOverlap(box, other)) return true;
    }
    for (const other of landmarkBoxes) {
      if (aabbOverlap(box, other)) return true;
    }
    return false;
  };

  const crossesLane = (poly) => {
    for (const lane of lanes) {
      if (distPolySeg(poly, lane.a, lane.b) < LANE_CLEAR) return true;
    }
    return false;
  };

  const inGateApproach = (pts, ownGate, nextGate) => {
    for (const [x, z] of pts) {
      const az = azimuthOf(x, z);
      if (angDist(az, ownGate) <= GATE_CLEAR_DEG) return true;
      if (angDist(az, nextGate) <= GATE_CLEAR_DEG) return true;
    }
    return false;
  };

  for (let t = 0; t < 6; t++) {
    const k = t + 1;
    const Rk = tiers[t].r;
    const Rnext = tiers[t + 1].r;
    const ownGate = gateAz[t];
    const nextGate = gateAz[t + 1];
    const band = Rk - Rnext - RAMP;
    const specOuter = Rk - 22 - 5;
    const minPlateau = Rnext + RAMP + 0.5;
    const rows = [Math.max(specOuter, minPlateau)];
    if (band >= 50) rows.push(Rnext + 34 + 5);

    for (const rowR of rows) {
      const rowStart = houses.length;
      let n = 0;
      let azDeg = 0;
      let guard = 0;
      const maxGuard = Math.ceil(2 * Math.PI * rowR) + 50;
      while (azDeg < 360 && guard++ < maxGuard) {
        const width = 9 + rand() * 5;
        const depth = 7 + rand() * 3;
        const height = 7 + rand() * 8;
        const dAz = (width / rowR) * (180 / Math.PI);
        const gapAz = (HOUSE_GAP / rowR) * (180 / Math.PI);
        let placed = false;
        let inner = 0;
        while (azDeg + dAz <= 360 && inner++ < maxGuard) {
          const centerAz = azDeg + dAz / 2;
          const a = centerAz * DEG;
          const ur = [Math.sin(a), -Math.cos(a)];
          const ut = [Math.cos(a), Math.sin(a)];
          const [cx, cz] = atAz(rowR, centerAz);
          const poly = orientedRect(cx, cz, ur, ut, depth / 2, width / 2);
          const [mx, mz] = centroid(poly);
          const cr = Math.hypot(mx, mz);
          const onPlateau = cr >= Rnext + RAMP && cr <= Rk;
          const prow =
            k >= 2 &&
            (inProwSkip(mx, mz, r7, r2) ||
              poly.some(([x, z]) => inProwSkip(x, z, r7, r2)));
          const gate = inGateApproach([[mx, mz], ...poly], ownGate, nextGate);
          const box = aabb(poly);
          if (
            onPlateau &&
            !prow &&
            !gate &&
            !crossesLane(poly) &&
            !blocked(box)
          ) {
            const id = 10000 + k * 1000 + n;
            houses.push({
              id,
              h: round1(height),
              color: HOUSE_COLORS[id % 4],
              poly,
            });
            boxes.push(box);
            n += 1;
            azDeg += dAz + gapAz;
            placed = true;
            break;
          }
          azDeg += (1 / rowR) * (180 / Math.PI);
        }
        if (!placed) break;
      }

      // Drop the last house on this row if it AABB-overlaps the first across 0°.
      if (houses.length - rowStart >= 2) {
        const firstBox = boxes[rowStart];
        const lastBox = boxes[boxes.length - 1];
        if (aabbOverlap(firstBox, lastBox)) {
          houses.pop();
          boxes.pop();
        }
      }
    }
  }

  return houses;
}
