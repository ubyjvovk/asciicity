/**
 * AsciiCity bootstrap and frame loop (docs/architecture.md §5). Loads or
 * synthesises the city, builds the world meshes (draped over terrain when the
 * dataset carries one), wires Controls / TouchControls / Hud / CollisionGrid /
 * ZoneIndex / Minimap / AsciiRenderer / CRT overlay, and runs the animation
 * loop with a live pose exposed on `window.__asciicity`.
 */
import './style.css';
import * as THREE from 'three';
import { FLAT_HEIGHT, type CityData, type HeightFn, type Vec2 } from './data/types';
import { loadCity } from './data/load';
import { syntheticCity } from './data/synthetic';
import { CITIES, cityById, type CityInfo } from './data/cities';
import { resolveSpawn } from './data/spawn';
import { CollisionGrid } from './world/collision';
import { makeBuildingsObject } from './world/buildings';
import { makeRoadsObject, ROAD_WIDTH } from './world/roads';
import { makeGround } from './world/ground';
import { makeWaterObject } from './world/water';
import { makeWindowTexture } from './world/textures';
import { makeSky, updateSky } from './world/sky';
import { BridgeDecks, Terrain, makeGroundAt, makeTerrainObject } from './world/terrain';
import { BoatFleet, BusFleet } from './world/traffic';
import {
  Controls,
  EYE_HEIGHT,
  stepPlayer,
  yawToBearingDeg,
  type PlayerState,
} from './player/controls';
import { TouchControls, mergeInput } from './player/touch';
import { makeCamera, makeRenderer, makeScene } from './render/scene';
import { AsciiRenderer, type AsciiOptions } from './render/ascii';
import { mountCrt } from './render/crt';
import { Hud, type HudValues } from './hud/hud';
import { buildShareUrl } from './hud/share';
import { Minimap } from './hud/minimap';
import { ZoneIndex } from './hud/zone';
import { formatAlt, formatBearing, formatWorld, sectorOf } from './hud/format';

declare global {
  interface Window {
    __asciicity: {
      ready: boolean;
      state: PlayerState;
      fps: number;
      /** Eye height in metres (absolute world y: ground + EYE_HEIGHT, or airborne). */
      y: number;
      /** URL id of the loaded city (`'london'`, `'kyiv'`, or `'synthetic'`). */
      city: string;
      /** True while flying (fly mode). */
      fly: boolean;
      cols: number;
      rows: number;
    };
  }
}

/** DOM ids provided by index.html. */
const CANVAS_ID = 'view';
const HUD_ID = 'hud';
const OVERLAY_ID = 'overlay';

/** Refresh the HUD once every N rendered frames. */
const HUD_INTERVAL = 4;

/** Length of the moving-average window used to smooth the reported FPS. */
const FPS_WINDOW_S = 1;

/** Sub-set of URL query parameters this bootstrap understands. */
interface UrlOptions {
  synthetic: boolean;
  hills: boolean;
  seed: number | undefined;
  cellW: number | undefined;
  cellH: number | undefined;
  crt: boolean;
  minimap: boolean;
  hud: boolean;
  theme: number;
  at: string | null;
  city: string | null;
  time: Date | null;
  fly: boolean;
}

/**
 * Parse `?synthetic=1&seed=N&hills=1&city=…&cell=WxH&crt=0&minimap=0&hud=0&at=…&theme=…&time=…`.
 * Malformed values are ignored.
 */
export function parseUrlOptions(search: string): UrlOptions {
  const params = new URLSearchParams(search);
  const synthetic = params.get('synthetic') === '1';
  const hills = params.get('hills') === '1';
  const at = params.get('at');
  const city = params.get('city');
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
  // `?theme=cyber|gloom|solarized|0|1|2`; invalid → 0. `?gloom=1` remains an
  // alias for theme 1, but the `theme` param wins when both are present.
  const themeRaw = params.get('theme');
  const tv = themeRaw !== null ? themeRaw.trim().toLowerCase() : '';
  const theme =
    tv === 'gloom' || tv === '1'
      ? 1
      : tv === 'solarized' || tv === '2'
        ? 2
        : tv === 'cyber' || tv === '0' || tv === ''
          ? 0
          : params.get('gloom') === '1'
            ? 1
            : 0;
  const time = parseTimeParam(params.get('time'));
  const fly = params.get('fly') === '1';
  return { synthetic, hills, seed, cellW, cellH, crt, minimap, hud, theme, at, city, time, fly };
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

/**
 * Return the resolved `CityData` plus the id string reported on
 * `window.__asciicity.city`. `?synthetic=1` → `syntheticCity(seed, 12, hills)`
 * with id `'synthetic'`; otherwise pick `cityById(opts.city) ?? CITIES[0]`
 * and `loadCity(BASE_URL + info.file)`, falling back to `syntheticCity(seed)`
 * on a fetch failure (log a console warning).
 */
async function chooseCity(
  opts: UrlOptions,
): Promise<{ city: CityData; id: string; info?: CityInfo }> {
  if (opts.synthetic) {
    return { city: syntheticCity(opts.seed, 12, opts.hills), id: 'synthetic' };
  }
  const info = cityById(opts.city) ?? CITIES[0];
  try {
    const city = await loadCity(import.meta.env.BASE_URL + info.file);
    return { city, id: info.id, info };
  } catch (err) {
    console.warn(`${info.file} load failed, using synthetic city:`, err);
    return { city: syntheticCity(opts.seed), id: 'synthetic' };
  }
}

/**
 * Render the start-overlay city picker (T-0046) and resolve with the chosen
 * `CityInfo`. Shows the plain overlay (title + `CHOOSE A CITY`) with one
 * `.city` button per `CITIES` entry (label + blurb); keys `1`…`9` select by
 * index. On a choice the current query plus `city=<id>` is written to the URL
 * via `history.replaceState`, and the returned promise resolves.
 */
function drawCityPicker(
  overlay: HTMLElement,
  menuRoot: Element | null,
): Promise<CityInfo> {
  return new Promise((resolve) => {
    const heading = overlay.querySelector('h1');
    const prompt = overlay.querySelector('p');
    overlay.style.display = '';
    overlay.classList.remove('resume');
    if (heading instanceof HTMLElement) heading.style.display = '';
    if (prompt instanceof HTMLElement) prompt.textContent = 'CHOOSE A CITY';
    const menu = menuRoot instanceof HTMLElement ? menuRoot : null;
    if (menu) {
      menu.textContent = '';
      CITIES.forEach((c, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'city';
        const label = document.createElement('label');
        label.textContent = `${i + 1}. ${c.label}`;
        const blurb = document.createElement('blurb');
        blurb.textContent = c.blurb;
        btn.append(label, blurb);
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          choose(c);
        });
        menu.append(btn);
      });
    }
    const onKey = (ev: KeyboardEvent): void => {
      const n = Number(ev.key);
      if (Number.isInteger(n) && n >= 1 && n <= CITIES.length) {
        choose(CITIES[n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    function choose(c: CityInfo): void {
      window.removeEventListener('keydown', onKey);
      const params = new URLSearchParams(window.location.search);
      params.set('city', c.id);
      const qs = params.toString();
      history.replaceState(
        null,
        '',
        window.location.pathname + (qs ? `?${qs}` : ''),
      );
      resolve(c);
    }
  });
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
  const menuRoot = overlay.querySelector('#menu');
  // Anything inside `#menu` (the pause buttons and the `#share` input) must not
  // resume the game: a click on the read-only field has to focus/select it, not
  // hide the overlay. One container-level guard for click/mousedown/pointerdown
  // rather than a listener duplicated on each child (`drawCityPicker`'s buttons
  // stop propagation on their own).
  if (menuRoot instanceof HTMLElement) {
    for (const evt of ['click', 'mousedown', 'pointerdown'] as const) {
      menuRoot.addEventListener(evt, (e) => e.stopPropagation());
    }
  }

  const opts = parseUrlOptions(window.location.search);

  // City picker (T-0046): with neither `?synthetic=1` nor a valid `?city=` the
  // start overlay becomes a chooser — one button per `CITIES` entry, keys
  // 1…9. On a choice the current query plus `city=<id>` is written to the URL
  // via `history.replaceState` (every other parameter kept), then data loading
  // and the rest of the boot continue below.
  const needsPicker = !opts.synthetic && !cityById(opts.city);
  if (needsPicker) {
    opts.city = (await drawCityPicker(overlay, menuRoot)).id;
  }

  const { city, id: cityId, info: cityInfo } = await chooseCity(opts);

  const renderer = makeRenderer(canvas);
  const scene = makeScene();
  const camera = makeCamera(
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
  );
  camera.rotation.order = 'YXZ';

  // Terrain (wave 5): builders and fleets get a `groundAt` HeightFn that
  // combines the heightfield with any bridge decks. Without terrain the
  // sampler is `FLAT_HEIGHT` and every call site behaves as before.
  let terrain: Terrain | undefined;
  let decks: BridgeDecks | undefined;
  let groundAt: HeightFn = FLAT_HEIGHT;
  if (city.terrain) {
    terrain = new Terrain(city.terrain);
    decks = new BridgeDecks(city.roads, terrain.heightAt);
    groundAt = makeGroundAt(terrain, decks);
  }

  const groundMesh = makeGround();
  if (terrain) groundMesh.position.y = terrain.min - 0.5;
  scene.add(groundMesh);
  if (terrain) scene.add(makeTerrainObject(terrain.data));
  scene.add(makeRoadsObject(city.roads, groundAt));
  scene.add(makeBuildingsObject(city.buildings, makeWindowTexture(), groundAt));
  if (city.water?.length) {
    scene.add(makeWaterObject(city.water, city.waterLevels));
  }

  // Red double-deckers cruising the primary/secondary roads — pure ambience
  // (pass-through, no collision). Works on both the real and synthetic city.
  const fleet = new BusFleet(city.roads, 12, 9, groundAt);
  scene.add(fleet.object);

  // A few grey boats gliding along the river centre-lines (T-0036), when the
  // dataset carries them — pure ambience, no collision. Boats ride on the
  // terrain sampler (flattened river bed) so they float at water level.
  const boats = city.rivers?.length
    ? new BoatFleet(city.rivers, 4, 17, terrain ? terrain.heightAt : FLAT_HEIGHT)
    : undefined;
  if (boats) scene.add(boats.object);

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
  asciiOpts.theme = opts.theme;
  const ascii = new AsciiRenderer(renderer, asciiOpts);

  // Spawn: `?synthetic=1` keeps the deterministic (0, 0, −π/2) grid origin;
  // otherwise resolve `?at=` (preset or coordinate) against the city origin,
  // walking +x if the point is blocked inside a building. Presets/coords that
  // fall outside `city.bbox` (a London preset in Kyiv, say) drop back to the
  // city's `defaultSpawn`.
  const spawn = opts.synthetic
    ? { x: 0, z: 0, yaw: -Math.PI / 2 }
    : resolveSpawn(
        opts.at,
        city.origin,
        (p: Vec2) => collision.blocked(p),
        city,
        cityInfo?.defaultSpawn,
      );
  const state: PlayerState = {
    x: spawn.x,
    z: spawn.z,
    y: groundAt(spawn.x, spawn.z) + EYE_HEIGHT,
    yaw: spawn.yaw,
    pitch: 0,
    fly: opts.fly,
  };

  // `?fly=1` takes off immediately, so the camera needs the long far plane
  // from the start; per-frame toggles swap it back and forth.
  if (state.fly) {
    camera.far = 6000;
    camera.updateProjectionMatrix();
  }

  // Reused across frames — no per-frame HUD allocation. `alt`/`mode` start
  // unset and are assigned each frame (ALT: on terrain ASL; while flying AGL;
  // MODE only while flying).
  const hudValues: HudValues = { sector: '', world: '', bearing: '', zone: '', fps: 0 };

  const api = {
    ready: false,
    state,
    fps: 0,
    y: state.y,
    fly: state.fly,
    city: cityId,
    cols: 0,
    rows: 0,
  };
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
  // CLICK TO RESUME reappears with the pause menu (COPY LINK TO HERE /
  // SWITCH CITY) in `#menu`. Clicks hide it and request pointer lock.
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
    setMenu(resume ? 'pause' : 'none');
  };
  // Fill `#menu` (pause menu) or clear it (plain enter overlay). The picker's
  // own menu is drawn by `drawCityPicker` and cleared here on boot.
  const setMenu = (mode: 'none' | 'pause'): void => {
    if (!(menuRoot instanceof HTMLElement)) return;
    menuRoot.textContent = '';
    if (mode === 'none') return;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'menu-btn';
    copyBtn.textContent = 'COPY LINK TO HERE';
    const switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'menu-btn';
    switchBtn.textContent = 'SWITCH CITY';
    const shareInput = document.createElement('input');
    shareInput.id = 'share';
    shareInput.type = 'text';
    shareInput.readOnly = true;
    // Hidden until it holds a URL so the pause menu shows just the two buttons
    // before the player copies for the first time.
    shareInput.hidden = true;
    copyBtn.addEventListener('click', () => {
      const url = buildShareUrl(window.location.href, cityId, state, city.origin);
      navigator.clipboard?.writeText(url).catch(() => undefined);
      shareInput.value = url;
      shareInput.hidden = false;
      shareInput.select();
      copyBtn.textContent = 'COPIED';
      window.setTimeout(() => {
        copyBtn.textContent = 'COPY LINK TO HERE';
      }, 1500);
    });
    switchBtn.addEventListener('click', () => {
      const params = new URLSearchParams(window.location.search);
      params.delete('city');
      params.delete('at');
      const qs = params.toString();
      window.location.href = window.location.pathname + (qs ? `?${qs}` : '');
    });
    menuRoot.append(copyBtn, switchBtn, shareInput);
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

  // `G` cycles the colour theme cyber → gloom → solarized (and back); ignore key repeats.
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyG' && !ev.repeat) ascii.setTheme((ascii.theme + 1) % 3);
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
    const next = stepPlayer(state, input, dt, resolveMove, groundAt);
    const wasFlying = state.fly;
    state.x = next.x;
    state.z = next.z;
    state.y = next.y;
    state.yaw = next.yaw;
    state.pitch = next.pitch;
    state.fly = next.fly;
    if (next.fly !== wasFlying) {
      // On a fly toggle the far plane swaps so the whole city (flying) or just
      // the street (walking) fills the view; the projection must be recomputed.
      camera.far = next.fly ? 6000 : 2000;
      camera.updateProjectionMatrix();
    }
    // Fog thins with altitude (`agl` = metres above the ground): at ground
    // level it is the constant 0.0018, roughly halving by ~150 m AGL so the
    // whole city stays visible from above.
    const agl = state.y - EYE_HEIGHT - groundAt(state.x, state.z);
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.density = 0.0018 / (1 + agl / 150);
    }

    camera.position.set(state.x, state.y, state.z);
    camera.rotation.y = -state.yaw;
    camera.rotation.x = state.pitch;
    sky.position.set(state.x, state.y, state.z);
    api.y = state.y;
    api.fly = state.fly;

    fleet.update(dt);
    boats?.update(dt);

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
      // `ALT` is the eye altitude: on terrain it is the datum plus the eye
      // height above sea level (walking: y − EYE_HEIGHT === groundAt, so the
      // row is unchanged); without terrain it is only shown while flying, as
      // metres above the ground.
      if (city.terrain) {
        hudValues.alt = formatAlt(city.terrain.datum + state.y - EYE_HEIGHT, 'ASL');
      } else if (state.fly) {
        hudValues.alt = formatAlt(agl, 'AGL');
      } else {
        hudValues.alt = undefined;
      }
      hudValues.mode = state.fly ? 'FLY' : undefined;
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
