/**
 * Cyberpunk post pipeline (wave 20). Browser-only (WebGPU / WebGL2 backend).
 *
 * Ported from ektogamat/threejs-conference `src/post/postprocessing.js`,
 * `src/post/look/cyberpunkLook.js` and `src/tsl/edgeChromaticAberration.js`
 * (MIT, © 2026 Anderson Mancini and Sunag): scene pass with an emissive MRT
 * → bloom (+ lens flare) on the emissive layer → distance fog → grade
 * (tint, green suppression, saturation, contrast) → edge chromatic
 * aberration → vignette → SMAA → film grain. Added here: SSR on the wet
 * surfaces (their demo uses one planar mirror; our streets are on hills) and
 * the lens-rain overlay (`glass.ts`) as a steady layer instead of an intro.
 * Dropped: GTAO and DoF (cost over a whole city).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  convertToTexture,
  emissive,
  float,
  length,
  luminance,
  max,
  metalness,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  roughness,
  sample,
  unpackRGBToNormal,
  saturation,
  screenUV,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { lensflare } from 'three/addons/tsl/display/LensflareNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { bloomSettings, type LookPreset } from './look';
import { createAtmosphere } from './atmosphere';
import { applyRainGlass, createGlassUniforms, type GlassUniforms } from './glass';

const toLinear = (c: readonly [number, number, number]): THREE.Vector3 => {
  const col = new THREE.Color(c[0], c[1], c[2]).convertSRGBToLinear();
  return new THREE.Vector3(col.r, col.g, col.b);
};

/** Edge-only chromatic aberration (upstream `EdgeChromaticAberrationNode`). */
function edgeChroma(input: Node<'vec4'>, strength: Node<'float'>, falloff: Node<'float'>): Node<'vec4'> {
  const tex = convertToTexture(input);
  return Fn(() => {
    const uvc = screenUV;
    const off = uvc.sub(0.5);
    const d = length(off);
    const edge = float(1).sub(float(1).div(d.mul(falloff).pow(2).add(1)));
    const k = strength.mul(edge).mul(0.015);
    const r = tex.sample(off.mul(k.add(1)).add(0.5)).r;
    const g = tex.sample(uvc).g;
    const b = tex.sample(off.mul(k.oneMinus()).add(0.5)).b;
    return vec4(r, g, b, tex.sample(uvc).a);
  })();
}

/** What the view drives. */
export interface PunkPipeline {
  render(timeS: number): void;
  stats(): Record<string, number>;
  applyLook(p: LookPreset): void;
  setGlass(on: boolean): void;
  /** Runtime reflection tier (adaptive quality); scale 0 = off. No-op without SSR. */
  setReflections(scale: number, quality: number, distance: number): void;
  /** Debug: draw the rain height map (north up, 0–40 m ramp) in the top-left corner. */
  showHeightMap(tex: THREE.Texture): void;
  glass: GlassUniforms;
  dispose(): void;
}

/**
 * Cost knobs (wave 23 perf pass). `ssrScale` 0 = no reflections; bloom /
 * flare / smaa can be dropped on weak GPUs. Fixed at construction.
 */
export interface PipelineQuality {
  ssrScale: number;
  /** SSR march quality 0–1 and max distance (m). */
  ssrQuality: number;
  ssrDistance: number;
  bloom: boolean;
  flare: boolean;
  smaa: boolean;
}

/** Build the node graph for `scene` seen from `camera`. */
export function createPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  opts: PipelineQuality,
): PunkPipeline {
  const post = new THREE.RenderPipeline(renderer);

  const scenePass = pass(scene, camera);
  const mrtNode = mrt({
    output,
    emissive: vec4(emissive, output.a),
    normal: vec4(packNormalToRGB(normalView), output.a),
    metalrough: vec4(metalness, roughness, 0, output.a),
  });
  // Alpha-blend the extra attachments too: otherwise the faint transparent
  // rain streaks / splashes overwrite the wet street's normal + metalness
  // and punch dark holes into its reflection.
  for (const name of ['emissive', 'normal', 'metalrough']) {
    mrtNode.setBlendMode(name, new THREE.BlendMode(THREE.NormalBlending));
  }
  scenePass.setMRT(mrtNode);
  scenePass.getTexture('emissive').type = THREE.UnsignedByteType;
  scenePass.getTexture('normal').type = THREE.UnsignedByteType;
  scenePass.getTexture('metalrough').type = THREE.UnsignedByteType;

  const color = scenePass.getTextureNode('output');
  const emissiveTex = scenePass.getTextureNode('emissive');
  const depthTex = scenePass.getTextureNode('depth');
  const normalTex = scenePass.getTextureNode('normal');
  const mrTex = scenePass.getTextureNode('metalrough');
  const sceneNormal = sample((uvs: Node<'vec2'>) => unpackRGBToNormal(normalTex.sample(uvs)));

  // Wet-street reflections. SSRNode does not compile on the WebGL2
  // fallback backend (int/float `max` in its march loop), so it is
  // WebGPU-only; the fallback keeps the wet sheen from the env map.
  let reflections: ReturnType<typeof ssr> | null = null;
  let beauty: Node<'vec4'> = color;
  if (opts.ssrScale > 0) {
    reflections = ssr(color, depthTex, sceneNormal, {
      // Only march rays where it matters (perf pass, wave 23): SSRNode skips
      // pixels whose metalness is exactly 0, and dry asphalt / pavement /
      // facades (≈ 0.1) were being marched for a barely visible sheen. Below
      // 0.5 we report 0 — puddles (0.9), water (0.95) and glass (0.6–0.9) keep SSR;
      // the rest keeps its env-map sheen.
      metalnessNode: mrTex.r.mul(step(float(0.5), mrTex.r)),
      roughnessNode: mrTex.g,
      camera,
    });
    // Full resolution: at 0.5 the rippled puddles alias into blocky sparkle
    // (PM GPU review, wave 20b); cost measured on the GPU host.
    reflections.resolutionScale = opts.ssrScale;
    reflections.maxDistance.value = opts.ssrDistance;
    reflections.thickness.value = 0.6;
    reflections.quality.value = opts.ssrQuality;
    reflections.intensity.value = 0.45;
    const ssrTex = reflections.getTextureNode();
    // Puddles (metalness 0.9) and water (0.95) mirror fully; damp asphalt /
    // pavement (≈ 0.12) keeps 30 % — full SSR on every dry surface turned
    // open squares into a field of sky-sheen glitter (PM GPU review, T-0153).
    const wet = smoothstep(0.5, 0.8, mrTex.r);
    beauty = vec4(color.rgb.add(ssrTex.rgb.mul(ssrTex.a).mul(wet)), color.a);
  }

  const bloomPass = bloom(emissiveTex, 2.5, 0.45);
  bloomPass.setResolutionScale(0.5);
  const flareThreshold = uniform(0.9);
  const flareGhostAtt = uniform(50);
  const flareGhostSpacing = uniform(0.22);
  const flareStrength = uniform(0.35);
  const flare = gaussianBlur(
    lensflare(bloomPass, {
      threshold: flareThreshold,
      ghostAttenuationFactor: flareGhostAtt,
      ghostSpacing: flareGhostSpacing,
    }),
    uniform(4),
    4,
    { resolutionScale: 0.5 },
  );
  const bloomAll: Node<'vec4'> = !opts.bloom
    ? vec4(0, 0, 0, 0)
    : opts.flare
      ? bloomPass.add(flare.mul(flareStrength))
      : vec4(bloomPass.rgb, 1);

  const u = {
    fogEnabled: uniform(0.35),
    fogNear: uniform(0),
    fogFar: uniform(250),
    fogColor: uniform(new THREE.Vector3(0.1, 0.11, 0.18)),
    fogAmount: uniform(0.8),
    fogBloomSuppress: uniform(0.75),
    gradeTint: uniform(new THREE.Vector3(1, 1, 1)),
    gradeOffset: uniform(new THREE.Vector3()),
    saturation: uniform(1),
    contrast: uniform(1),
    greenSuppress: uniform(1),
    gradeMix: uniform(0),
    chromaticStrength: uniform(0),
    chromaticEdgeFalloff: uniform(3),
    vignetteIntensity: uniform(0),
    vignetteSmoothness: uniform(0.65),
    grainIntensity: uniform(0),
  };

  // Fog + light diffusion (atmosphere.ts), then the upstream grade.
  const cameraWorld = uniform(new THREE.Matrix4());
  const projectionInverse = uniform(new THREE.Matrix4());
  const atmosphere = createAtmosphere({
    beauty,
    bloom: bloomAll,
    emissive: emissiveTex,
    viewZ: scenePass.getViewZNode(),
    linearDepth: scenePass.getLinearDepthNode(),
    depth: depthTex.r,
    cameraWorld,
    projectionInverse,
    fog: u,
  });
  const hazedRgb = atmosphere.rgb;
  const tinted = hazedRgb.mul(u.gradeTint).add(u.gradeOffset);
  const l1 = luminance(tinted);
  const deGreen = vec3(tinted.r, mix(tinted.g, l1, u.greenSuppress), tinted.b).max(0);
  const sat = saturation(deGreen, u.saturation);
  const contrasted = mix(vec3(luminance(sat)), sat, u.contrast).max(0);
  const graded = vec4(mix(hazedRgb, contrasted, u.gradeMix), float(1));
  const chroma = edgeChroma(graded, u.chromaticStrength, u.chromaticEdgeFalloff);
  const withChroma = mix(graded, chroma, step(float(0.001), u.chromaticStrength));
  const vig = float(1).sub(
    smoothstep(u.vignetteSmoothness, float(1), length(screenUV.sub(0.5)).mul(1.6)).mul(u.vignetteIntensity),
  );
  const preAA = vec4(withChroma.rgb.mul(vig), float(1));
  // FilmNode is typed as a bare TempNode; it outputs vec4.
  const steady = film(opts.smaa ? smaa(preAA) : preAA, u.grainIntensity) as unknown as Node<'vec4'>;

  const glass = createGlassUniforms();
  const withGlass = applyRainGlass(steady, glass);
  let glassOn = true;
  post.outputNode = withGlass;

  function applyLook(p: LookPreset): void {
    u.fogEnabled.value = p.fogEnabled;
    u.fogNear.value = p.fogNear;
    u.fogFar.value = p.fogFar;
    // The demo's fog is a bright haze over a bright alley; ours sits over a
    // night city, so it is darkened to keep the skyline readable.
    u.fogColor.value.copy(toLinear(p.fogColorSrgb)).multiplyScalar(0.35);
    u.fogAmount.value = p.fogAmount;
    u.gradeTint.value.set(...p.gradeTint);
    u.gradeOffset.value.set(...p.gradeOffset);
    u.saturation.value = p.saturation;
    u.contrast.value = p.contrast;
    u.greenSuppress.value = p.greenSuppress;
    u.gradeMix.value = p.gradeMix;
    u.chromaticStrength.value = p.chromaticStrength;
    u.chromaticEdgeFalloff.value = p.chromaticEdgeFalloff;
    u.vignetteIntensity.value = p.vignetteIntensity;
    u.vignetteSmoothness.value = p.vignetteSmoothness;
    u.grainIntensity.value = p.grainIntensity;
    const b = bloomSettings(p);
    bloomPass.strength.value = b.strength;
    bloomPass.radius.value = b.radius;
    flareStrength.value = p.lensflare.strength;
    flareThreshold.value = p.lensflare.threshold;
    flareGhostSpacing.value = p.lensflare.ghostSpacing;
    flareGhostAtt.value = p.lensflare.ghostAttenuation;
  }

  function setReflections(scale: number, quality: number, distance: number): void {
    if (!reflections) return;
    // SSRNode re-reads resolutionScale every frame (setSize in updateBefore);
    // "off" keeps a tiny target and zero intensity instead of a graph rebuild.
    reflections.resolutionScale = scale > 0 ? scale : 0.05;
    reflections.intensity.value = scale > 0 ? 0.45 : 0;
    reflections.quality.value = quality;
    reflections.maxDistance.value = distance;
  }

  function setGlass(on: boolean): void {
    if (on === glassOn) return;
    glassOn = on;
    post.outputNode = on ? withGlass : steady;
    post.needsUpdate = true;
  }

  function showHeightMap(tex: THREE.Texture): void {
    const size = 0.35;
    // Render targets sample top-row-first: v = screenUV.y/size is north-up.
    const local = vec2(screenUV.x.div(size), screenUV.y.div(size));
    const h = texture(tex, local).y;
    const ramp = vec3(h.div(40).clamp(0, 1));
    const inBox = step(screenUV.x, float(size)).mul(step(screenUV.y, float(size)));
    const base = glassOn ? withGlass : steady;
    post.outputNode = vec4(mix(base.rgb, ramp, inBox), float(1));
    post.needsUpdate = true;
  }

  return {
    setReflections,
    render: (timeS: number) => {
      camera.updateMatrixWorld();
      cameraWorld.value.copy(camera.matrixWorld);
      projectionInverse.value.copy(camera.projectionMatrixInverse);
      atmosphere.update(camera, timeS);
      post.render();
    },
    stats: () => atmosphere.stats(),
    showHeightMap,
    applyLook,
    setGlass,
    glass,
    dispose: () => {
      post.dispose();
      reflections?.dispose();
      bloomPass.dispose();
    },
  };
}
