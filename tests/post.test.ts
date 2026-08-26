/**
 * Pure parts of the render-style registry (docs/architecture.md §4.11):
 * `STYLES` order, scene-target budget, fragment `main()`, no duplicate
 * uniforms. No WebGL is touched.
 */
import { describe, expect, it } from 'vitest';
import { STYLE_ORDER, STYLE_PRELUDE } from '../src/render/style';
import { STYLES } from '../src/render/styles/index';
import { styleGrid } from '../src/render/post';

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
  it('every style cols·subX × rows·subY at 1920×1080 with its default cell is ≤ 640×360', () => {
    for (const style of STYLES) {
      const { cols, rows } = styleGrid(style, 1920, 1080);
      const tw = cols * style.subX;
      const th = rows * style.subY;
      expect(tw, `${style.id} width ${tw}`).toBeLessThanOrEqual(640);
      expect(th, `${style.id} height ${th}`).toBeLessThanOrEqual(360);
    }
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
