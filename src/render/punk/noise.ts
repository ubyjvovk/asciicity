/**
 * Shared hash / value noise for cyberpunk materials (wave 20b). PM-owned.
 * The SAME formulas exist as TSL nodes (`*Node`) and as plain JS mirrors so
 * pure modules can unit-test distributions (coverage, lit fractions). GPU
 * float precision differs, so mirrors are distribution-equal, not bit-equal.
 */
import { Fn, dot, floor, fract, mix, sin, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** `fract(sin(dot(p, (12.9898, 78.233))) · 43758.5453)` — JS mirror. */
export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Value noise in [0, 1): hash lattice, smoothstep-interpolated — JS mirror. */
export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Two octaves: `0.6667·vnoise(p) + 0.3333·vnoise(2.03·p + 17.1)` — JS mirror. */
export function fbm2(x: number, y: number): number {
  return (2 / 3) * vnoise(x, y) + (1 / 3) * vnoise(x * 2.03 + 17.1, y * 2.03 + 17.1);
}

/** TSL {@link hash2}. */
export const hash2Node = Fn(([p]: [Node<'vec2'>]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

/** TSL {@link vnoise}. */
export const vnoiseNode = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2).add(3));
  const a = hash2Node(i);
  const b = hash2Node(i.add(vec2(1, 0)));
  const c = hash2Node(i.add(vec2(0, 1)));
  const d = hash2Node(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** TSL {@link fbm2}. */
export const fbm2Node = Fn(([p]: [Node<'vec2'>]) =>
  vnoiseNode(p).mul(2 / 3).add(vnoiseNode(p.mul(2.03).add(17.1)).mul(1 / 3)),
);

/** `smoothstep(e0, e1, x)` for plain numbers (mirror helper). */
export function smoothstepJs(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
