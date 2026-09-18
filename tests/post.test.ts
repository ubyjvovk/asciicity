/**
 * Pure parts of the render-style registry (docs/architecture.md §4.11):
 * `STYLES` order, scene-target budget, fragment `main()`, no duplicate
 * uniforms. No WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import { STYLE_ORDER, STYLE_PRELUDE } from '../src/render/style';
import { STYLES } from '../src/render/styles/index';
import { styleGrid, worldUpInView } from '../src/render/post';
import * as THREE from 'three';

/** Collect `uniform <type> <name>` identifiers from GLSL source. */
function uniformNames(src: string): string[] {
  const names: string[] = [];
  const re = /uniform\s+\w+\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

describe('styles/index.ts', () => {
  it('has exactly STYLE_ORDER ids in order', () => {
    expect(STYLES.map((s) => s.id)).toEqual([...STYLE_ORDER]);
  });
});

describe('style target budget', () => {
  it('every style cols·subX × rows·subY at 1920×1080 with its default cell is ≤ its cap (640×360 default, 960×540 ceiling)', () => {
    for (const style of STYLES) {
      const { cols, rows } = styleGrid(style, 1920, 1080);
      const tw = cols * style.subX;
      const th = rows * style.subY;
      const capW = style.targetCap?.w ?? 640;
      const capH = style.targetCap?.h ?? 360;
      expect(capW, `${style.id} cap width`).toBeLessThanOrEqual(960);
      expect(capH, `${style.id} cap height`).toBeLessThanOrEqual(540);
      expect(tw, `${style.id} width ${tw}`).toBeLessThanOrEqual(capW);
      expect(th, `${style.id} height ${th}`).toBeLessThanOrEqual(capH);
    }
  });

  it('targetCap raises the clamp and is itself clamped to 960×540 (wave 18b)', () => {
    const base = { cellW: 2, cellH: 2, subX: 1, subY: 1 };
    expect(styleGrid(base, 1920, 1080)).toEqual({ cols: 640, rows: 360 });
    expect(styleGrid({ ...base, targetCap: { w: 960, h: 540 } }, 1920, 1080)).toEqual({ cols: 960, rows: 540 });
    expect(styleGrid({ ...base, targetCap: { w: 4000, h: 4000 } }, 1920, 1080)).toEqual({ cols: 960, rows: 540 });
    expect(styleGrid({ ...base, targetCap: { w: 960, h: 540 } }, 1280, 720)).toEqual({ cols: 640, rows: 360 });
  });
});

describe('fragments', () => {
  it('every fragment contains void main()', () => {
    for (const style of STYLES) {
      expect(style.fragment, style.id).toMatch(/void\s+main\s*\(\s*\)/);
    }
  });

  it('STYLE_PRELUDE + fragment declares no uniform twice', () => {
    for (const style of STYLES) {
      const names = uniformNames(STYLE_PRELUDE + style.fragment);
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const n of names) {
        if (seen.has(n)) dupes.push(n);
        seen.add(n);
      }
      expect(dupes, style.id).toEqual([]);
    }
  });
});

describe('worldUpInView (wave 17 v2 `viewUp` uniform)', () => {
  it('level camera: world up is view +y', () => {
    const cam = new THREE.PerspectiveCamera(70, 1, 0.3, 2000);
    cam.updateMatrixWorld();
    const v = worldUpInView(cam.matrixWorld, new THREE.Vector3());
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.y).toBeCloseTo(1, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });

  it('camera pitched straight up: world up is view −z (forward)', () => {
    const cam = new THREE.PerspectiveCamera(70, 1, 0.3, 2000);
    cam.rotation.x = Math.PI / 2;
    cam.updateMatrixWorld();
    const v = worldUpInView(cam.matrixWorld, new THREE.Vector3());
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.y).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(-1, 6);
  });

  it('is independent of camera position and yaw', () => {
    const cam = new THREE.PerspectiveCamera(70, 1, 0.3, 2000);
    cam.position.set(120, 1.7, -40);
    cam.rotation.y = 1.1;
    cam.updateMatrixWorld();
    const v = worldUpInView(cam.matrixWorld, new THREE.Vector3());
    expect(v.y).toBeCloseTo(1, 6);
  });
});
