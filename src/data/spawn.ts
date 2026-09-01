/**
 * Spawn presets and coordinates for `?at=` (docs/integration.md §URL
 * parameters). Pure module: resolves an `?at=` value to a local-metre
 * spawn point, projecting WGS84 presets/coordinates relative to the city
 * origin, and resolving named-building presets against the dataset via
 * `landmarkSpawn`. No DOM/WebGL.
 */
import type { CityData, LandmarkEntry, Vec2 } from './types';
import { project } from '../geo';

/** Resolved spawn pose in local metres: `x` east, `z` south, yaw in radians. */
export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
}

/**
 * A named spawn preset scoped to a single city. Either a fixed WGS84 position
 * facing `bearingDeg`, or a named building matched against the dataset
 * (`{ building }`) — the building form may carry its own fallback coordinate
 * used when the building is absent from the current dataset.
 */
export type SpawnPreset =
  | { building: string; label: string; city: 'london' | 'kyiv' | 'sf' | 'nyc' | 'tokyo' | 'sydney'; lon?: number; lat?: number; bearingDeg?: number }
  | { lon: number; lat: number; bearingDeg: number; label: string; city: 'london' | 'kyiv' | 'sf' | 'nyc' | 'tokyo' | 'sydney' };

/** Named spawn presets keyed by lower-case name (used by `?at=<name>`). */
export const SPAWN_PRESETS: Record<string, SpawnPreset> = {
  bank: { lon: -0.0887, lat: 51.5133, bearingDeg: 270, label: 'Bank junction', city: 'london' },
  // Named-building presets: `landmarkSpawn` finds the building and picks a
  // road vertex scaled by the building's height, facing it.
  stpauls: { building: "St Paul's Cathedral", label: "Facing St Paul's Cathedral", city: 'london' },
  gherkin: { building: '30 St Mary Axe', label: 'Facing the Gherkin', city: 'london' },
  monument: { building: 'Monument', label: 'Facing the Monument', city: 'london' },
  tower: { building: 'Tower of London', label: 'Facing the Tower of London', city: 'london' },
  barbican: { building: 'Barbican', label: 'Facing the Barbican', city: 'london' },
  liverpoolst: { building: 'Liverpool Street', label: 'Facing Liverpool Street', city: 'london' },
  leadenhall: { building: 'Leadenhall Market', label: 'Facing Leadenhall Market', city: 'london' },
  walkietalkie: {
    building: '20 Fenchurch Street',
    label: 'Facing the Walkie Talkie',
    city: 'london',
  },
  lloyds: { building: "Lloyd's", label: "Facing Lloyd's", city: 'london' },
  // Fixed coordinate presets (places, not resolvable single buildings).
  bigben: {
    lon: -0.12235,
    lat: 51.50085,
    bearingDeg: 268,
    label: 'Westminster Bridge, facing Big Ben',
    city: 'london',
  },
  parliament: {
    lon: -0.12655,
    lat: 51.5006,
    bearingDeg: 90,
    label: 'Parliament Square, facing the Palace of Westminster',
    city: 'london',
  },
  trafalgar: {
    building: "Nelson's Column",
    city: 'london',
    label: "Trafalgar Square, facing Nelson's Column",
    lon: -0.128,
    lat: 51.5079,
    bearingDeg: 180,
  },
  embankment: {
    lon: -0.122,
    lat: 51.5074,
    bearingDeg: 120,
    label: 'Victoria Embankment, facing the London Eye',
    city: 'london',
  },
  // Kyiv presets (wave 7, docs/integration.md §Kyiv presets). Building
  // presets resolve against `applyLandmarks(kyiv.json)` and keep their
  // previous coordinates as fallback when the name goes missing upstream.
  maidan: {
    lon: 30.524,
    lat: 50.45,
    bearingDeg: 250,
    label: 'Maidan Nezalezhnosti, facing Hotel Ukraina',
    city: 'kyiv',
  },
  sophia: {
    building: 'Saint Sophia Cathedral',
    label: 'Facing Saint Sophia Cathedral',
    city: 'kyiv',
    lon: 30.5165,
    lat: 50.453,
    bearingDeg: 270,
  },
  michael: {
    building: 'St. Michael Golden-Domed Cathedral',
    label: "Facing St. Michael's Golden-Domed Cathedral",
    city: 'kyiv',
    lon: 30.521,
    lat: 50.4553,
    bearingDeg: 60,
  },
  andriyivskyy: {
    building: "Saint Andrew's Church",
    label: "Top of Andriyivskyy Descent, facing St Andrew's Church",
    city: 'kyiv',
    lon: 30.5165,
    lat: 50.4586,
    bearingDeg: 40,
  },
  lavra: {
    building: 'Great Lavra Belltower',
    label: 'Pechersk Lavra, facing the Great Bell Tower',
    city: 'kyiv',
    lon: 30.556,
    lat: 50.435,
    bearingDeg: 100,
  },
  motherland: {
    building: 'Motherland Monument',
    label: 'Facing the Motherland Monument',
    city: 'kyiv',
    lon: 30.561,
    lat: 50.4275,
    bearingDeg: 135,
  },
  goldengate: {
    building: 'Golden Gate',
    label: 'Facing the Golden Gate',
    city: 'kyiv',
    lon: 30.5133,
    lat: 50.4485,
    bearingDeg: 20,
  },
  rada: {
    building: 'Verkhovna Rada of Ukraine',
    label: 'Facing the Verkhovna Rada of Ukraine',
    city: 'kyiv',
    lon: 30.5373,
    lat: 50.4471,
    bearingDeg: 260,
  },
  volodymyr: {
    building: "St. Volodymyr's Cathedral",
    label: "Facing St. Volodymyr's Cathedral",
    city: 'kyiv',
    lon: 30.5085,
    lat: 50.4449,
    bearingDeg: 180,
  },
  arch: {
    building: 'Arch of Freedom of the Ukrainian people',
    label: 'Facing the Arch of Freedom',
    city: 'kyiv',
    lon: 30.5304,
    lat: 50.4549,
    bearingDeg: 250,
  },
  olimpiyskiy: {
    building: 'Olympic National Sports Complex Stadium',
    label: 'Facing the Olympic Stadium',
    city: 'kyiv',
    lon: 30.5168,
    lat: 50.4333,
    bearingDeg: 100,
  },
  nicholas: {
    building: 'St. Nicholas Cathedral',
    label: 'Facing St. Nicholas Cathedral',
    city: 'kyiv',
    lon: 30.5176,
    lat: 50.4257,
    bearingDeg: 180,
  },
  bessarabka: {
    building: 'Bessarabskyi market',
    label: 'Bessarabska Square, looking down Khreshchatyk',
    city: 'kyiv',
    lon: 30.5209,
    lat: 50.442,
    bearingDeg: 0,
  },
  podil: {
    lon: 30.517,
    lat: 50.465,
    bearingDeg: 180,
    label: 'Kontraktova Square, Podil',
    city: 'kyiv',
  },
  arsenalna: {
    lon: 30.5455,
    lat: 50.4443,
    bearingDeg: 90,
    label: 'Arsenalna, the deepest metro station',
    city: 'kyiv',
  },
  parkbridge: {
    lon: 30.5324,
    lat: 50.45498,
    bearingDeg: 33,
    label: 'Parkovyi Bridge, facing Trukhaniv Island',
    city: 'kyiv',
  },
  glassbridge: {
    lon: 30.52974,
    lat: 50.45489,
    bearingDeg: 286,
    label: 'Klitschko glass bridge, facing the Arch',
    city: 'kyiv',
  },
  funicular: {
    lon: 30.5231,
    lat: 50.4592,
    bearingDeg: 210,
    label: 'Funicular lower station, looking up',
    city: 'kyiv',
  },
  hydropark: {
    lon: 30.577,
    lat: 50.4459,
    bearingDeg: 270,
    label: 'Hydropark, facing the right-bank hills',
    city: 'kyiv',
  },
  metrobridge: {
    lon: 30.56,
    lat: 50.4423,
    bearingDeg: 90,
    label: 'Metro Bridge over the Dnipro',
    city: 'kyiv',
  },
  // San Francisco presets (wave 8, docs/integration.md §San Francisco
  // presets). Building presets resolve against `applyLandmarks(sf.json)` and
  // keep their fallback coordinates when a name goes missing upstream.
  ggb: {
    // Wave 9 (architecture.md §4.13 (c)): re-aimed at the east sidewalk
    // 260 m south of the south tower (snapped onto the East Sidewalk line,
    // as the previous mid-span preset was), facing north along the deck at
    // the south tower.
    lon: -122.477472,
    lat: 37.811672,
    bearingDeg: 355,
    label: 'Golden Gate Bridge deck, facing the south tower',
    city: 'sf',
  },
  alcatraz: {
    // Fixed-coordinate preset ON the island beside the lighthouse (parity
    // rule, §4.6 makes the island walkable), bearing 150° toward the city.
    // NOTE (T-0079 reconciliation): the PM's spec was a *building* preset
    // on 'Alcatraz Island Lighthouse'. On this data that resolves via
    // `landmarkSpawn` to the island's low shore road (the lighthouse's
    // view-corridor rule rejects high ground near it, leaving only low
    // road vertices), giving y ≈ −2.4 — below the mandated e2e y > 5.
    // The PM's own fallback coordinate (below) resolves to y ≈ 16.9 (≈ the
    // PM's "lighthouse ~40 m ASL → y ≈ 15"), so we use it as a fixed
    // coordinate preset. See the Worker report.
    lon: -122.4222,
    lat: 37.8262,
    bearingDeg: 150,
    label: 'Alcatraz Island, by the lighthouse',
    city: 'sf',
  },
  transamerica: {
    building: 'Transamerica Pyramid',
    label: 'Facing the Transamerica Pyramid',
    city: 'sf',
    lon: -122.4026,
    lat: 37.7952,
    bearingDeg: 270,
  },
  salesforce: {
    building: 'Salesforce Tower',
    label: 'Facing Salesforce Tower',
    city: 'sf',
    lon: -122.397,
    lat: 37.7898,
    bearingDeg: 180,
  },
  coittower: {
    building: 'Coit Tower',
    label: 'Facing Coit Tower',
    city: 'sf',
    lon: -122.4058,
    lat: 37.8024,
    bearingDeg: 180,
  },
  ferrybuilding: {
    building: 'San Francisco Ferry Building',
    label: 'Facing the Ferry Building',
    city: 'sf',
    lon: -122.3934,
    lat: 37.7955,
    bearingDeg: 315,
  },
  paintedladies: {
    lon: -122.433,
    lat: 37.7765,
    bearingDeg: 75,
    label: 'Alamo Square, facing the Painted Ladies row',
    city: 'sf',
  },
  lombard: {
    lon: -122.4187,
    lat: 37.8021,
    bearingDeg: 100,
    label: 'Top of the Lombard crooked block, facing down',
    city: 'sf',
  },
  pier39: {
    lon: -122.4103,
    lat: 37.8087,
    bearingDeg: 0,
    label: 'Pier 39, out toward Alcatraz',
    city: 'sf',
  },
  unionsquare: {
    lon: -122.4075,
    lat: 37.788,
    bearingDeg: 315,
    label: 'Union Square, facing downtown',
    city: 'sf',
  },
  // Manhattan presets (wave 10, docs/integration.md §Manhattan presets).
  // Default spawn: `brooklynbridge` — snapped onto the "Brooklyn Bridge
  // Promenade" pedestrian walkway at mid-span between the two towers,
  // facing Manhattan (NW). Landmark buildings resolve against
  // `applyLandmarks(nyc.json)` via `landmarkSpawn` with their own coord
  // fallback in case an OSM name changes upstream. Coordinate presets sit at
  // the named intersections/squares. The SF `unionsquare` key already exists,
  // so Union Square Manhattan is `unionsquarenyc`.
  brooklynbridge: {
    // Mid-span between the two OSM pylon centroids (ways 317352708 /
    // 1255363983), snapped onto the "Brooklyn Bridge Promenade" line,
    // facing Manhattan along the deck (bearing 316°). Deck humps (T-0088)
    // put this station at ~41 m ASL.
    lon: -73.996345,
    lat: 40.705685,
    bearingDeg: 316,
    label: 'Brooklyn Bridge Promenade, facing Manhattan',
    city: 'nyc',
  },
  manhattanbridge: {
    lon: -73.989649,
    lat: 40.705101,
    bearingDeg: 337,
    label: 'Manhattan Bridge south walkway, facing Manhattan',
    city: 'nyc',
  },
  timessquare: {
    lon: -73.9855,
    lat: 40.758,
    bearingDeg: 20,
    label: 'Times Square, facing north up Broadway',
    city: 'nyc',
  },
  unionsquarenyc: {
    lon: -73.9905,
    lat: 40.7359,
    bearingDeg: 0,
    label: 'Union Square, Manhattan',
    city: 'nyc',
  },
  batterypark: {
    lon: -74.0155,
    lat: 40.7033,
    bearingDeg: 45,
    label: 'Battery Park, facing the Downtown skyline',
    city: 'nyc',
  },
  dumbo: {
    // Washington Street at Water Street, DUMBO — north up Washington St
    // so the Manhattan Bridge tower fills the frame (T-0090 re-aim).
    lon: -73.9896,
    lat: 40.7033,
    bearingDeg: 350,
    label: 'DUMBO, Manhattan Bridge framing the skyline',
    city: 'nyc',
  },
  empirestate: {
    // Re-aimed (T-0090) as a fixed coordinate in the middle of 5th Avenue
    // at 38th Street — on the avenue centre-line, facing down it (bearing
    // 200°) toward the tower at the end of the canyon.
    lon: -73.98284,
    lat: 40.7508,
    bearingDeg: 200,
    label: 'Facing the Empire State Building',
    city: 'nyc',
  },
  chrysler: {
    building: 'Chrysler Building',
    label: 'Facing the Chrysler Building',
    city: 'nyc',
    lon: -73.9754,
    lat: 40.7515,
    bearingDeg: 270,
  },
  onewtc: {
    building: 'One World Trade Center',
    label: 'Facing One World Trade Center',
    city: 'nyc',
    lon: -74.0134,
    lat: 40.7127,
    bearingDeg: 315,
  },
  flatiron: {
    building: 'Flatiron Building',
    label: 'Facing the Flatiron Building',
    city: 'nyc',
    lon: -73.99,
    lat: 40.7405,
    bearingDeg: 0,
  },
  woolworth: {
    building: 'Woolworth Building',
    label: 'Facing the Woolworth Building',
    city: 'nyc',
    lon: -74.008,
    lat: 40.7124,
    bearingDeg: 315,
  },
  rockefeller: {
    building: '30 Rockefeller Plaza',
    label: 'Facing 30 Rockefeller Plaza',
    city: 'nyc',
    lon: -73.9787,
    lat: 40.7583,
    bearingDeg: 315,
  },
  stpatricks: {
    building: 'Saint Patrick’s Cathedral',
    label: "Facing St. Patrick's Cathedral",
    city: 'nyc',
    lon: -73.9762,
    lat: 40.7585,
    bearingDeg: 270,
  },
  grandcentral: {
    building: 'Grand Central Terminal',
    label: 'Facing Grand Central Terminal',
    city: 'nyc',
    lon: -73.9772,
    lat: 40.7526,
    bearingDeg: 315,
  },
  centralpark: {
    lon: -73.9738,
    lat: 40.7645,
    bearingDeg: 289,
    label: 'Grand Army Plaza, facing Central Park Tower',
    city: 'nyc',
  },
  wallstreet: {
    lon: -74.0107,
    lat: 40.7075,
    bearingDeg: 270,
    label: 'Wall Street, facing Trinity Church',
    city: 'nyc',
  },
  washingtonsquare: {
    building: 'Washington Square Arch',
    label: 'Washington Square Park, facing the Arch',
    city: 'nyc',
    lon: -73.99734,
    lat: 40.731,
    bearingDeg: 0,
  },
  // Tokyo presets (wave 11, docs/integration.md §Tokyo presets). Coordinates
  // were DERIVED FROM the committed dataset (T-0098): each fixed-coordinate
  // preset sits on an unblocked road vertex read out of the relevant tile
  // files (`index.landmarks` anchors + tile road polylines), unprojected to
  // WGS84, with the bearing aimed at the named landmark/tower. The two tower
  // presets are building-based: `landmarkSpawn` resolves them against
  // `applyLandmarks(tokyo/index.json)` and the anchor's `index.landmarks`
  // entry, picking a road vertex that keeps a clear view corridor and faces
  // the tower's centroid (street vantages LOOKING AT the tower, not points
  // inside its footprint). Default spawn: `tokyostation`.
  skytree: {
    // Street vantage 795 m E of the tower (road vertex in tile 4_-3) on the
    // north bank of the Kita-Jūkken-gawa canal in Sumida Ward, bearing 286°
    // straight at the tower anchor (3944.0, −3189.6). This is the only
    // 550–900 m band vertex around the tower with a completely clean
    // buildings-only sightline (mechanical rule from PM rework attempt 5) —
    // the PM's suggested west/SW-across-the-Sumida vantages are all blocked
    // by the dense Oshiage/Asakusa buildings between the tower base
    // (Solamachi extends 90 m west of the anchor) and any 550–900 m road
    // vertex on the postcard side. The east-side vantage still frames the
    // 634 m tower well: at 795 m the tower rises ≈ 39° above horizon,
    // dominating the frame without wall-fill. Tokyo is streamed-only and the
    // tiled boot resolves spawns from `index.landmarks` before any tile
    // fetch (§4.19) — so this coordinate is the REAL spawn: a walkable road
    // vertex facing the tower, not a point inside its footprint.
    building: 'Tokyo Skytree',
    label: 'Facing the Tokyo Skytree',
    city: 'tokyo',
    lon: 139.819167,
    lat: 35.708042,
    bearingDeg: 286,
  },
  tokyotower: {
    // Street vantage 150 m west of the tower (road vertex in tile −2_2),
    // bearing 271° straight at the tower anchor.
    building: 'Tokyo Tower',
    label: 'Facing Tokyo Tower',
    city: 'tokyo',
    lon: 139.747091,
    lat: 35.658438,
    bearingDeg: 271,
  },
  tokyostation: {
    // Road vertex 20 m from the station building anchor (index.landmarks
    // 'Tokyo Station' at −47.6, −201.3), bearing 231 toward the station.
    lon: 139.766744,
    lat: 35.683134,
    bearingDeg: 231,
    label: 'Tokyo Station, facing the station',
    city: 'tokyo',
  },
  ginza: {
    // Road vertex 6 m from the Ginza Crossing place, bearing 72 toward it.
    lon: 139.764968,
    lat: 35.671201,
    bearingDeg: 72,
    label: 'Ginza Crossing, facing up Chuo Dori',
    city: 'tokyo',
  },
  akihabara: {
    // Road vertex 112 m from the 'Akihabara' building anchor (tile 0_-2),
    // bearing 222° straight at it.
    building: 'Akihabara',
    label: 'Facing Akihabara',
    city: 'tokyo',
    lon: 139.77429,
    lat: 35.699287,
    bearingDeg: 222,
  },
  imperialpalace: {
    // Road vertex on the plaza ring road 62 m from the Imperial Palace
    // Frontal Plaza place, bearing 296 toward the palace grounds.
    lon: 139.757616,
    lat: 35.679583,
    bearingDeg: 296,
    label: 'Imperial Palace plaza, facing the palace',
    city: 'tokyo',
  },
  sumida: {
    // Sakurabashi-dōri road vertex 435 m NE of the tower (tile 4_-4),
    // bearing 241° straight at the tower anchor. The PM's post-review rule
    // requires a clean buildings-only sightline (no foreground wall filling
    // the frame — the old riverside spot's ray crossed Solamachi from k=200
    // through k=330 m, the purple mass). The Sumida-west-bank vantages that
    // face Skytree straight across the river all cross Solamachi (which
    // extends 90 m west of the anchor) or the dense Oshiage buildings, so
    // no strict-riverside 300–500 m road vertex passes the sightline test.
    // Sakurabashi-dōri (`桜橋通り`) is the Sumida-Ward street that runs to
    // Sakura-bashi (the pedestrian bridge over the Sumida) — 270 m south of
    // the Kita-Jūkken-gawa canal (water 189) and about 500 m east of the
    // Sumida itself. It approaches the tower from the north-east so the
    // ray never crosses Solamachi.
    lon: 139.814942,
    lat: 35.711931,
    bearingDeg: 241,
    label: 'Sakurabashi-dōri, facing the Skytree',
    city: 'tokyo',
  },
  // Wave 12 west-Tokyo presets (T-0103), derived from the bbox v2 dataset
  // (T-0102). Both sit on a road vertex read out of the vertex's 3×3 tiles
  // (`Shibuya` / `Shinjuku` index.landmarks anchor), unprojected to WGS84;
  // walkability proven on a 3×3-tile CollisionGrid.
  shibuya: {
    // Jingu-dori Street (神宮通り) tertiary road vertex on the Shibuya
    // Scramble Crossing (6.8 m from the geographic crossing at 35.6595 N,
    // 139.7005 E; tile −7_2). 115.3 m from the `Shibuya` index.landmarks
    // anchor at (−5935.9, 2503.1) — a "north of Shibuya Station" street
    // vantage on the world-famous scramble, well inside the ticket's 120 m
    // Hachiko-exit bound. Bearing 315° (NW) looks across the crossing into
    // the Center-gai building wall (Q-FRONT / center-gai storefronts on the
    // NW corner of the intersection). 8 m of building clearance on the 3×3
    // tiles centred on −7_2 (two of the nine tiles — −8_1 and −8_3 — are
    // beyond the v2 bbox west edge and correctly absent).
    lon: 139.700573,
    lat: 35.659317,
    bearingDeg: 315,
    label: 'Shibuya Scramble Crossing, facing Center-gai',
    city: 'tokyo',
  },
  shinjuku: {
    // Pedestrian-street road vertex 144.3 m east of the `Shinjuku`
    // index.landmarks anchor at (−6063.1, −938.3) — tile −6_−1, on the
    // east side of Shinjuku Station's East Exit block. Bearing 30° (NNE)
    // faces into Kabukicho (Kabukicho centre ≈ (−5817, −1468) is 526 m
    // NNE, Godzilla-head bearing from here ≈ 7°; the 30° bearing rounds
    // toward the north-east district as the ticket names it). 6 m of
    // building clearance on the 3×3 tiles centred on −6_−1 (all nine tiles
    // present).
    lon: 139.701643,
    lat: 35.689713,
    bearingDeg: 30,
    label: 'Shinjuku East Exit, facing Kabukicho',
    city: 'tokyo',
  },
  // Sydney presets (wave 14, docs/architecture.md §4.13 wave-14 table). All
  // coordinates are DERIVED FROM the committed tiled Sydney dataset (T-0116
  // refetch) — never hand-typed. For each preset a road vertex was picked
  // out of the tile files and unprojected to WGS84 (via the origin
  // 151.2110,-33.8613), each one passing the T-0059 clear-corridor rule
  // (`blocked(pt + k·forward, 1.5) === false` for k = 4…40 m); the five view
  // presets (`circularquay`, `operahouse`, `harbourbridge`, `mrsmacquarie`,
  // `lunapark`) additionally pass a buildings-only sightline test (ray
  // sampled every 10 m, `blocked(pt, 2) === false` — T-0098 pattern; water
  // is not a blocker so sightlines across the cove/harbour survive) to
  // their subject (Opera House anchor for four of them; Sydney Tower anchor
  // for `harbourbridge`; Circular Quay place anchor for `lunapark`). Default
  // spawn: `circularquay`.
  circularquay: {
    // Circular Quay West promenade / service road vertex at (-96.5, -436.0),
    // 71 m south of the ticket-suggested `151.2100,-33.8580` vantage (which
    // itself falls inside a building footprint — the pier terminal). Bearing
    // 84° across the cove to the Sydney Opera House anchor at (377.2,
    // -489.2), 477 m away — the postcard "Opera House across Sydney Cove"
    // shot, corridor + sightline clean.
    lon: 151.209956,
    lat: -33.857357,
    bearingDeg: 84,
    label: 'CIRCULAR QUAY',
    city: 'sydney',
  },
  operahouse: {
    // Building preset: `landmarkSpawn` resolves against the OSM outline
    // (T-0116 relation-assembly landed it; h 18.5 podium — the sails come
    // in T-0114). The picked vertex is Cahill Walk at (294.9, -375.9),
    // 140 m from the centroid, facing 36° at the podium. Fallback coord =
    // that same lon/lat/bearing in case the outline goes missing upstream.
    building: 'Sydney Opera House',
    label: 'Facing the Sydney Opera House',
    city: 'sydney',
    lon: 151.214190,
    lat: -33.857900,
    bearingDeg: 36,
  },
  harbourbridge: {
    // Cahill Walk (the eastern pedestrian walkway on the Harbour Bridge
    // deck) vertex at (114.3, -1224.8), ~45 m from the ticket-suggested
    // `151.2111,-33.8503` mid-span target. Bearing 188° faces south along
    // the deck at the Sydney Tower anchor (2.3 km SSW — the CBD skyline
    // fills the frame). The Harbour Bridge deck humps (T-0112, deckApexASL
    // 49) put the player at y ≈ 45–50 m ASL here.
    lon: 151.212236,
    lat: -33.850223,
    bearingDeg: 188,
    label: 'Harbour Bridge east walkway, facing the CBD skyline',
    city: 'sydney',
  },
  mrsmacquarie: {
    // Mrs Macquarie's Point pedestrian path vertex at (1006.5, -207.6),
    // 85 m from the ticket-suggested `151.2222,-33.8587` centre. Bearing
    // 294° WNW toward the Opera House anchor 689 m across Farm Cove — the
    // postcard: Opera House framed with the Harbour Bridge behind (both
    // are aligned along this bearing from Mrs Macquarie's Chair, T-0110).
    lon: 151.221888,
    lat: -33.859423,
    bearingDeg: 294,
    label: "Mrs Macquarie's Point, facing the Opera House and bridge",
    city: 'sydney',
  },
  lunapark: {
    // Fitzroy Street (Milsons Point) tertiary road vertex at (86.5,
    // -1528.1), 55 m NE of the `Milsons Point` place anchor. Bearing 184°
    // south across Sydney Cove toward the Circular Quay place anchor
    // 1.54 km away — the harbour + CBD + Harbour Bridge all fill the frame
    // (Luna Park itself is not an OSM building in the shipped bbox, so the
    // preset is fixed-coordinate rather than building-based).
    lon: 151.211936,
    lat: -33.847480,
    bearingDeg: 184,
    label: 'Milsons Point boardwalk, facing the harbour and CBD',
    city: 'sydney',
  },
  therocks: {
    // Pedestrian street vertex in The Rocks at (-220.9, -139.7), 27 m NE
    // of the `The Rocks` place anchor. Bearing 30° NNE up the historic
    // sandstone alleys of the Argyle/Playfair district.
    lon: 151.208610,
    lat: -33.860037,
    bearingDeg: 30,
    label: 'The Rocks, historic sandstone alleys',
    city: 'sydney',
  },
  barangaroo: {
    // Barangaroo waterfront: service road vertex at (-878.0, 66.7), 57 m
    // south of the `Barangaroo` place anchor. Bearing 2° due north along
    // the Barangaroo Reserve headland toward the harbour.
    lon: 151.201502,
    lat: -33.861903,
    bearingDeg: 2,
    label: 'Barangaroo Reserve, facing the harbour',
    city: 'sydney',
  },
  darlingharbour: {
    // Cockle Bay Wharf pedestrian vertex at (-803.7, 1050.8) — the eastern
    // promenade of Darling Harbour. Bearing 0° due north up Cockle Bay
    // toward Pyrmont Bridge and the CBD skyline.
    lon: 151.202306,
    lat: -33.870803,
    bearingDeg: 0,
    label: 'Darling Harbour, Cockle Bay Wharf',
    city: 'sydney',
  },
  botanicgarden: {
    // Royal Botanic Garden interior pedestrian path (Carrick Chambers
    // Bridge) at (583.0, 310.2), just south of the Bennelong Lawn cluster.
    // Bearing 90° due east through the garden groves.
    lon: 151.217307,
    lat: -33.864105,
    bearingDeg: 90,
    label: 'Royal Botanic Garden',
    city: 'sydney',
  },
  kingscross: {
    // Victoria Street (Kings Cross residential) vertex at (1041.3, 1461.4),
    // 4 m from the `Kings Cross` place anchor. Bearing 360° north along
    // Victoria Street toward the Coca-Cola Billboard corner.
    lon: 151.222265,
    lat: -33.874516,
    bearingDeg: 0,
    label: 'Kings Cross, Victoria Street',
    city: 'sydney',
  },
  centralstation: {
    // Service road vertex 4 m from the `Central Station's Chalmers Street
    // entrance` landmark anchor at (-391.7, 2333.1). Bearing 0° north up
    // Chalmers Street toward the station colonnade.
    lon: 151.206763,
    lat: -33.882400,
    bearingDeg: 0,
    label: 'Central Station, Chalmers Street entrance',
    city: 'sydney',
  },
  northsydney: {
    // Miller Street (North Sydney CBD secondary road) vertex at (-320.8,
    // -2846.4), 72 m from the `North Sydney` place anchor. Bearing 167°
    // south along Miller Street toward the Harbour Bridge and the CBD
    // skyline 1.4 km away.
    lon: 151.207530,
    lat: -33.835558,
    bearingDeg: 167,
    label: 'North Sydney, Miller Street facing the CBD',
    city: 'sydney',
  },
};

/**
 * All presets belonging to a city id, as `[key, preset]` pairs in
 * `SPAWN_PRESETS` insertion (table) order. Used by the fast-travel menu
 * (architecture.md §4.13) and by tests to prove the per-city fence.
 */
export function presetsFor(cityId: string): [string, SpawnPreset][] {
  return Object.entries(SPAWN_PRESETS)
    .filter(([, p]) => p.city === cityId)
    .map(([k, v]) => [k, v]);
}

/** Clamp `x` into `[lo, hi]`. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Maximum +x offset (metres) the spawn search scans when the point is blocked. */
const SPAWN_MAX = 200;

/** Min clearance (metres) a `landmarkSpawn` road vertex must keep from buildings. */
const CLEARANCE = 6;

/** Widest radius (metres) a `landmarkSpawn` fallback road vertex may sit from the centroid. */
const LANDMARK_FALLBACK = 300;

/** Corridor sample spacing (metres) ahead of a spawn vertex toward its target. */
const CORRIDOR_STEP = 4;

/** Furthest corridor distance (metres) a spawn vertex must stay clear to its target. */
const CORRIDOR_LIMIT = 40;

/** Corridor probe radius (metres) kept clear of buildings along each sample. */
const CORRIDOR_R = 1.5;

/**
 * True when the view corridor from `pt` toward the target is clear: for
 * `k = 4, 8, …, 40` the point `pt + k·(sin yaw, −cos yaw)` (yaw faces the
 * centroid) is not blocked with `CORRIDOR_R` clearance. A spawn with a wall
 * close ahead fills the frame (an 8.6 m building 6 m away already blocks a
 * 70° view), so road vertices must keep a clear corridor as well as a clear
 * footprint. Returns true when `blocked` is undefined.
 */
function corridorClear(
  pt: Vec2,
  yaw: number,
  blocked?: (p: Vec2, r?: number) => boolean,
): boolean {
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  for (let k = CORRIDOR_STEP; k <= CORRIDOR_LIMIT; k += CORRIDOR_STEP) {
    const q: Vec2 = [pt[0] + k * fx, pt[1] + k * fz];
    if (blocked?.(q, CORRIDOR_R) ?? false) return false;
  }
  return true;
}

/** Parameter type for `resolveSpawn`'s `city` argument (bbox is optional for tests). */
type SpawnCity = Pick<CityData, 'buildings' | 'roads'> &
  Partial<Pick<CityData, 'bbox'>> & {
    /** Tiled-index anchors; first matching `name` wins (architecture.md §4.19). */
    landmarks?: readonly LandmarkEntry[];
  };

/**
 * Parse an `?at=` value. `null`/empty → `null`; a preset name (trimmed,
 * case-insensitive) → `{ preset }`; `lon,lat[,bearing]` finite numbers →
 * the coordinates; anything else → `null`.
 */
export function parseAt(
  param: string | null,
): { preset?: string; lon?: number; lat?: number; bearingDeg?: number } | null {
  if (param === null) return null;
  const trimmed = param.trim();
  if (trimmed === '') return null;
  const key = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SPAWN_PRESETS, key)) {
    return { preset: key };
  }
  const parts = trimmed.split(',');
  if (parts.length < 2 || parts.length > 3) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const out: { lon: number; lat: number; bearingDeg?: number } = { lon, lat };
  if (parts.length === 3) {
    const bearingDeg = Number(parts[2]);
    if (!Number.isFinite(bearingDeg)) return null;
    out.bearingDeg = bearingDeg;
  }
  return out;
}

/** Wrap `a` into `(−π, π]`, so e.g. 3π/2 becomes −π/2. */
function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

/**
 * Resolve a named building to a spawn point ~`targetDist` metres away on a
 * road vertex, facing the building centroid. An **exact** (case-insensitive)
 * name match is preferred before a substring (`includes`) match; when several
 * buildings share the exact name, an extra (`id ≤ −1000`) wins over an OSM
 * footprint (Nelson's Column is both a 6 m plinth and a 52 m extra). When
 * `city.landmarks` is present (tiled `index.landmarks`), the **first** matching
 * `{name, x, z}` entry supplies the centroid — first-entry-wins, so a later
 * duplicate name is ignored. The default target distance scales with the
 * target's height: `clamp(70 + 1.2·h, 70, 220)` (`h = 0` when only an anchor
 * is known). Returns the candidate road vertex from every road polyline (all
 * classes) whose distance from the centroid lies in
 * `[targetDist − 40, targetDist + 60]` with the smallest `|dist − targetDist|`;
 * if none, any corridor-clear vertex within 300 m. Every candidate must pass
 * **both** a 6 m footprint clearance (`blocked(pt, 6) === false`) and a clear
 * view corridor toward the centroid (`blocked(pt + k·forward, 1.5) === false`
 * for `k = 4…40 m`) so the spawn never sits inside a building nor against a
 * wall that fills the frame; when no candidate survives, `null` is returned
 * (the caller falls back to a fixed coordinate). Returns `null` when the
 * building is unnamed/absent. Yaw faces the centroid via
 * `atan2(c.x − p.x, −(c.z − p.z))` (consistent with forward
 * `(sin yaw, −cos yaw)`).
 */
export function landmarkSpawn(
  name: string,
  city: Pick<CityData, 'buildings' | 'roads'> & {
    landmarks?: readonly LandmarkEntry[];
  },
  targetDist?: number,
  blocked?: (p: Vec2, r?: number) => boolean,
): SpawnPoint | null {
  const needle = name.toLowerCase();
  // Tiled anchors: first exact match, else first substring; first-entry wins.
  let cx: number | undefined;
  let cz: number | undefined;
  if (city.landmarks !== undefined) {
    let anchor: LandmarkEntry | undefined;
    for (const a of city.landmarks) {
      if (a.name.toLowerCase() === needle) {
        anchor = a;
        break;
      }
    }
    if (!anchor) {
      for (const a of city.landmarks) {
        if (a.name.toLowerCase().includes(needle)) {
          anchor = a;
          break;
        }
      }
    }
    if (anchor) {
      cx = anchor.x;
      cz = anchor.z;
    }
  }

  // Exact (case-insensitive) match first, then substring match. An extra
  // (id ≤ −1000) with the same exact name wins over an OSM building.
  const exactMatches = city.buildings.filter(
    (b) => b.name !== undefined && b.name.toLowerCase() === needle,
  );
  const exact = exactMatches.find((b) => b.id <= -1000) ?? exactMatches[0];
  const building =
    exact ??
    city.buildings.find(
      (b) => b.name !== undefined && b.name.toLowerCase().includes(needle),
    );
  if (cx === undefined || cz === undefined) {
    if (!building) return null;
    let sx = 0;
    let sz = 0;
    for (const [x, z] of building.poly) {
      sx += x;
      sz += z;
    }
    const n = building.poly.length;
    cx = sx / n;
    cz = sz / n;
  }
  if (cx === undefined || cz === undefined) return null;
  const distance = targetDist ?? clamp(70 + 1.2 * (building?.h ?? 0), 70, 220);

  // Yaw that faces the target centroid (the same bearing the preset faces).
  const targetYaw = (px: number, pz: number): number =>
    Math.atan2(cx - px, -(cz - pz));

  // A candidate passes iff it keeps 6 m of footprint clearance AND a clear
  // view corridor toward the centroid, so it never spawns inside/against a
  // building nor with a wall filling the frame ahead.
  const accept = (pt: Vec2): boolean =>
    !(blocked?.(pt, CLEARANCE) ?? false) && corridorClear(pt, targetYaw(pt[0], pt[1]), blocked);

  // In-range road vertices passing both checks.
  const inRange: { p: Vec2; dist: number }[] = [];
  for (const road of city.roads) {
    for (const pt of road.pts) {
      const dist = Math.hypot(pt[0] - cx, pt[1] - cz);
      if (dist >= distance - 40 && dist <= distance + 60 && accept(pt)) {
        inRange.push({ p: pt, dist });
      }
    }
  }

  // Fallbacks: no (passing) in-range vertex → any passing vertex within
  // 300 m; still none → null.
  let pool = inRange;
  if (pool.length === 0) {
    pool = [];
    for (const road of city.roads) {
      for (const pt of road.pts) {
        const dist = Math.hypot(pt[0] - cx, pt[1] - cz);
        if (dist <= LANDMARK_FALLBACK && accept(pt)) {
          pool.push({ p: pt, dist });
        }
      }
    }
  }

  if (pool.length === 0) return null;

  let best = pool[0];
  for (const cand of pool) {
    if (Math.abs(cand.dist - distance) < Math.abs(best.dist - distance)) {
      best = cand;
    }
  }

  const [px, pz] = best.p;
  const yaw = Math.atan2(cx - px, -(cz - pz));
  return { x: px, z: pz, yaw };
}

/** True when the WGS84 point sits within `bbox = [minLon, minLat, maxLon, maxLat]`. */
function insideBbox(
  lon: number,
  lat: number,
  bbox: [number, number, number, number],
): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/** Look up the fallback preset and require it to be a fixed-coordinate form. */
function fixedFallback(name: string): {
  lon: number;
  lat: number;
  bearingDeg: number;
} {
  const p = SPAWN_PRESETS[name];
  if (
    !p ||
    'building' in p ||
    !('lon' in p) ||
    !('lat' in p) ||
    typeof p.lon !== 'number' ||
    typeof p.lat !== 'number'
  ) {
    throw new Error(
      `resolveSpawn fallback '${name}' must be a fixed-coordinate preset`,
    );
  }
  return { lon: p.lon, lat: p.lat, bearingDeg: p.bearingDeg };
}

/**
 * Resolve an `?at=` value to a spawn pose. Falls back to the `fallback`
 * preset (default `'bigben'`) when: `param` is `null`/empty/unknown; a
 * named-building preset has no `city` or its building is absent; the
 * resolved WGS84 point lies outside `city.bbox`. A named-building preset
 * that carries its own coordinates uses them (subject to the bbox check)
 * before falling back to the city's fallback preset. Blocked spawn points
 * walk `+x` in 1 m steps up to 200 m. Yaw comes from the bearing (degrees
 * → radians, wrapped to (−π, π]) or from `landmarkSpawn`.
 */
export function resolveSpawn(
  param: string | null,
  origin: { lat: number; lon: number },
  blocked: (p: Vec2) => boolean,
  city?: SpawnCity,
  fallback = 'bigben',
): SpawnPoint {
  const parsed = parseAt(param);
  const preset = parsed?.preset ? SPAWN_PRESETS[parsed.preset] : undefined;

  // Named-building preset: resolve against the dataset when a city is given.
  // `blocked` (with 6 m of clearance) is threaded through to `landmarkSpawn`
  // so the chosen vertex is never inside/against a building.
  if (preset && 'building' in preset && city) {
    const landmark = landmarkSpawn(preset.building, city, undefined, blocked);
    if (landmark) return landmark;
    // Building absent, or no unblocked vertex → fall through to this preset's
    // own fallback coordinate (if any), then to the city's fallback preset
    // (which does walk `+x` when blocked).
  }

  // Coordinates from an explicit `lon,lat[,bearing]`, a fixed-coordinate
  // preset, a hybrid building preset's fallback coord, or the fallback
  // preset. `parseAt` returns either a preset name or coordinates, never both.
  let lon: number | undefined;
  let lat: number | undefined;
  let bearingDeg = 0;
  if (parsed?.lon !== undefined && parsed?.lat !== undefined) {
    lon = parsed.lon;
    lat = parsed.lat;
    bearingDeg = parsed.bearingDeg ?? 0;
  } else if (preset && preset.lon !== undefined && preset.lat !== undefined) {
    lon = preset.lon;
    lat = preset.lat;
    bearingDeg = preset.bearingDeg ?? 0;
  }

  // If we ended up with a coordinate that lies outside the city's bbox, drop
  // it and use the fallback preset instead (which must be fixed-coordinate).
  const bbox = city?.bbox;
  const haveCoord = lon !== undefined && lat !== undefined;
  if (!haveCoord || (bbox && !insideBbox(lon!, lat!, bbox))) {
    const fb = fixedFallback(fallback);
    lon = fb.lon;
    lat = fb.lat;
    bearingDeg = fb.bearingDeg;
  }

  const [x0, z] = project(lon!, lat!, origin);
  let x = x0;
  const probe: Vec2 = [x0, z];
  for (let step = 0; step <= SPAWN_MAX; step++) {
    probe[0] = x0 + step;
    if (!blocked(probe)) {
      x = x0 + step;
      break;
    }
  }
  return { x, z, yaw: normalizeAngle((bearingDeg * Math.PI) / 180) };
}
