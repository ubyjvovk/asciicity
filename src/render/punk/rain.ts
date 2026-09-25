/**
 * Collision rain for the cyberpunk style (wave 20). Browser-only (WebGPU).
 *
 * Technique ported from ektogamat/threejs-conference
 * `src/world/weather/createCollisionHeight.js` + `createCollisionRain.js`
 * (MIT, © 2026 Anderson Mancini and Sunag): a top-down orthographic pass
 * writes the world position of the highest surface into a small float
 * target around the player; streaks stop — and splash — at that height, so
 * rain lands on roofs, streets, hills, bridge decks, buses and water alike.
 *
 * Difference from upstream: the demo integrates positions in compute
 * buffers; here every drop is a closed-form function of (instance, time)
 * (`rainDrop` in `rainmath.ts` is the CPU mirror), so the same graph runs on the
 * WebGPU and the WebGL2 fallback backends with no storage buffers, and the
 * splash is exactly the drop's own impact, not an independent sprite.
 */
import * as THREE from 'three/webgpu';
import {
  billboarding,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  positionGeometry,
  positionWorld,
  select,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import {
  HEIGHT_AREA,
  HEIGHT_RES,
  NO_FLOOR,
  RAIN_AREA,
  RAIN_COUNT,
  RAIN_SPAN,
  RAIN_SPEED,
  RAIN_TOP,
  SPLASH_S,
} from './rainmath';

/** Everything the view needs from the rain: the group to add and the per-frame hook. */
export interface Rain {
  group: THREE.Group;
  /** Refresh the height map (every other frame) and the drop uniforms. */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, timeS: number, hide: readonly THREE.Object3D[]): void;
  /** Height-map texture (debug view). */
  heightTexture: THREE.Texture;
  /**
   * Debug/e2e: the surface height the rain sees at world (x, z) from the
   * last height pass, or `null` outside the box. Reads one texel back.
   */
  probe(renderer: THREE.WebGPURenderer, x: number, z: number): Promise<number | null>;
  dispose(): void;
}

const tmpDir = new THREE.Vector3();

/** Build the rain group (streaks + splashes) and its height pass. */
export function createRain(): Rain {
  const group = new THREE.Group();
  group.name = 'CollisionRain';
  group.frustumCulled = false;

  // ── height pass ──────────────────────────────────────────────────────
  const heightTarget = new THREE.RenderTarget(HEIGHT_RES, HEIGHT_RES, {
    type: THREE.HalfFloatType,
    depthBuffer: true,
  });
  heightTarget.texture.magFilter = THREE.NearestFilter;
  heightTarget.texture.minFilter = THREE.NearestFilter;
  heightTarget.texture.generateMipmaps = false;
  const half = HEIGHT_AREA / 2;
  const heightCam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 4000);
  // Screen-up = north (−z); see the lookup below for the sampling convention.
  heightCam.up.set(0, 0, -1);
  const heightMat = new THREE.MeshBasicNodeMaterial();
  heightMat.outputNode = vec4(positionWorld, 1);
  heightMat.side = THREE.DoubleSide;
  const clearColor = new THREE.Color(0, NO_FLOOR, 0);
  const prevClear = new THREE.Color();

  // ── uniforms ─────────────────────────────────────────────────────────
  const uTime = uniform(0);
  const uCenter = uniform(new THREE.Vector3());
  const uHeightCenter = uniform(new THREE.Vector3());
  const uTop = uniform(0);
  const uEye = uniform(new THREE.Vector3());
  const uOpacity = uniform(0.2);
  const uSplashOpacity = uniform(0.35);

  // ── per-drop maths (mirrors `rainDrop`) ─────────────────────────────
  const fi = float(instanceIndex);
  const speedVar = hash(fi.add(0.5)).mul(0.15).add(0.925);
  const cyc = uTime.mul(speedVar).mul(RAIN_SPEED / RAIN_SPAN).add(hash(fi.add(1.7)));
  const k = floor(cyc);
  const f = fract(cyc);
  const px = hash(fi.mul(1.31).add(k.mul(7.77))).mul(4096);
  const pz = hash(fi.mul(2.17).add(k.mul(3.33)).add(0.31)).mul(4096);
  const wrap = (p: typeof px, c: typeof px) =>
    fract(p.sub(c).div(RAIN_AREA).add(0.5)).sub(0.5).mul(RAIN_AREA).add(c);
  const x = wrap(px, uCenter.x);
  const z = wrap(pz, uCenter.z);
  const y = uTop.sub(f.mul(RAIN_SPAN));
  // Height map lookup: u east; v SOUTH. The pass renders north-up
  // (heightCam.up = −z), and three samples render targets top-row-first on
  // both backends (verified with `?punkdebug=height` against OSM footprints).
  const hu = x.sub(uHeightCenter.x).div(HEIGHT_AREA).add(0.5);
  const hv = z.sub(uHeightCenter.z).div(HEIGHT_AREA).add(0.5);
  const floorY = texture(heightTarget.texture, vec2(hu, hv)).level(float(0)).y;
  const hitF = uTop.sub(floorY).div(RAIN_SPAN);
  const falling = select(f.lessThan(hitF), float(1), float(0));
  const sdur = speedVar.mul((SPLASH_S * RAIN_SPEED) / RAIN_SPAN);
  const sp = f.sub(hitF).div(sdur);
  const splashOn = select(
    sp.greaterThanEqual(0).and(sp.lessThan(1)).and(hitF.lessThanEqual(1)),
    float(1),
    float(0),
  );

  // ── streaks ─────────────────────────────────────────────────────────
  const STREAK_W = 0.035;
  const STREAK_H = 1.3;
  const streakGeom = new THREE.PlaneGeometry(STREAK_W, STREAK_H);
  // Anchor the streak's bottom end at the drop so it never pokes through the floor.
  streakGeom.translate(0, STREAK_H / 2, 0);
  const suv = uv();
  const centre = suv.x.sub(0.5).abs().mul(2).oneMinus().pow(2);
  const vfade = smoothstep(0, 0.08, suv.y).mul(smoothstep(0, 0.2, suv.y.oneMinus()));
  const streakMat = new THREE.MeshBasicNodeMaterial();
  streakMat.colorNode = vec3(0.86, 0.95, 1.0);
  // Fade streaks inside ~3 m of the eye: a drop crossing the lens is a smear, not a line.
  const near = smoothstep(1.0, 3.5, vec2(x.sub(uEye.x), z.sub(uEye.z)).length());
  streakMat.opacityNode = centre.mul(vfade).mul(uOpacity).mul(near);
  streakMat.positionNode = positionGeometry.mul(falling);
  streakMat.vertexNode = billboarding({ position: vec3(x, y, z), horizontal: true });
  streakMat.transparent = true;
  streakMat.depthWrite = false;
  streakMat.fog = true;
  const streaks = new THREE.Mesh(streakGeom, streakMat);
  streaks.count = RAIN_COUNT;
  streaks.frustumCulled = false;
  streaks.renderOrder = 12;
  group.add(streaks);

  // ── splashes: an expanding ring + crown droplets, procedural ────────
  const SPLASH_SIZE = 0.35;
  const splashGeom = new THREE.PlaneGeometry(SPLASH_SIZE, SPLASH_SIZE);
  splashGeom.translate(0, SPLASH_SIZE * 0.35, 0);
  const t = sp.clamp(0, 1);
  const q = uv().sub(vec2(0.5, 0.35));
  // Ring: an ellipse lying on the ground, seen at eye height.
  const ringD = vec2(q.x, q.y.mul(3.2)).length();
  const r = t.mul(0.42).add(0.04);
  const ring = smoothstep(r.add(0.05), r, ringD).mul(smoothstep(r.sub(0.06), r, ringD));
  // Crown: two droplets arcing out and up.
  const arc = t.mul(t.oneMinus()).mul(1.3);
  const dl = vec2(q.x.add(t.mul(0.25)), q.y.sub(arc)).length();
  const dr = vec2(q.x.sub(t.mul(0.25)), q.y.sub(arc)).length();
  const crown = smoothstep(float(0.035), float(0), dl).add(smoothstep(float(0.035), float(0), dr));
  const splashAlpha = ring.add(crown).mul(t.oneMinus()).mul(uSplashOpacity);
  const splashMat = new THREE.MeshBasicNodeMaterial();
  splashMat.colorNode = vec3(0.86, 0.95, 1.0);
  splashMat.opacityNode = splashAlpha;
  splashMat.positionNode = positionGeometry.mul(splashOn);
  splashMat.vertexNode = billboarding({
    position: vec3(x, floorY.add(0.03), z),
    horizontal: true,
    vertical: true,
  });
  splashMat.transparent = true;
  splashMat.depthWrite = false;
  const splashes = new THREE.Mesh(splashGeom, splashMat);
  splashes.count = RAIN_COUNT;
  splashes.frustumCulled = false;
  splashes.renderOrder = 11;
  group.add(splashes);

  let frame = 0;

  function update(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    timeS: number,
    hide: readonly THREE.Object3D[],
  ): void {
    uTime.value = timeS;
    camera.getWorldDirection(tmpDir);
    tmpDir.y = 0;
    if (tmpDir.lengthSq() > 0) tmpDir.normalize();
    // Centre the box ahead of the camera so the visible cone is densest.
    uCenter.value.set(
      camera.position.x + tmpDir.x * RAIN_AREA * 0.3,
      camera.position.y,
      camera.position.z + tmpDir.z * RAIN_AREA * 0.3,
    );
    uTop.value = camera.position.y + RAIN_TOP;
    uEye.value.copy(camera.position);

    if (frame++ % 2 !== 0) return;
    // Snap the height box to its texel grid so the map does not swim.
    const texel = HEIGHT_AREA / HEIGHT_RES;
    const hx = Math.round(uCenter.value.x / texel) * texel;
    const hz = Math.round(uCenter.value.z / texel) * texel;
    heightCam.position.set(hx, camera.position.y + 1500, hz);
    heightCam.lookAt(hx, camera.position.y - 1000, hz);
    heightCam.updateMatrixWorld(true);

    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    group.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT();
    const prevOverride = scene.overrideMaterial;
    const prevAlpha = renderer.getClearAlpha();
    const prevFog = scene.fog;
    renderer.getClearColor(prevClear);
    scene.overrideMaterial = heightMat;
    scene.fog = null;
    renderer.setMRT(null);
    renderer.setClearColor(clearColor, 1);
    renderer.setRenderTarget(heightTarget);
    renderer.clear();
    renderer.render(scene, heightCam);
    renderer.setRenderTarget(prevTarget);
    renderer.setMRT(prevMRT);
    renderer.setClearColor(prevClear, prevAlpha);
    scene.overrideMaterial = prevOverride;
    scene.fog = prevFog;
    group.visible = true;
    hide.forEach((o, i) => (o.visible = vis[i]));
    // Only commit the new centre once the map for it exists.
    uHeightCenter.value.set(hx, 0, hz);
  }

  async function probe(renderer: THREE.WebGPURenderer, x: number, z: number): Promise<number | null> {
    const c = uHeightCenter.value;
    const u = (x - c.x) / HEIGHT_AREA + 0.5;
    const v = 0.5 - (z - c.z) / HEIGHT_AREA;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    const px = Math.floor(u * HEIGHT_RES);
    // Readback rows run top-down on both backends; texture v runs bottom-up.
    const py = Math.floor((1 - v) * HEIGHT_RES);
    const buf = await renderer.readRenderTargetPixelsAsync(heightTarget, px, py, 1, 1);
    const raw = buf[1];
    return typeof raw === 'number' ? THREE.DataUtils.fromHalfFloat(raw) : null;
  }

  function dispose(): void {
    heightTarget.dispose();
    heightMat.dispose();
    streakGeom.dispose();
    streakMat.dispose();
    splashGeom.dispose();
    splashMat.dispose();
  }

  return { group, update, heightTexture: heightTarget.texture, probe, dispose };
}
