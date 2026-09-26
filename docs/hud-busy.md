# Background-loading indicator (`#busy`, T-0171)

After the first-load overlay clears, the game keeps loading in the
background: streamed city tiles, the lazily imported cyberpunk engine, its
layer cells, and the car models. `#busy` shows one retro-terminal line
while any of that is still in flight.

```
⠹ SYNC ▱▰▰▰▱▱▱▱ SECTORS 3 · CARS
```

## Boot phases (T-0174)

`#busy` is also visible from the first paint of the page until
`loading.phase === 'ready'`. `index.html` has a static
`<div id="busy" class="on boot">` with the three spans and the text
`⠋ JACK-IN ▱▱▱▱▱▱▱▱ LINKING NODE`. An inline `<style>` in `index.html` gives
`#busy.boot` its look: position, HUD green, `.neon`, `z-index: 11` above the
`#overlay` (10), and a 0.9 s opacity pulse on the bar. The rules are inline
because `style.css` is only injected by the bundle (in dev, from JS), so it
is not there on the first paint. `BusyView` adopts this element (no duplicate
id) and creates one only if it is missing.

Until `ready`, a boot `requestAnimationFrame` loop in `main.ts` calls
`BusyView.boot(progress, cityLabel, t, neon, visible)`. The pure wording is
`bootParts` / `bootLine` in `busy.ts` (`LoadProgress` from `src/ui/loading.ts`):

| Phase | Line | Bar |
|---|---|---|
| no progress event yet | `⠋ JACK-IN ▱▰▰▰▱▱▱▱ LINKING NODE` | ping-pong |
| city picker waiting | hidden (nothing is loading) | — |
| `download` | `⠹ JACK-IN ▰▰▰▱▱▱▱▱ DOWNLINK 4.2/14.7 MB` | determinate: `floor(received·8/total)` cells (`bootBar`) |
| `parse` | `⠹ DECRYPT ▱▰▰▰▱▱▱▱ CITYGRID LONDON` | ping-pong |
| `build` | `⠹ COMPILE ▱▰▰▰▱▱▱▱ TERRAIN` / `TILE 3_4` (the builder step), or the city when there is no step | ping-pong |
| `ready` | `bootLine` delegates to `busyLine(inputs, …)` | as below |

- The spinner and bar timing are the same as the background line
  (`SPINNER_MS`, `BAR_MS`). `narrow` drops the label, as `busyLine` does,
  and so does the CSS below 600 px.
- During boot the line shows regardless of the HUD setting, because the HUD
  is not up yet. There is no 300 ms show delay, since it is already visible.
- Colour: HUD green. `.neon` is on when the requested boot style
  (`resolveBootRender(?render=, city default, saved setting)`) is `cyberpunk`.
- Handover: the first `BusyView.update()` after `ready` removes `.boot`. If
  the line is up, the gate is forced to shown (`BusyGate.force`), so the
  normal rules take over from there: HUD setting, hysteresis, 600 ms hold
  and fade. With `?hud=0` the line hides at once.
- The `#overlay p` text (`formatLoading`) is unchanged.

## Look

- **Placement:** the left end of the 20 px `#credits` bar (`left: 0;
  bottom: 0`), `z-index: 6` (above the credits' 5), black background, 11 px
  monospace, full opacity so it reads brighter than the 55 % credits text.
  `#toast` and `#gear` do not move.
- **Spinner:** braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, one frame every `SPINNER_MS` = 80 ms.
- **Bar:** `BAR_CELLS` = 8 cells, indeterminate: a 3-cell `▰` block
  ping-pongs across `▱` (start cell 0→5→0), one step every `BAR_MS` = 120 ms.
  There is no percentage because the totals are unknown.
- **Verb:** `BOOT` while the cyberpunk engine is loading, else `SYNC`.
- **Label:** the active items joined by ` · `, in this order:
  `SECTORS n` · `NEON GRID` · `CELLS n` · `CARS`.
- **Colour:** `var(--hud-green)`. In the `cyberpunk` style `#busy.neon` makes
  the text `#ff3ad8` and the bar `#3ef2ff`, with a `0 0 6px` glow.
- **Phones (< 600 px):** the `.busy-label` span is hidden, so only the
  spinner, verb and bar remain and the centred credits stay uncovered.

## Sources (`busyInputsFromStats`)

| Item | Source (read in `main.ts`) |
|---|---|
| `SECTORS n` | `tileMgr.pending()` (tiles in flight + fetched but not applied) |
| `NEON GRID` / `BOOT` | `punkDebug.status === 'loading'` |
| `CELLS n` | sum of every `punk.stats()` key ending in `.pending` (`detail`, `props`, `neon` cell streamers) |
| `CARS` | `vehicles.on === 1 && vehicles.ready !== 1`, or `vehicles.loading > 0` |

`punk.stats()` is read only while the cyberpunk view is active
(`punk.active`). After you switch away the layers stop streaming, so a stale
`*.pending` would otherwise leave the line on forever.

## Behaviour

- **Visibility:** before `ready` the boot phases above apply. After it,
  the line is hidden when the HUD is off (`settings.hud`,
  `?hud=0` / `H`), and when idle.
- **Hysteresis (`BusyGate`):** the line shows only after the state has been
  continuously busy for 300 ms, so one quick tile does not flicker it. Once
  idle, it keeps the last line for 600 ms, then removes `.on` and fades out
  over 0.25 s (CSS `opacity` transition). If the state goes busy again inside
  the hold window, the line stays up.
- **Polling:** the sources are read at most every `POLL_MS` = 250 ms, because
  `punk.stats()` allocates an object. Between polls, `BusyView.update`
  gets `null` and reuses the last inputs. The spinner and bar animate from
  the frame timestamp. Each span's `textContent` is written only when its
  string changes.

## Code

- `src/hud/busy.ts` is pure (no DOM, no three) and unit-tested in
  `tests/busy.test.ts`. It exports `BusyInputs`, `busyInputsFromStats`,
  `busyLabel`, `busyLine`, the `busySpinner` / `busyBar` / `busyVerb`
  pieces, `BusyGate`, the constants, and the boot wording (`BootParts`,
  `bootBar`, `bootParts`, `bootLine`).
- `src/hud/busyview.ts` holds `BusyView`, which adopts or creates a `<div id="busy">` with three
  spans: `.busy-head` (spinner + verb), `.busy-bar`, `.busy-label`. Their
  concatenated `textContent` equals `busyLine(inputs, t, false)`.
- `src/main.ts` mounts it next to `mountCredits` and runs a short
  poll + `update` block at the end of the frame loop.
- `e2e/busy.spec.ts` covers the London teleport, which makes it appear and
  then hide, and `?hud=0`, which keeps it hidden after ready. Two more tests
  delay the city `index.json` by 1.5–2 s and sample the line before
  `ready`: the lore wording, opacity 1, and exactly one `#busy`.

## Adding a new source

1. Add a field to `BusyInputs`. Fill it in `busyInputsFromStats`: add a
   parameter if the value does not come from `punk.stats()`, otherwise read
   the stats key.
2. Add the label item in `busyLabel` at its place in the order. If it is a
   boot phase, update `busyVerb` too.
3. Pass the value from the poll block in `main.ts`. Keep it cheap: it runs
   every 250 ms, not every frame.
4. Extend `tests/busy.test.ts` (label order, idle → `''`).
