/**
 * AsciiCity bootstrap and frame loop (docs/architecture.md §5). Loads or
 * synthesises the city, builds the three world meshes, wires
 * Controls / Hud / CollisionGrid / ZoneIndex / AsciiRenderer, and runs the
 * animation loop with a live pose exposed on `window.__asciicity`.
 */
import './style.css';
import type { CityData, Vec2 } from './data/types';
import { loadCity } from './data/load';
import { syntheticCity } from './data/synthetic';
import { CollisionGrid } from './world/collision';
import { makeBuildingsObject } from './world/buildings';
import { makeRoadsObject } from './world/roads';
import { makeGround } from './world/ground';
import { makeWindowTexture } from './world/textures';
import {
  Controls,
  stepPlayer,
  yawToBearingDeg,
  type PlayerState,
} from './player/controls';
import { makeCamera, makeRenderer, makeScene } from './render/scene';
import { AsciiRenderer, type AsciiOptions } from './render/ascii';
import { Hud, type HudValues } from './hud/hud';
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

/** Maximum +x offset (metres) the spawn search will scan when (0,0) is blocked. */
const SPAWN_MAX = 200;

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
}

/** Parse `?synthetic=1&seed=N&cell=WxH`. Malformed values are ignored. */
export function parseUrlOptions(search: string): UrlOptions {
  const params = new URLSearchParams(search);
  const synthetic = params.get('synthetic') === '1';
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
  return { synthetic, seed, cellW, cellH };
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

/** Walk +x in 1 m steps from `(0,0)` until `blocked` returns false; else 0. */
function findSpawnX(collision: CollisionGrid): number {
  const probe: Vec2 = [0, 0];
  for (let x = 0; x <= SPAWN_MAX; x++) {
    probe[0] = x;
    if (!collision.blocked(probe)) return x;
  }
  return 0;
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

  const collision = new CollisionGrid(city.buildings);
  const zone = new ZoneIndex(city.roads, city.places);
  const controls = new Controls(canvas);
  const hud = new Hud(hudRoot);

  const asciiOpts: Partial<AsciiOptions> = {};
  if (opts.cellW !== undefined) asciiOpts.cellW = opts.cellW;
  if (opts.cellH !== undefined) asciiOpts.cellH = opts.cellH;
  const ascii = new AsciiRenderer(renderer, asciiOpts);

  const state: PlayerState = {
    x: findSpawnX(collision),
    z: 0,
    yaw: -Math.PI / 2,
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
    canvas.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) setOverlay(true, true);
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

    const input = controls.readInput();
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
    if (frameCount % HUD_INTERVAL === 0) {
      hudValues.sector = sectorOf(state.x, state.z);
      hudValues.world = formatWorld(state.x, state.z);
      hudValues.bearing = formatBearing(yawToBearingDeg(state.yaw));
      hudValues.zone = zone.zoneLabel(state.x, state.z);
      hudValues.fps = api.fps;
      hud.update(hudValues);
    }

    if (!api.ready) api.ready = true;
  }
  requestAnimationFrame(frame);
}

void main();
