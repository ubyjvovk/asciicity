/**
 * ASCII post-process renderer (docs/architecture.md §4.8): render the 3D scene
 * at cell resolution into an off-screen target, then paint one coloured glyph
 * per cell to the canvas with a full-screen shader pass driven by a glyph atlas.
 *
 * Pure helpers (`DEFAULT_RAMP`, `glyphIndex`, `buildGlyphAtlas`) are safe to
 * import from node — no top-level side effects touch DOM or WebGL. The
 * `AsciiRenderer` class is browser-only (needs a `WebGLRenderer`).
 */
import * as THREE from 'three';

/** Default glyph ramp: sparsest (space) to densest ($), 68 glyphs. */
export const DEFAULT_RAMP =
  " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

/** ASCII post-process options; defaults match architecture §4.8. */
export interface AsciiOptions {
  /** Cell width in pixels (default 6). */
  cellW: number;
  /** Cell height in pixels (default 12). */
  cellH: number;
  /** Ordered glyph ramp, sparsest first. */
  ramp: string;
  /** Canvas `ctx.font` string used when rasterising the atlas. */
  font: string;
  /** Luminance shaping exponent (default 0.8). */
  gamma: number;
  /** Scene brightness multiplier applied before the density curve (default 1.7). */
  exposure: number;
  /** Colour theme: 0 cyber, 1 gloom, 2 solarized (default 0). */
  theme: number;
}

const DEFAULT_OPTIONS: AsciiOptions = {
  cellW: 6,
  cellH: 12,
  ramp: DEFAULT_RAMP,
  font: 'bold 24px "DejaVu Sans Mono", "Courier New", monospace',
  gamma: 0.45,
  exposure: 1.7,
  theme: 0,
};

/**
 * Return the glyph index for a luminance in [0, 1]. Mirrors the fragment
 * shader formula exactly: `floor(clamp(lum,0,1)^gamma · (count−1) + 0.5)`,
 * clamped to `[0, count−1]`.
 */
export function glyphIndex(lum: number, count: number, gamma: number): number {
  const clamped = Math.min(1, Math.max(0, lum));
  const shaped = Math.pow(clamped, gamma);
  const raw = Math.floor(shaped * (count - 1) + 0.5);
  return Math.min(count - 1, Math.max(0, raw));
}

/**
 * Rasterise the glyph atlas: one row of `ramp.length` tiles, each `tileW×tileH`,
 * white glyph on black. The caller supplies the canvas so the routine is
 * testable in node with a fake canvas/context.
 */
/**
 * Theme colour mixer mirroring the fragment shader's block term-for-term.
 * `theme` selects the output: 0 = cyber (`tint * mask`), 1 = gloom
 * (darker, more colourful glyphs over a bright grey sky, with hot near-white
 * cells kept bright), 2 = solarized (muted ink on cream paper). `v` is the
 * already-exposed max-channel brightness used to derive the `hot` highlight.
 * Pure, for tests.
 */
export function themeMix(
  tint: [number, number, number],
  v: number,
  mask: number,
  theme: number,
): [number, number, number] {
  const normalCol: [number, number, number] = [tint[0] * mask, tint[1] * mask, tint[2] * mask];
  const lumT = 0.299 * tint[0] + 0.587 * tint[1] + 0.114 * tint[2];
  // smoothstep(0.92, 1.0, clamp(v, 0, 1)) — hot keeps sun/moon/lit windows bright.
  const sx = Math.min(1, Math.max(0, (Math.min(1, Math.max(0, v)) - 0.92) / 0.08));
  const hot = sx * sx * (3 - 2 * sx);

  // Gloom theme (1): darker + more colour than T-0037, hot cells → tint * 0.9.
  const gWash: [number, number, number] = [
    (lumT + (tint[0] - lumT) * 0.75) * 0.2,
    (lumT + (tint[1] - lumT) * 0.75) * 0.2,
    (lumT + (tint[2] - lumT) * 0.75) * 0.2,
  ];
  const gGlyph: [number, number, number] = [
    gWash[0] + (tint[0] * 0.9 - gWash[0]) * hot,
    gWash[1] + (tint[1] * 0.9 - gWash[1]) * hot,
    gWash[2] + (tint[2] * 0.9 - gWash[2]) * hot,
  ];
  const gloomBg: [number, number, number] = [0.72, 0.73, 0.75];
  const gloomCol: [number, number, number] = [
    gloomBg[0] + (gGlyph[0] - gloomBg[0]) * mask,
    gloomBg[1] + (gGlyph[1] - gloomBg[1]) * mask,
    gloomBg[2] + (gGlyph[2] - gloomBg[2]) * mask,
  ];

  // Solarized theme (2): base00 ink on base3 paper, hot cells → solarized yellow.
  const sInk: [number, number, number] = [
    (0.396 + (tint[0] - 0.396) * 0.5) * 0.75,
    (0.482 + (tint[1] - 0.482) * 0.5) * 0.75,
    (0.514 + (tint[2] - 0.514) * 0.5) * 0.75,
  ];
  const solarizedYellow: [number, number, number] = [0.71, 0.54, 0.0];
  const sGlyph: [number, number, number] = [
    sInk[0] + (solarizedYellow[0] - sInk[0]) * hot,
    sInk[1] + (solarizedYellow[1] - sInk[1]) * hot,
    sInk[2] + (solarizedYellow[2] - sInk[2]) * hot,
  ];
  const paper: [number, number, number] = [0.992, 0.965, 0.89];
  const solCol: [number, number, number] = [
    paper[0] + (sGlyph[0] - paper[0]) * mask,
    paper[1] + (sGlyph[1] - paper[1]) * mask,
    paper[2] + (sGlyph[2] - paper[2]) * mask,
  ];

  if (theme < 0.5) return normalCol;
  if (theme < 1.5) return gloomCol;
  return solCol;
}

export function buildGlyphAtlas(
  ramp: string,
  tileW: number,
  tileH: number,
  font: string,
  canvas: HTMLCanvasElement,
): { canvas: HTMLCanvasElement; count: number } {
  canvas.width = ramp.length * tileW;
  canvas.height = tileH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('buildGlyphAtlas: 2d context unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  for (let i = 0; i < ramp.length; i++) {
    ctx.fillText(ramp[i], i * tileW + tileW / 2, tileH / 2);
  }
  return { canvas, count: ramp.length };
}

const VERT_SHADER = `varying vec2 vUv;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
  vUv = uv;
}`;

const FRAG_SHADER = `uniform sampler2D tScene; uniform sampler2D tAtlas;
uniform vec2 grid;        // (cols, rows)
uniform float glyphCount; // atlas tiles
uniform float gamma;      // perceptual curve for glyph density (0.45 ≈ linear→sRGB)
uniform float exposure;   // scene brightness multiplier before the curve
uniform float theme;      // 0 cyber, 1 gloom, 2 solarized
varying vec2 vUv;
void main() {
  vec2 cell = floor(vUv * grid);
  vec3 c = texture2D(tScene, (cell + 0.5) / grid).rgb * exposure;
  float v = max(max(c.r, c.g), c.b);                 // hue-independent brightness
  float shaped = clamp(pow(clamp(v, 0.0, 1.0), gamma), 0.0, 1.0);
  float idx = floor(shaped * (glyphCount - 1.0) + 0.5);
  vec2 inCell = fract(vUv * grid);
  float mask = texture2D(tAtlas, vec2((idx + inCell.x) / glyphCount, inCell.y)).r;
  vec3 tint = c / max(v, 0.02);                      // hue at full brightness…
  tint = tint * clamp(shaped * 0.7 + 0.4, 0.0, 1.0); // …density carries most of the luminance
  vec3 normalCol = tint * mask;
  float lumT = dot(tint, vec3(0.299, 0.587, 0.114));
  float hot = smoothstep(0.92, 1.0, clamp(v, 0.0, 1.0)); // sun/moon/lit windows stay bright
  vec3 gWash = mix(vec3(lumT), tint, 0.75) * 0.20;        // darker + more colour than T-0037
  vec3 gGlyph = mix(gWash, tint * 0.9, hot);
  vec3 gloomCol = mix(vec3(0.72, 0.73, 0.75), gGlyph, mask);
  vec3 sInk = mix(vec3(0.396, 0.482, 0.514), tint, 0.5) * 0.75; // solarized base00 ink
  vec3 sGlyph = mix(sInk, vec3(0.71, 0.54, 0.0), hot);          // hot → solarized yellow
  vec3 solCol = mix(vec3(0.992, 0.965, 0.890), sGlyph, mask);   // base3 paper
  vec3 outCol = theme < 0.5 ? normalCol : (theme < 1.5 ? gloomCol : solCol);
  gl_FragColor = vec4(outCol, 1.0);
}`;

/**
 * Browser-only ASCII post-process. Owns the low-res scene render target, the
 * glyph atlas, and the full-screen quad; `render()` allocates nothing.
 */
export class AsciiRenderer {
  readonly opts: AsciiOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly atlasCanvas: HTMLCanvasElement;
  private readonly atlasTexture: THREE.CanvasTexture;
  private readonly glyphCount: number;
  private readonly quadGeom: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly quadMesh: THREE.Mesh;
  private readonly quadScene: THREE.Scene;
  private readonly orthoCamera: THREE.OrthographicCamera;
  private renderTarget: THREE.WebGLRenderTarget;
  private _cols = 0;
  private _rows = 0;
  private width = 0;
  private height = 0;

  constructor(renderer: THREE.WebGLRenderer, opts?: Partial<AsciiOptions>) {
    this.renderer = renderer;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };

    const tileW = 16;
    const tileH = 32;
    this.atlasCanvas = document.createElement('canvas');
    const built = buildGlyphAtlas(
      this.opts.ramp,
      tileW,
      tileH,
      this.opts.font,
      this.atlasCanvas,
    );
    this.glyphCount = built.count;
    this.atlasTexture = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlasTexture.minFilter = THREE.LinearFilter;
    this.atlasTexture.magFilter = THREE.LinearFilter;
    this.atlasTexture.flipY = true;
    this.atlasTexture.needsUpdate = true;

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.quadGeom = new THREE.PlaneGeometry(2, 2);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.renderTarget.texture },
        tAtlas: { value: this.atlasTexture },
        grid: { value: new THREE.Vector2(1, 1) },
        glyphCount: { value: this.glyphCount },
        gamma: { value: this.opts.gamma },
        exposure: { value: this.opts.exposure },
        theme: { value: this.opts.theme },
      },
      vertexShader: VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.quadMesh = new THREE.Mesh(this.quadGeom, this.material);
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quadMesh);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Canvas cell columns after the last `setSize`. */
  get cols(): number {
    return this._cols;
  }

  /** Canvas cell rows after the last `setSize`. */
  get rows(): number {
    return this._rows;
  }

  /** The current colour theme: 0 cyber, 1 gloom, 2 solarized. */
  get theme(): number {
    return this.material.uniforms.theme.value as number;
  }

  /** Set the colour theme (`0` cyber, `1` gloom, `2` solarized), updating the shader uniform. */
  setTheme(t: number): void {
    this.material.uniforms.theme.value = t;
  }

  /**
   * Resize the renderer and recompute the cell grid. The scene render target
   * is recreated only when `cols/rows` actually change.
   */
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    const cols = Math.floor(width / this.opts.cellW);
    const rows = Math.floor(height / this.opts.cellH);
    if (cols !== this._cols || rows !== this._rows) {
      this._cols = cols;
      this._rows = rows;
      this.renderTarget.setSize(Math.max(1, cols), Math.max(1, rows));
      (this.material.uniforms.grid.value as THREE.Vector2).set(cols, rows);
      this.material.uniforms.tScene.value = this.renderTarget.texture;
    }
  }

  /** Render the scene into the low-res target, then paint glyphs to the canvas. */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.orthoCamera);
  }

  /** Release GPU resources owned by this renderer. */
  dispose(): void {
    this.renderTarget.dispose();
    this.atlasTexture.dispose();
    this.quadGeom.dispose();
    this.material.dispose();
  }
}
