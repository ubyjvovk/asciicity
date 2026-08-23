/**
 * Pure HUD string formatters. No DOM — safe to unit-test in node.
 */

const COMPASS = [
  'NORTH',
  'NORTHEAST',
  'EAST',
  'SOUTHEAST',
  'SOUTH',
  'SOUTHWEST',
  'WEST',
  'NORTHWEST',
] as const;

/** At least two decimal digits, no sign (caller splits east/west, south/north). */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Bearing in degrees as `"267 DEG / WEST"` (rounded, modulo 360, 8-way compass). */
export function formatBearing(deg: number): string {
  const n = ((Math.round(deg) % 360) + 360) % 360;
  const idx = Math.round(n / 45) % 8;
  return `${String(n).padStart(3, '0')} DEG / ${COMPASS[idx]}`;
}

/** World position as `"1234.50 / -321.00"` (`toFixed(2)` on x then z). */
export function formatWorld(x: number, z: number): string {
  return `${x.toFixed(2)} / ${z.toFixed(2)}`;
}

/** Grid-cell label such as `"E02 / N05"` (`cell` defaults to 100 m). */
export function sectorOf(x: number, z: number, cell = 100): string {
  const c = Math.floor(x / cell);
  const r = Math.floor(z / cell);
  const ew = c >= 0 ? `E${pad2(c)}` : `W${pad2(-c)}`;
  const ns = r >= 0 ? `S${pad2(r)}` : `N${pad2(-r)}`;
  return `${ew} / ${ns}`;
}

/** One HUD row: `label` dotted out to 11 characters, then a space and `value`. */
export function hudRow(label: string, value: string): string {
  return `${label.padEnd(11, '.')} ${value}`;
}
