# AsciiCity

A static browser minigame: walk around the City of London in first person,
rendered as coloured ASCII glyphs with a green NAVIGATION HUD. Built with Vite,
TypeScript and three.js; deployed as static files to GitHub Pages.

## Running

```sh
npm run dev        # start the Vite dev server
```

## Tests

```sh
bash .tigerteam/scripts/run-tests.sh   # unit tests (vitest)
npm run check                          # full gate: typecheck + unit + build + e2e
```

## Data

`public/data/city.json` is generated from OpenStreetMap by `npm run fetch-data`
— do not hand-edit it.
