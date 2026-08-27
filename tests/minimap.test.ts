/**
 * Minimap projection and cell lookup (T-0014) plus water/river rendering
 * (T-0064). Pure helpers exercise real signatures; canvas drawing is checked
 * against a fake 2D context that records the op stream so tests can run in the
 * node vitest environment.
 */
import { describe, expect, it } from 'vitest';
import type { CityData, Vec2 } from '../src/data/types';
import { nearbyCells, worldToMinimap, type MinimapOptions } from '../src/hud/minimap';

const opts: MinimapOptions = { size: 200, radius: 100, headingUp: true };
const origin = { x: 0, z: 0, yaw: 0 };

describe('worldToMinimap', () => {
  it('player at origin yaw 0 maps world (0, −100) (north) to [100, 0]', () => {
    const [x, y] = worldToMinimap(0, -100, origin, opts);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(0);
  });

  it('yaw π/2 maps (100, 0) (east) to [100, 0]', () => {
    const [x, y] = worldToMinimap(100, 0, { x: 0, z: 0, yaw: Math.PI / 2 }, opts);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(0);
  });

  it('headingUp: false maps (100, 0) to [200, 100]', () => {
    const [x, y] = worldToMinimap(100, 0, origin, { ...opts, headingUp: false });
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(100);
  });

  it("the player's own position maps to [100, 100] for any yaw", () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3, 4]) {
      const [x, y] = worldToMinimap(10, -20, { x: 10, z: -20, yaw }, opts);
      expect(x).toBeCloseTo(100);
      expect(y).toBeCloseTo(100);
    }
  });

  it('a point at 2×radius lands outside [0, size]', () => {
    const [x, y] = worldToMinimap(0, -200, origin, opts);
    expect(x < 0 || x > opts.size || y < 0 || y > opts.size).toBe(true);
  });
});

describe('nearbyCells', () => {
  it('returns 9 keys for radius 100 / cell 100 at the origin', () => {
    const keys = nearbyCells(0, 0, 100, 100).sort();
    expect(keys).toEqual([
      '-1,-1',
      '-1,0',
      '-1,1',
      '0,-1',
      '0,0',
      '0,1',
      '1,-1',
      '1,0',
      '1,1',
    ]);
  });

  it('1 key for radius 10 inside a cell', () => {
    const keys = nearbyCells(50, 50, 10, 100);
    expect(keys).toEqual(['0,0']);
  });
});

interface FillOp {
  kind: 'fill';
  style: string;
  path: PathOp[];
}
interface StrokeOp {
  kind: 'stroke';
  style: string;
  width: number;
  path: PathOp[];
}
interface RectOp {
  kind: 'fillRect';
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface TextOp {
  kind: 'fillText';
  style: string;
  text: string;
  x: number;
  y: number;
}
type Op = FillOp | StrokeOp | RectOp | TextOp;
type PathOp =
  | { kind: 'moveTo'; x: number; y: number }
  | { kind: 'lineTo'; x: number; y: number }
  | { kind: 'closePath' };

interface FakeCanvasResult {
  canvas: HTMLCanvasElement;
  ops: Op[];
}

function makeFakeCanvas(): FakeCanvasResult {
  const ops: Op[] = [];
  let path: PathOp[] = [];
  const state = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  const ctx = {
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get fillStyle(): string {
      return state.fillStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get strokeStyle(): string {
      return state.strokeStyle;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    get lineWidth(): number {
      return state.lineWidth;
    },
    set font(v: string) {
      state.font = v;
    },
    get font(): string {
      return state.font;
    },
    set textAlign(v: string) {
      state.textAlign = v;
    },
    get textAlign(): string {
      return state.textAlign;
    },
    set textBaseline(v: string) {
      state.textBaseline = v;
    },
    get textBaseline(): string {
      return state.textBaseline;
    },
    beginPath(): void {
      path = [];
    },
    moveTo(x: number, y: number): void {
      path.push({ kind: 'moveTo', x, y });
    },
    lineTo(x: number, y: number): void {
      path.push({ kind: 'lineTo', x, y });
    },
    closePath(): void {
      path.push({ kind: 'closePath' });
    },
    fill(): void {
      ops.push({ kind: 'fill', style: state.fillStyle, path: path.slice() });
    },
    stroke(): void {
      ops.push({
        kind: 'stroke',
        style: state.strokeStyle,
        width: state.lineWidth,
        path: path.slice(),
      });
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      ops.push({ kind: 'fillRect', style: state.fillStyle, x, y, w, h });
    },
    fillText(text: string, x: number, y: number): void {
      ops.push({ kind: 'fillText', style: state.fillStyle, text, x, y });
    },
    save(): void {
      /* no-op for these tests */
    },
    restore(): void {
      /* no-op for these tests */
    },
    translate(_x: number, _y: number): void {
      /* no-op for these tests */
    },
    rotate(_a: number): void {
      /* no-op for these tests */
    },
  };
  const classes = new Set<string>();
  const canvas = {
    width: 0,
    height: 0,
    classList: {
      add(name: string): void {
        classes.add(name);
      },
      has(name: string): boolean {
        return classes.has(name);
      },
    },
    getContext(_type: string): typeof ctx {
      return ctx;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, ops };
}

/** Ray-casting point-in-polygon on a projected ring built from moveTo/lineTo. */
function pathContains(path: PathOp[], px: number, py: number): boolean {
  const pts: [number, number][] = [];
  for (const op of path) {
    if (op.kind === 'moveTo' || op.kind === 'lineTo') pts.push([op.x, op.y]);
  }
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function city(patch: Partial<CityData> = {}): CityData {
  return {
    v: 1,
    origin: { lat: 0, lon: 0 },
    bbox: [0, 0, 0, 0],
    buildings: [],
    roads: [],
    places: [],
    ...patch,
  };
}

const SQUARE_100: Vec2[] = [
  [-50, -50],
  [50, -50],
  [50, 50],
  [-50, 50],
];

describe('Minimap water and rivers', () => {
  it('a city with one water ring around the origin fills the canvas centre 20 px offset with #0e3a46', async () => {
    const { Minimap } = await import('../src/hud/minimap');
    const { canvas, ops } = makeFakeCanvas();
    const map = new Minimap(canvas, city({ water: [SQUARE_100] }), {
      size: 200,
      radius: 100,
      headingUp: true,
    });
    map.update(origin);
    const fills = ops.filter((o): o is FillOp => o.kind === 'fill');
    const waterFills = fills.filter((f) => f.style === '#0e3a46');
    expect(waterFills.length).toBe(1);
    expect(pathContains(waterFills[0].path, 100 - 20, 100)).toBe(true);
  });

  it('a ring 5 km away is not drawn (no water-colour fill calls)', async () => {
    const { Minimap } = await import('../src/hud/minimap');
    const { canvas, ops } = makeFakeCanvas();
    const farRing: Vec2[] = SQUARE_100.map(([x, z]): Vec2 => [x + 5000, z + 5000]);
    const map = new Minimap(canvas, city({ water: [farRing] }), {
      size: 200,
      radius: 100,
      headingUp: true,
    });
    map.update(origin);
    const waterFills = ops.filter((o) => o.kind === 'fill' && o.style === '#0e3a46');
    expect(waterFills).toHaveLength(0);
  });

  it('rivers produce one stroke in the river colour', async () => {
    const { Minimap } = await import('../src/hud/minimap');
    const { canvas, ops } = makeFakeCanvas();
    const river: Vec2[] = [
      [-40, 0],
      [40, 0],
    ];
    const map = new Minimap(canvas, city({ rivers: [river] }), {
      size: 200,
      radius: 100,
      headingUp: true,
    });
    map.update(origin);
    const riverStrokes = ops.filter(
      (o): o is StrokeOp => o.kind === 'stroke' && o.style === '#155b6b',
    );
    expect(riverStrokes).toHaveLength(1);
    expect(riverStrokes[0].width).toBe(1);
    // The single river segment maps to a moveTo/lineTo pair on the canvas.
    const moves = riverStrokes[0].path.filter((p) => p.kind === 'moveTo');
    const lines = riverStrokes[0].path.filter((p) => p.kind === 'lineTo');
    expect(moves).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  it('cities without water are unchanged (no water fill, no river stroke)', async () => {
    const { Minimap } = await import('../src/hud/minimap');
    const { canvas, ops } = makeFakeCanvas();
    const map = new Minimap(canvas, city(), {
      size: 200,
      radius: 100,
      headingUp: true,
    });
    map.update(origin);
    expect(ops.some((o) => o.kind === 'fill' && o.style === '#0e3a46')).toBe(false);
    expect(ops.some((o) => o.kind === 'stroke' && o.style === '#155b6b')).toBe(false);
  });
});

describe('Minimap woods', () => {
  it('a city with one wood ring around the origin paints #0b2f18 at a sample pixel', async () => {
    const { Minimap } = await import('../src/hud/minimap');
    const { canvas, ops } = makeFakeCanvas();
    const map = new Minimap(canvas, city({ woods: [SQUARE_100] }), {
      size: 200,
      radius: 100,
      headingUp: true,
    });
    map.update(origin);
    const fills = ops.filter((o): o is FillOp => o.kind === 'fill');
    const woodFills = fills.filter((f) => f.style === '#0b2f18');
    expect(woodFills.length).toBe(1);
    expect(pathContains(woodFills[0].path, 100 - 20, 100)).toBe(true);
  });

  it('a wood ring inside a water ring paints after (wins the pixel over) water', async () => {
    const { Minimap } = await import('../src/hud/minimap');
    const { canvas, ops } = makeFakeCanvas();
    const map = new Minimap(canvas, city({ water: [SQUARE_100], woods: [SQUARE_100] }), {
      size: 200,
      radius: 100,
      headingUp: true,
    });
    map.update(origin);
    const fills = ops.filter((o): o is FillOp => o.kind === 'fill');
    const waterIdx = fills.findIndex((f) => f.style === '#0e3a46');
    const woodIdx = fills.findIndex((f) => f.style === '#0b2f18');
    expect(waterIdx).toBeGreaterThanOrEqual(0);
    expect(woodIdx).toBeGreaterThan(waterIdx);
  });

  it('cities without woods are unchanged (no #0b2f18 fill)', async () => {
    const { Minimap } = await import('../src/hud/minimap');
    const { canvas, ops } = makeFakeCanvas();
    const map = new Minimap(canvas, city(), {
      size: 200,
      radius: 100,
      headingUp: true,
    });
    map.update(origin);
    expect(ops.some((o) => o.kind === 'fill' && o.style === '#0b2f18')).toBe(false);
  });
});
