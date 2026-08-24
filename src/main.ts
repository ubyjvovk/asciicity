/**
 * AsciiCity bootstrap and frame loop (docs/architecture.md §5). Loads or
 * synthesises the city, builds the world meshes, wires
 * Controls / TouchControls / Hud / CollisionGrid / ZoneIndex / Minimap /
 * AsciiRenderer / CRT overlay, and runs the animation loop with a live pose
 * exposed on `window.__asciicity`.
 */
import './style.css';
import type { CityData, Vec2 } from './data/types';
import { loadCity } from './data/load';
import { syntheticCity } from './data/synthetic';
import { resolveSpawn } from './data/spawn';
import { CollisionGrid } from './world/collision';
import { makeBuildingsObject } from './world/buildings';
import { makeRoadsObject, ROAD_WIDTH } from './world/roads';
import { makeGround } from './world/ground';
import { makeWaterObject } from './world/water';
import { makeWindowTexture } from './world/textures';
import { makeSky, updateSky } from './world/sky';
import {
  Controls,
  stepPlayer,
  yawToBearingDeg,
  type PlayerState,
} from './player/controls';
import { TouchControls, mergeInput } from './player/touch';
import { makeCamera, makeRenderer, makeScene } from './render/scene';
import { AsciiRenderer, type AsciiOptions } from './render/ascii';
import { mountCrt } from './render/crt';
import { Hud, type HudValues } from './hud/hud';
import { Minimap } from './hud/minimap';
import { ZoneIndex } from './hud/zone';
import { formatBearing, formatWorld, sectorOf } from './hud/format';

declare global {
  interface Window {
    __asciicity: {
      ready: boolean;
      state: PlayerState;
      fps: number;
      cols: number;
      rows: number;
    };
  }
}

/** DOM ids provided by index.html. */
const CANVAS_ID = 'view';
const HUD_ID = 'hud';
const OVERLAY_ID = 'overlay';

/** Eye height in metres (docs/architecture.md §3). */
const EYE_HEIGHT = 1.7;

/** Refresh the HUD once every N rendered frames. */
const HUD_INTERVAL = 4;

/** Length of the moving-average window used to smooth the reported FPS. */
const FPS_WINDOW_S = 1;

/** Sub-set of URL query parameters this bootstrap understands. */
interface UrlOptions {
  synthetic: boolean;
  seed: number | undefined;
  cellW: number | undefined;
  cellH: number | undefined;
  crt: boolean;
  minimap: boolean;
  hud: boolean;
  gloom: boolean;
  at: string | null;
  time: Date | null;
}

/** Parse `?synthetic=1&seed=N&cell=WxH&crt=0&minimap=0&hud=0&at=...`. Malformed values are ignored. */
export function parseUrlOptions(search: string): UrlOptions {
  const params = new URLSearchParams(search);
  const synthetic = params.get('synthetic') === '1';
  const at = params.get('at');
  const seedRaw = params.get('seed');
  const seedParsed = seedRaw !== null && seedRaw !== '' ? Number(seedRaw) : NaN;
  const seed = Number.isFinite(seedParsed) ? seedParsed : undefined;
  const cellRaw = params.get('cell');
  let cellW: number | undefined;
  let cellH: number | undefined;
  if (cellRaw !== null) {
    const m = /^(\d+)x(\d+)$/i.exec(cellRaw.trim());
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > 0) cellW = w;
      if (h > 0) cellH = h;
    }
  }
  const crt = params.get('crt') !== '0';
  const minimap = params.get('minimap') !== '0';
  const hud = params.get('hud') !== '0';
  const gloom = params.get('gloom') === '1';
  const time = parseTimeParam(params.get('time'));
  return { synthetic, seed, cellW, cellH, crt, minimap, hud, gloom, at, time };
}

/**
 * Parse `?time=` into a Date: accepts an ISO timestamp or `HH:MM` meaning today
 * in local time; anything invalid (or absent) returns null.
 */
function parseTimeParam(raw: string | null): Date | null {
  if (raw === null || raw === '') return null;
  const iso = new Date(raw.trim());
  if (!Number.isNaN(iso.getTime())) return iso;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      const d = new Date();
      d.setHours(hh, mm, 0, 0);
      return d;
    }
  }
  return null;
}

/** Return `syntheticCity()` on `?synthetic=1` or when the fetch fails. */
async function chooseCity(opts: UrlOptions): Promise<CityData> {
  if (opts.synthetic) {
    return syntheticCity(opts.seed);
  }
  try {
    return await loadCity(import.meta.env.BASE_URL + 'data/city.json');
  } catch (err) {
    console.warn('city.json load failed, using synthetic city:', err);
    return syntheticCity(opts.seed);
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById(CANVAS_ID);
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(`Expected a <canvas id="${CANVAS_ID}">`);
  }
  const hudRoot = document.getElementById(HUD_ID);
  if (!(hudRoot instanceof HTMLElement)) {
    throw new Error(`Expected a <div id="${HUD_ID}">`);
  }
  const overlay = document.getElementById(OVERLAY_ID);
  if (!(overlay instanceof HTMLElement)) {
    throw new Error(`Expected a <div id="${OVERLAY_ID}">`);
  }

  const opts = parseUrlOptions(window.location.search);
  const city = await chooseCity(opts);

  const renderer = makeRenderer(canvas);
  const scene = makeScene();
  const camera = makeCamera(
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
  );
  camera.rotation.order = 'YXZ';

  scene.add(makeGround());
  scene.add(makeRoadsObject(city.roads));
  scene.add(makeBuildingsObject(city.buildings, makeWindowTexture()));
  if (city.water?.length) {
    scene.add(makeWaterObject(city.water));
  }

  // Sky is the fixed time if `?time=` pins it, otherwise the real clock; the
  // 10 s interval advances it (re-computing positions if unpinned).
  const sky = makeSky(opts.time ?? new Date(), city.origin);
  scene.add(sky);
  setInterval(() => {
    updateSky(sky, opts.time ?? new Date(), city.origin);
  }, 10000);

  // Water rings become fake footprints so the player cannot walk onto the
  // river; bridge roads become corridors that override those footprints (and
  // buildings alike), so the player can walk across the Thames.
  const collision = new CollisionGrid(
    city.water?.length
      ? [...city.buildings, ...city.water.map((poly, i) => ({ id: -1 - i, h: 1, poly }))]
      : city.buildings,
    25,
    city.roads
      .filter((r) => r.bridge)
      .map((r) => ({ pts: r.pts, halfWidth: ROAD_WIDTH[r.cls] / 2 + 1 })),
  );
  const zone = new ZoneIndex(city.roads, city.places, 50, city.buildings);
  const controls = new Controls(canvas);
  const touch =
    'ontouchstart' in window || navigator.maxTouchPoints > 0
      ? new TouchControls(canvas)
      : undefined;
  const hud = new Hud(hudRoot, touch ? 'LEFT: MOVE · RIGHT: LOOK' : undefined);

  // `?hud=0` hides the panel (display-only) and skips its per-frame updates,
  // but the rest of the app — world, controls, minimap — still runs.
  if (!opts.hud) hudRoot.style.display = 'none';

  // Canvas is created here (not in index.html) so it lands after Hud's
  // title / rows / help. Disabled entirely on `?minimap=0`.
  let minimap: Minimap | undefined;
  if (opts.minimap) {
    const miniCanvas = document.createElement('canvas');
    miniCanvas.id = 'minimap';
    hudRoot.append(miniCanvas);
    minimap = new Minimap(miniCanvas, city);
  }

  if (opts.crt) mountCrt(document.body);

  const asciiOpts: Partial<AsciiOptions> = {};
  if (opts.cellW !== undefined) asciiOpts.cellW = opts.cellW;
  if (opts.cellH !== undefined) asciiOpts.cellH = opts.cellH;
  asciiOpts.invert = opts.gloom;
  const ascii = new AsciiRenderer(renderer, asciiOpts);

  // Spawn: `?synthetic=1` keeps the deterministic (0, 0, −π/2) grid origin;
  // otherwise resolve `?at=` (preset or coordinate) against the city origin,
  // walking +x if the point is blocked inside a building.
  const spawn = opts.synthetic
    ? { x: 0, z: 0, yaw: -Math.PI / 2 }
    : resolveSpawn(opts.at, city.origin, (p: Vec2) => collision.blocked(p), city);
  const state: PlayerState = {
    x: spawn.x,
    z: spawn.z,
    yaw: spawn.yaw,
    pitch: 0,
  };

  // Reused across frames — no per-frame HUD allocation.
  const hudValues: HudValues = { sector: '', world: '', bearing: '', zone: '', fps: 0 };

  const api = { ready: false, state, fps: 0, cols: 0, rows: 0 };
  window.__asciicity = api;

  function applySize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    ascii.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    api.cols = ascii.cols;
    api.rows = ascii.rows;
  }
  applySize();
  window.addEventListener('resize', applySize);

  // Overlay: title + CLICK TO ENTER on load; on pointer-lock loss, a smaller
  // CLICK TO RESUME reappears. Clicks hide it and request pointer lock.
  const overlayEl: HTMLElement = overlay;
  const overlayHeading = overlayEl.querySelector('h1');
  const overlayPrompt = overlayEl.querySelector('p');
  const setOverlay = (resume: boolean, visible: boolean): void => {
    overlayEl.style.display = visible ? '' : 'none';
    overlayEl.classList.toggle('resume', resume);
    if (overlayHeading instanceof HTMLElement) {
      overlayHeading.style.display = resume ? 'none' : '';
    }
    if (overlayPrompt instanceof HTMLElement) {
      overlayPrompt.textContent = resume ? 'CLICK TO RESUME' : 'CLICK TO ENTER';
    }
  };
  setOverlay(false, true);
  overlayEl.addEventListener('click', () => {
    setOverlay(false, false);
    try {
      void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
    } catch {
      // Pointer lock is unavailable on touch; the overlay is already hidden.
    }
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) setOverlay(true, true);
  });

  // `G` toggles gloom mode (inverted, washed-out grey London); ignore key repeats.
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyG' && !ev.repeat) ascii.setInvert(!ascii.invert);
  });

  // Stable closure over collision — avoids allocating a new arrow per frame.
  const resolveMove = (from: Vec2, to: Vec2): Vec2 => collision.resolve(from, to);

  let lastTs = performance.now();
  let frameCount = 0;
  let fpsFrames = 0;
  let fpsElapsed = 0;

  function frame(nowTs: number): void {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (nowTs - lastTs) / 1000);
    lastTs = nowTs;

    const input = touch
      ? mergeInput(controls.readInput(), touch.readInput())
      : controls.readInput();
    const next = stepPlayer(state, input, dt, resolveMove);
    state.x = next.x;
    state.z = next.z;
    state.yaw = next.yaw;
    state.pitch = next.pitch;

    camera.position.set(state.x, EYE_HEIGHT, state.z);
    camera.rotation.y = -state.yaw;
    camera.rotation.x = state.pitch;

    ascii.render(scene, camera);

    fpsFrames++;
    fpsElapsed += dt;
    if (fpsElapsed >= FPS_WINDOW_S) {
      api.fps = fpsFrames / fpsElapsed;
      fpsFrames = 0;
      fpsElapsed = 0;
    }

    frameCount++;
    if (opts.hud && frameCount % HUD_INTERVAL === 0) {
      hudValues.sector = sectorOf(state.x, state.z);
      hudValues.world = formatWorld(state.x, state.z);
      hudValues.bearing = formatBearing(yawToBearingDeg(state.yaw));
      hudValues.zone = zone.zoneLabel(state.x, state.z);
      hudValues.landmark = zone.nearestLandmark(state.x, state.z, state.yaw)?.name ?? undefined;
      hudValues.fps = api.fps;
      hud.update(hudValues);
      minimap?.update(state);
    }

    if (!api.ready) api.ready = true;
  }
  requestAnimationFrame(frame);
}

void main();
