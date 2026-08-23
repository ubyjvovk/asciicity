# AsciiCity

![AsciiCity at Bank junction, facing west along Lombard Street](docs/screenshot.png)

A static browser minigame: walk around the City of London in first person,
rendered as coloured ASCII glyphs with a green NAVIGATION HUD. Built with Vite,
TypeScript and three.js; deployed as static files to GitHub Pages.

## Running

```sh
npm run dev        # start the Vite dev server (http://127.0.0.1:5173)
```

## How to play

Open the served URL, click the `CLICK TO ENTER` overlay to enter the world;
the browser will grab pointer lock so mouse movement steers the view. Press
`Escape` to release the pointer — a smaller `CLICK TO RESUME` overlay lets you
re-enter.

- `W` / `↑` — forward, `S` / `↓` — back
- `A` / `D` — strafe left / right
- `←` / `→` — turn left / right
- `Shift` — sprint
- Mouse — look

URL parameters (documented in [`docs/integration.md`](docs/integration.md)):

- `?synthetic=1` — skip `city.json` and use the deterministic synthetic grid.
- `?seed=N` — seed passed to `syntheticCity(seed)`.
- `?cell=WxH` — override the ASCII cell size in pixels, e.g. `?cell=8x16`.
- `?crt=0` — disable the CRT scanline / vignette overlay (on by default).
- `?minimap=0` — disable the heading-up minimap under the HUD rows (on by default).

The NAVIGATION panel shows SECTOR, WORLD position, BEARING with 8-way
compass, ZONE (nearest named road or place), LANDMARK (named building in
view, or `-`), FPS (1 s moving average), and a heading-up minimap of nearby
streets.

## Tests

```sh
bash .tigerteam/scripts/run-tests.sh   # unit tests (vitest)
npm run check                          # full gate: typecheck + unit + build + e2e
```

## Data

`public/data/city.json` is generated from OpenStreetMap by `npm run fetch-data`
— do not hand-edit it.
