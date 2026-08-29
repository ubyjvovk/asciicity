/**
 * AsciiCity bootstrap and frame loop (docs/architecture.md §5). Loads or
 * synthesises the city, builds the world meshes (draped over terrain when the
 * dataset carries one), wires Controls / TouchControls / Hud / CollisionGrid /
 * ZoneIndex / Minimap / StyleRenderer / CRT overlay, and runs the animation
 * loop with a live pose exposed on `window.__asciicity`.
 */
import './style.css';
import * as THREE from 'three';
import { FLAT_HEIGHT, type CityData, type HeightFn, type Vec2 } from './data/types';
import { validateCity } from './data/validate';
import { syntheticCity } from './data/synthetic';
import { CITIES, cityById, type CityInfo } from './data/cities';
import { formatLoading, loadCityJson, type LoadProgress } from './ui/loading';
import { createPostcard } from './export/postcard';
import { SPAWN_PRESETS, presetsFor, resolveSpawn } from './data/spawn';
import { applyLandmarks, LANDMARK_FIXES } from './world/landmarks';
import { CollisionGrid } from './world/collision';
import { makeBuildingsObject } from './world/buildings';
import { SUSPENSION_BRIDGES, bridgeAnchors, makeBridgesObject } from './world/bridge';
import { TreeField } from './world/trees';
import { makeRoadsObject, ROAD_WIDTH } from './world/roads';
import { makeGround } from './world/ground';
import { makeWaterObject } from './world/water';
import { makeWindowTexture } from './world/textures';
import { makeSky, updateSky, sunPosition } from './world/sky';
import { ShipFleet } from './world/ships';
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
import { StyleRenderer } from './render/post';
import { STYLE_ORDER } from './render/style';
import { STYLES } from './render/styles/index';
import { mountCrt, setCrt } from './render/crt';
import { Hud, type HudValues } from './hud/hud';
import { buildShareUrl } from './hud/share';
import { Minimap } from './hud/minimap';
import { ZoneIndex } from './hud/zone';
import { formatAlt, formatBearing, formatWorld, sectorOf } from './hud/format';
import { CREDITS } from './credits';
import {
  SETTINGS_KEY,
  applySettingsToUrl,
  loadSettings,
  saveSettings,
  type Settings,
} from './settings';
import { Tags, landmarkAnchors, pickTags } from './hud/tags';

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
      /** Live render-style id (`?render=`, `R` cycles). */
      render: string;
      /** Style ids in `R`-cycle order. */
      styles: readonly string[];
      /** Live UI settings (HUD / minimap / CRT / render / city). */
      settings: Settings;
      cols: number;
      rows: number;
      /**
       * Fast-travel to a spawn preset by key (T-0061). Same code path as the
       * `LANDMARKS ▸` menu row and as `?at=<key>`. Returns `true` on success,
       * `false` for an unknown key.
       */
      travel(key: string): boolean;
      /** Number of trees in the loaded city's TreeField (0 when absent, T-0066). */
      trees: number;
      /**
       * Bay shipping (T-0081): total ships and whether running lights are on.
       * `lightsOn` is live (`setNight` from the sky interval).
       */
      ships: { count: number; lightsOn: boolean };
      /**
       * Test hook (T-0072/T-0073): capture a PNG of the next frame or a 3 s
       * GIF without downloading. `'png'` / `'gif'` each resolve to a `Blob`.
       */
      postcard(kind: string): Promise<Blob>;
      /**
       * Live loading progress (T-0085, architecture.md §4.18). Same reference
       * every frame — mutated in place through the download/parse/build phases,
       * ending at `ready`.
       */
      loading: LoadProgress;
    };
  }
}

/** DOM ids provided by index.html. */
const CANVAS_ID = 'view';
const HUD_ID = 'hud';
const OVERLAY_ID = 'overlay';
const HIT_ID = 'hit';

/**
 * Height in px of the black `#credits` footer bar at the bottom of the page
 * (architecture.md §4.12). `applySize` subtracts it from the canvas height
 * and camera aspect; style.css mirrors it via hard-coded `20px` calc offsets,
 * so the ASCII grid, `#gear` and `#toast` never overlap the bar.
 */
const CREDITS_BAR_PX = 20;

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
  render: string;
  at: string | null;
  city: string | null;
  time: Date | null;
  fly: boolean;
  tags: boolean;
}

/**
 * Parse `?synthetic=1&seed=N&hills=1&city=…&cell=WxH&crt=0&minimap=0&hud=0&tags=0&at=…&render=…&time=…`.
 * Malformed values are ignored. `?theme=` / `?gloom=1` are aliases for `?render=`.
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
  const render = resolveRenderId(params);
  const time = parseTimeParam(params.get('time'));
  const fly = params.get('fly') === '1';
  const tags = params.get('tags') !== '0';
  return { synthetic, hills, seed, cellW, cellH, crt, minimap, hud, render, at, city, time, fly, tags };
}

/**
 * Resolve `?render=` (unknown → `ascii`). `?theme=` / `?gloom=1` are aliases
 * (`cyber|0` → ascii, `gloom|1` → gloom, `solarized|2` → solarized); `render`
 * wins when both are present.
 */
function resolveRenderId(params: URLSearchParams): string {
  const order: readonly string[] = STYLE_ORDER;
  const renderRaw = params.get('render');
  if (renderRaw !== null) {
    const id = renderRaw.trim().toLowerCase();
    return order.includes(id) ? id : 'ascii';
  }
  const themeRaw = params.get('theme');
  if (themeRaw !== null) {
    const tv = themeRaw.trim().toLowerCase();
    if (tv === 'gloom' || tv === '1') return 'gloom';
    if (tv === 'solarized' || tv === '2') return 'solarized';
    if (tv === 'cyber' || tv === '0' || tv === 'ascii' || tv === '') return 'ascii';
  }
  if (params.get('gloom') === '1') return 'gloom';
  return 'ascii';
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
 * `requestAnimationFrame` promise so the boot sequence can `await` a paint
 * between the major builders (docs/architecture.md §4.18). Resolves on the
 * next frame.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * Fetch, stream-report progress on, and validate the city JSON for `info` —
 * the streaming path used by the loading indicator (T-0085, architecture.md
 * §4.18). Calls `onProgress` on every download tick, then `parse`, then
 * returns the validated `CityData`. On any failure the caller falls back to
 * `syntheticCity(seed)` (same behaviour as the pre-T-0085 `chooseCity`).
 */
async function fetchCity(
  info: CityInfo,
  onProgress: (p: LoadProgress) => void,
): Promise<CityData> {
  const url = import.meta.env.BASE_URL + info.file;
  const raw = await loadCityJson(url, info.sizeBytes, onProgress);
  return validateCity(raw);
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
  const hit = document.createElement('div');
  hit.id = HIT_ID;
  hit.setAttribute('aria-hidden', 'true');
  canvas.after(hit);
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

  // Persistence (T-0060): URL wins, localStorage fills gaps, defaults last.
  // Private-mode browsers throw on `localStorage` access — treat that as empty.
  let storage: Pick<Storage, 'getItem' | 'setItem'>;
  try {
    const probe = window.localStorage;
    probe.getItem(SETTINGS_KEY);
    storage = probe;
  } catch {
    storage = { getItem: () => null, setItem: () => undefined };
  }
  const settings = loadSettings(
    storage,
    new URLSearchParams(window.location.search),
  );
  opts.hud = settings.hud;
  opts.minimap = settings.minimap;
  opts.crt = settings.crt;
  opts.render = settings.render;
  opts.city = settings.city;

  /** Mirror the four toggle keys onto the URL so COPY LINK carries them. */
  const persist = (): void => {
    try {
      saveSettings(storage, settings);
    } catch {
      // private mode / quota
    }
    try {
      const next = applySettingsToUrl(window.location.search, settings);
      const dest = window.location.pathname + next;
      if (dest !== window.location.pathname + window.location.search) {
        history.replaceState(null, '', dest);
      }
    } catch {
      // ignore
    }
  };
  persist();

  mountCredits(document.body);

  // City picker (T-0046): with neither `?synthetic=1` nor a valid `?city=` the
  // start overlay becomes a chooser — one button per `CITIES` entry, keys
  // 1…9. On a choice the current query plus `city=<id>` is written to the URL
  // via `history.replaceState` (every other parameter kept), then data loading
  // and the rest of the boot continue below.
  let pickerOpen = false;
  const needsPicker = !opts.synthetic && !cityById(opts.city);
  if (needsPicker) {
    pickerOpen = true;
    opts.city = (await drawCityPicker(overlay, menuRoot)).id;
    pickerOpen = false;
    settings.city = opts.city;
    persist();
  }

  // Loading indicator (T-0085, architecture.md §4.18). `loading` is a live
  // reference mutated through the download → parse → build → ready phases;
  // window.__asciicity.loading exposes it so the e2e can poll the phase.
  // `?synthetic=1` skips the download phase and starts at `build`.
  const initialInfo = cityById(opts.city) ?? CITIES[0];
  const loadingLabel = opts.synthetic ? 'SYNTHETIC' : initialInfo.label;
  const loading: LoadProgress = opts.synthetic
    ? { phase: 'build', received: 0, total: 0, step: 'TERRAIN' }
    : { phase: 'download', received: 0, total: initialInfo.sizeBytes };
  const overlayPromptEl = overlay.querySelector('p');
  const paintLoading = (): void => {
    if (!(overlayPromptEl instanceof HTMLElement)) return;
    // `ready` restores the default prompt so the e2e assertion (`#overlay p`
    // contains neither `LOADING` nor `BUILDING`) is guaranteed after the flip.
    // `setOverlay` will later swap in `CLICK TO ENTER` / `CLICK TO RESUME`.
    if (loading.phase === 'ready') {
      overlayPromptEl.textContent = '';
      return;
    }
    overlayPromptEl.textContent = formatLoading(loadingLabel, loading);
  };
  // Stub `window.__asciicity` early so the e2e can read `.loading.phase` from
  // the very first tick; the full `api` object replaces it below, sharing the
  // same `loading` reference so external polls stay live across the swap.
  window.__asciicity = { ready: false, loading } as unknown as Window['__asciicity'];
  paintLoading();

  let city: CityData;
  let cityId: string;
  let cityInfo: CityInfo | undefined;
  if (opts.synthetic) {
    city = syntheticCity(opts.seed, 12, opts.hills);
    cityId = 'synthetic';
    cityInfo = undefined;
  } else {
    try {
      city = await fetchCity(initialInfo, (p) => {
        loading.phase = p.phase;
        loading.received = p.received;
        loading.total = p.total;
        loading.step = undefined;
        paintLoading();
      });
      cityId = initialInfo.id;
      cityInfo = initialInfo;
    } catch (err) {
      console.warn(`${initialInfo.file} load failed, using synthetic city:`, err);
      city = syntheticCity(opts.seed);
      cityId = 'synthetic';
      cityInfo = undefined;
    }
  }

  // Landmark fixes (architecture.md §4.13): apply the curated height/colour
  // table and any extra synthetic buildings. Synthetic/unknown ids are no-ops.
  city = applyLandmarks(city, cityId);
  if (cityById(cityId)) {
    settings.city = cityId;
    persist();
  }

  const renderer = makeRenderer(canvas);
  const scene = makeScene();
  const camera = makeCamera(
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
  );
  camera.rotation.order = 'YXZ';

  // Yields between the major builders so the overlay repaints the current
  // step (architecture.md §4.18). Each label is set BEFORE the corresponding
  // scene.add, giving the browser a paint frame to update the `<p>`.
  const buildStep = async (step: string): Promise<void> => {
    loading.phase = 'build';
    loading.step = step;
    paintLoading();
    await nextFrame();
  };

  // TERRAIN — heightfield + ground filler + terrain mesh. Without
  // `city.terrain` the sampler stays `FLAT_HEIGHT` (London behaviour).
  await buildStep('TERRAIN');
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

  await buildStep('BUILDINGS');
  scene.add(makeBuildingsObject(city.buildings, makeWindowTexture(), groundAt));

  await buildStep('ROADS');
  scene.add(makeRoadsObject(city.roads, groundAt));

  // Trees (architecture.md §4.14): two instanced meshes seated on the terrain.
  await buildStep('TREES');
  const treeField = city.trees?.length ? new TreeField(city.trees, groundAt) : undefined;
  if (treeField) scene.add(treeField.object);

  await buildStep('WATER');
  if (city.water?.length) {
    scene.add(makeWaterObject(city.water, city.waterLevels));
  }

  await buildStep('BRIDGES');
  scene.add(makeBridgesObject(cityId, city, groundAt));

  // TRAFFIC — red buses on the primaries + grey Thames boats. Pure ambience.
  await buildStep('TRAFFIC');
  const fleet = new BusFleet(city.roads, 12, 9, groundAt);
  scene.add(fleet.object);
  const boats = city.rivers?.length
    ? new BoatFleet(city.rivers, 4, 17, terrain ? terrain.heightAt : FLAT_HEIGHT)
    : undefined;
  if (boats) scene.add(boats.object);

  // Bay shipping (architecture.md §4.17): cargo + sail on curated lanes.
  // Cities without SHIP_LANES (London / Kyiv / synthetic) are inert.
  await buildStep('SHIPS');
  const ships = new ShipFleet(
    cityId,
    city,
    terrain ? terrain.heightAt : FLAT_HEIGHT,
  );
  scene.add(ships.object);

  // Sky is the fixed time if `?time=` pins it, otherwise the real clock; the
  // 10 s interval advances it (re-computing positions if unpinned). Night
  // running lights use the same altitude threshold as the stars (−6°).
  const sky = makeSky(opts.time ?? new Date(), city.origin);
  scene.add(sky);
  const applyShipNight = (): void => {
    ships.setNight(
      sunPosition(opts.time ?? new Date(), city.origin.lat, city.origin.lon).altitudeDeg < -6,
    );
  };
  setInterval(() => {
    updateSky(sky, opts.time ?? new Date(), city.origin);
    applyShipNight();
  }, 10000);
  applyShipNight();

  // Water rings are passed as their own arg so an island ring nested in a Bay
  // ring is walkable land (odd-parity test, architecture.md §4.6 wave-9);
  // bridge roads become corridors that override footprints and water alike, so
  // the player can walk across the Thames or the Golden Gate.
  const collision = new CollisionGrid(
    city.buildings,
    25,
    city.roads
      .filter((r) => r.bridge)
      .map((r) => ({ pts: r.pts, halfWidth: ROAD_WIDTH[r.cls] / 2 + 1 })),
    city.water ?? [],
  );
  const zone = new ZoneIndex(city.roads, city.places, 50, city.buildings);
  const controls = new Controls(canvas);
  const touch =
    'ontouchstart' in window || navigator.maxTouchPoints > 0
      ? new TouchControls(hit)
      : undefined;
  const hud = new Hud(
    hudRoot,
    touch
      ? 'LEFT: MOVE · RIGHT: LOOK · R STYLE'
      : 'WASD MOVE · MOUSE LOOK · SHIFT RUN · F FLY · R STYLE · P POSTCARD · ESC MENU',
  );

  // Panels are always created; `?hud=0` / `?minimap=0` (and the matching
  // toggles) hide them with `display: none` and skip their per-frame updates.
  if (!settings.hud) hudRoot.style.display = 'none';

  const miniRoot = document.createElement('div');
  miniRoot.id = 'mini';
  const miniCanvas = document.createElement('canvas');
  miniCanvas.id = 'minimap';
  miniRoot.append(miniCanvas);
  document.body.append(miniRoot);
  const minimap = new Minimap(miniCanvas, city);
  if (!settings.minimap) miniRoot.style.display = 'none';

  const crtEl = mountCrt(document.body);
  setCrt(crtEl, settings.crt);

  // Floating landmark labels (architecture.md §4.13): one `#tags` overlay,
  // a fixed pool of 8 `div.tag`s, updated every 4th frame. `?tags=0` skips
  // the container and the per-frame work. Anchors are built once after
  // `applyLandmarks` so extras (id ≤ −1000) are already in `city.buildings`.
  let tags: Tags | undefined;
  const anchors = opts.tags
    ? [
        ...landmarkAnchors(city, LANDMARK_FIXES[cityId] ?? {}, groundAt),
        ...(SUSPENSION_BRIDGES[cityId ?? 'synthetic'] ?? []).flatMap((spec) =>
          bridgeAnchors(spec, city, groundAt),
        ),
      ]
    : [];
  if (opts.tags) {
    const tagsRoot = document.createElement('div');
    tagsRoot.id = 'tags';
    document.body.append(tagsRoot);
    tags = new Tags(tagsRoot);
  }

  const post = new StyleRenderer(renderer, STYLES, {
    initial: opts.render,
    cellW: opts.cellW,
    cellH: opts.cellH,
  });
  const toast = mountToast();
  toast.show(`RENDER: ${post.style.label}`);

  // Postcard PNG export (T-0072): filename uses the registry id (no spaces);
  // the caption bar paints the upper-cased label.
  const postcard = createPostcard(
    canvas,
    () => ({
      cityId: cityId ?? 'synthetic',
      cityLabel: cityInfo?.label ?? (cityId ?? 'synthetic').toUpperCase(),
    }),
    (msg) => toast.show(msg),
  );

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
        (p: Vec2, r?: number) => collision.blocked(p, r),
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
    render: post.style.id,
    styles: STYLES.map((s) => s.id),
    settings,
    trees: treeField?.count ?? 0,
    get ships(): { count: number; lightsOn: boolean } {
      return { count: ships.count, lightsOn: ships.lightsOn };
    },
    cols: 0,
    rows: 0,
    // Overridden below once `travel` is in scope.
    travel: (_key: string): boolean => false,
    postcard: (kind: string): Promise<Blob> =>
      kind === 'png'
        ? postcard.snapPng(false)
        : kind === 'gif'
          ? postcard.recordGif(false)
          : Promise.reject(new Error(`unknown postcard kind: ${kind}`)),
    loading,
  };
  window.__asciicity = api;
  // Every builder ran successfully — flip the loading phase to `ready` so the
  // overlay's usual prompt takes over on the very next paintLoading call.
  loading.phase = 'ready';
  loading.step = undefined;
  paintLoading();

  let viewW = Math.max(1, window.innerWidth);
  let viewH = Math.max(1, window.innerHeight);

  function applySize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    // Canvas sits in the space above the 20 px `#credits` bar; tags overlay
    // the full window, so viewW/viewH stay the real inner dimensions.
    viewW = w;
    viewH = h;
    const canvasH = Math.max(1, h - CREDITS_BAR_PX);
    post.setSize(w, canvasH);
    camera.aspect = w / canvasH;
    camera.updateProjectionMatrix();
    api.cols = post.cols;
    api.rows = post.rows;
  }
  applySize();
  window.addEventListener('resize', applySize);

  // Overlay: title + CLICK TO ENTER on load; on pointer-lock loss, a smaller
  // CLICK TO RESUME reappears with the pause/settings menu in `#menu`. Clicks
  // hide it and request pointer lock. The ⚙ button also opens this overlay.
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

  let hudBtn: HTMLButtonElement | undefined;
  let miniBtn: HTMLButtonElement | undefined;
  let crtBtn: HTMLButtonElement | undefined;
  let styleBtn: HTMLButtonElement | undefined;
  let flyBtn: HTMLButtonElement | undefined;

  const labelOnOff = (name: string, on: boolean): string =>
    `${name}: ${on ? 'ON' : 'OFF'}`;

  const relabelMenu = (): void => {
    if (hudBtn) hudBtn.textContent = labelOnOff('HUD', settings.hud);
    if (miniBtn) miniBtn.textContent = labelOnOff('MINIMAP', settings.minimap);
    if (crtBtn) crtBtn.textContent = labelOnOff('CRT', settings.crt);
    if (styleBtn) styleBtn.textContent = `STYLE: ${post.style.label} ▸`;
    if (flyBtn) flyBtn.textContent = labelOnOff('FLY', state.fly);
  };

  const setHudVisible = (on: boolean): void => {
    settings.hud = on;
    hudRoot.style.display = on ? '' : 'none';
    persist();
    relabelMenu();
  };
  const setMinimapVisible = (on: boolean): void => {
    settings.minimap = on;
    miniRoot.style.display = on ? '' : 'none';
    persist();
    relabelMenu();
  };
  const setCrtVisible = (on: boolean): void => {
    settings.crt = on;
    setCrt(crtEl, on);
    persist();
    relabelMenu();
  };
  const applyStyleChange = (): void => {
    settings.render = post.style.id;
    api.render = post.style.id;
    api.cols = post.cols;
    api.rows = post.rows;
    toast.show(`RENDER: ${post.style.label}`);
    persist();
    relabelMenu();
  };
  const setFly = (on: boolean): void => {
    if (state.fly === on) {
      relabelMenu();
      return;
    }
    state.fly = on;
    camera.far = on ? 6000 : 2000;
    camera.updateProjectionMatrix();
    api.fly = on;
    relabelMenu();
  };

  const menuButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  };

  const isTouch = (): boolean =>
    'ontouchstart' in window || navigator.maxTouchPoints > 0;

  /**
   * Teleport to a spawn preset (T-0061, architecture.md §4.13). Resolves the
   * key via `resolveSpawn` (same path as `?at=`), rewrites the pose in place,
   * lands (`fly = false`), toasts `→ <LABEL>`, mirrors `at=<key>` onto the
   * URL, hides the overlay and — on non-touch — re-requests pointer lock.
   * Returns `false` for an unknown key (nothing changes).
   */
  const travel = (key: string): boolean => {
    if (typeof key !== 'string') return false;
    const trimmed = key.trim().toLowerCase();
    const preset = SPAWN_PRESETS[trimmed];
    if (!preset) return false;
    const sp = resolveSpawn(
      trimmed,
      city.origin,
      (p: Vec2, r?: number) => collision.blocked(p, r),
      city,
      cityInfo?.defaultSpawn,
    );
    state.x = sp.x;
    state.z = sp.z;
    state.yaw = sp.yaw;
    state.pitch = 0;
    if (state.fly) {
      state.fly = false;
      camera.far = 2000;
      camera.updateProjectionMatrix();
      api.fly = false;
    }
    state.y = groundAt(sp.x, sp.z) + EYE_HEIGHT;
    api.y = state.y;
    toast.show(`→ ${preset.label.toUpperCase()}`);
    try {
      const params = new URLSearchParams(window.location.search);
      params.set('at', trimmed);
      const qs = params.toString();
      history.replaceState(
        null,
        '',
        window.location.pathname + (qs ? `?${qs}` : ''),
      );
    } catch {
      // ignore replaceState failures
    }
    setOverlay(false, false);
    if (!isTouch()) {
      try {
        void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
      } catch {
        // Pointer lock is unavailable.
      }
    }
    relabelMenu();
    return true;
  };

  // Fill `#menu` (pause/settings, landmarks submenu) or clear it (plain enter
  // overlay). The picker's own menu is drawn by `drawCityPicker` and cleared
  // here on boot.
  const setMenu = (mode: 'none' | 'pause' | 'landmarks'): void => {
    if (!(menuRoot instanceof HTMLElement)) return;
    menuRoot.textContent = '';
    menuRoot.classList.remove('landmarks');
    hudBtn = miniBtn = crtBtn = styleBtn = flyBtn = undefined;
    if (mode === 'none') return;
    if (mode === 'landmarks') {
      menuRoot.classList.add('landmarks');
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'menu-btn back';
      back.textContent = '◂ BACK';
      back.addEventListener('click', () => setMenu('pause'));
      menuRoot.append(back);
      // `presetsFor` returns `[key, preset]` in table (insertion) order.
      const list = cityById(cityId)
        ? presetsFor(cityId as 'london' | 'kyiv')
        : [];
      for (const [key, preset] of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'landmark';
        btn.textContent = preset.label;
        btn.addEventListener('click', () => {
          travel(key);
        });
        menuRoot.append(btn);
      }
      return;
    }

    hudBtn = menuButton(labelOnOff('HUD', settings.hud), () => {
      setHudVisible(!settings.hud);
    });
    miniBtn = menuButton(labelOnOff('MINIMAP', settings.minimap), () => {
      setMinimapVisible(!settings.minimap);
    });
    crtBtn = menuButton(labelOnOff('CRT', settings.crt), () => {
      setCrtVisible(!settings.crt);
    });
    styleBtn = menuButton(`STYLE: ${post.style.label} ▸`, () => {
      post.next(1);
      applyStyleChange();
    });
    // `SAVE PNG` / `RECORD GIF (3S)` (T-0072/T-0073). Touch users have no
    // `P` / `Shift+P`, so the pause menu carries both; each dismisses the
    // overlay the way CLICK TO RESUME does, lets two frames render
    // un-obscured, then runs the same capture path as the keys.
    const savePngBtn = menuButton('SAVE PNG', () => {
      setOverlay(false, false);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => void postcard.snapPng(true)),
      );
    });
    const saveGifBtn = menuButton('RECORD GIF (3S)', () => {
      setOverlay(false, false);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => void postcard.recordGif(true)),
      );
    });
    flyBtn = menuButton(labelOnOff('FLY', state.fly), () => {
      setFly(!state.fly);
    });
    const landmarksBtn = menuButton('LANDMARKS ▸', () => {
      setMenu('landmarks');
    });

    const copyBtn = menuButton('COPY LINK TO HERE', () => {
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
    const switchBtn = menuButton('SWITCH CITY', () => {
      settings.city = null;
      try {
        saveSettings(storage, settings);
      } catch {
        // private mode
      }
      const params = new URLSearchParams(window.location.search);
      params.delete('city');
      params.delete('at');
      const qs = params.toString();
      window.location.href = window.location.pathname + (qs ? `?${qs}` : '');
    });
    const shareInput = document.createElement('input');
    shareInput.id = 'share';
    shareInput.type = 'text';
    shareInput.readOnly = true;
    // Hidden until it holds a URL so the pause menu shows the rows before the
    // player copies for the first time.
    shareInput.hidden = true;
    menuRoot.append(
      hudBtn,
      miniBtn,
      crtBtn,
      styleBtn,
      savePngBtn,
      saveGifBtn,
      flyBtn,
      landmarksBtn,
      copyBtn,
      switchBtn,
      shareInput,
    );
  };
  api.travel = travel;
  setOverlay(false, true);
  overlayEl.addEventListener('click', () => {
    setOverlay(false, false);
    // Pointer lock is unavailable on touch and a rejected request can fire
    // `pointerlockchange` (which would re-show the overlay). Skip it.
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
    try {
      void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
    } catch {
      // Pointer lock is unavailable.
    }
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) setOverlay(true, true);
  });

  const openSettings = (): void => {
    if (pickerOpen) return;
    try {
      document.exitPointerLock();
    } catch {
      // not locked / unsupported
    }
    setOverlay(true, true);
  };

  const gear = document.getElementById('gear');
  if (gear instanceof HTMLElement) {
    // The gear is touch-only: under pointer lock nothing is clickable on
    // desktop and the Esc overlay covers it, so it is redundant there
    // (architecture.md §4.12). `hidden` is the same `display:none` the CSS
    // comment promises; the element stays in the DOM for tests.
    gear.hidden = !touch;
    for (const evt of ['pointerdown', 'mousedown'] as const) {
      gear.addEventListener(evt, (e) => e.stopPropagation());
    }
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettings();
    });
  }

  // `R` cycles the render style (Shift+R backwards); `H`/`M` toggle HUD /
  // minimap. Ignore key repeats. `H`/`M` are ignored while the picker is open.
  // In the LANDMARKS submenu Escape returns to the pause menu (the overlay is
  // already visible, so the browser's own Escape doesn't fire pointerlockchange).
  window.addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    if (
      ev.code === 'Escape' &&
      menuRoot instanceof HTMLElement &&
      menuRoot.classList.contains('landmarks')
    ) {
      setMenu('pause');
      ev.preventDefault();
      return;
    }
    if (ev.code === 'KeyR') {
      post.next(ev.shiftKey ? -1 : 1);
      applyStyleChange();
      return;
    }
    // `P` downloads a postcard PNG; `Shift+P` records a 3 s GIF.
    if (ev.code === 'KeyP') {
      if (ev.shiftKey) void postcard.recordGif(true);
      else void postcard.snapPng(true);
      return;
    }
    if (pickerOpen) return;
    if (ev.code === 'KeyH') setHudVisible(!settings.hud);
    else if (ev.code === 'KeyM') setMinimapVisible(!settings.minimap);
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
    ships.update(dt);

    post.render(scene, camera);
    // Copy the freshly rendered frame out (T-0072) — the canvas is not
    // preserved between frames, so the capture must happen right here.
    postcard.afterRender();

    fpsFrames++;
    fpsElapsed += dt;
    if (fpsElapsed >= FPS_WINDOW_S) {
      api.fps = fpsFrames / fpsElapsed;
      fpsFrames = 0;
      fpsElapsed = 0;
    }

    frameCount++;
    if (frameCount % HUD_INTERVAL === 0) {
      if (settings.hud) {
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
      }
      if (settings.minimap) minimap.update(state);
    }
    if (tags && frameCount % HUD_INTERVAL === 0) {
      tags.update(pickTags(anchors, state.x, state.z), camera, viewW, viewH);
    }

    if (!api.ready) api.ready = true;
  }
  requestAnimationFrame(frame);
}

/**
 * Mount the `#credits` footer from {@link CREDITS} (the only file to edit
 * to rebrand). The whole line is a link; clicks stop so they never hit the
 * canvas or the overlay.
 */
function mountCredits(parent: HTMLElement): HTMLAnchorElement {
  const el = document.createElement('a');
  el.id = 'credits';
  el.href = CREDITS.url;
  el.target = '_blank';
  el.rel = 'noopener';
  const display = CREDITS.url.replace(/^https?:\/\//, '');
  el.textContent = `built by ${CREDITS.author} · ${display}`;
  for (const evt of ['click', 'pointerdown', 'mousedown'] as const) {
    el.addEventListener(evt, (e) => e.stopPropagation());
  }
  parent.append(el);
  return el;
}

/**
 * Create the `#toast` element (styled in `style.css`) and return a `show`
 * helper that displays raw text (e.g. `RENDER: ASCII`, `→ GHERKIN`) for 1.5 s.
 */
function mountToast(): { show(text: string): void } {
  const el = document.createElement('div');
  el.id = 'toast';
  document.body.append(el);
  let timer = 0;
  return {
    show(text: string): void {
      el.textContent = text;
      el.classList.add('show');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.classList.remove('show');
      }, 1500);
    },
  };
}

void main();
