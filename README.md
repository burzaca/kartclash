# KART CLASH

Arcade kart racing in the spirit of the classics — built with three.js, **zero asset files**: every
kart, driver, track, kerb, grandstand, tree and particle is generated procedurally in code.
Two players share one keyboard in true split screen.

Live: https://burzaca.github.io/kartclash/

## Play

| | Player 1 | Player 2 |
|---|---|---|
| Drive | `W` `A` `S` `D` | `↑` `←` `↓` `→` |
| Drift / mini-turbo | `LEFT SHIFT` (hold while turning) | `.` (period) |
| Use item | `SPACE` | `/` (slash) |
| Start / Restart / Pause | `ENTER` / `R` / `P` — switch track on the title screen: `TAB` |

Hold drift through a corner: the longer you hold it, the bigger the boost when you let go
(blue → orange → purple sparks). Drive over the chevron pads for a free boost. Item boxes give you
something — and the further back you are, the better the item.

## How it is built

```
index.html            import map (three r186 vendored in vendor/) + boot veil
src/config.js         every tuning knob, item tables, track layouts
src/foundation.js     RNG, math, polyline/spline queries — one shared truth
src/core/             pure, node-testable game logic
  track.js            circuit queries: sample / progress / grid / scenery placement
  kart.js             arcade physics: grip-slide, drift chain, walls, off-road, recovery
  items.js            boxes, weighted item table by position, shells/bananas/lightning/star
  race.js             countdown, laps, ranking, finish
  ai.js               racing line, corner speed from curvature, drift chains, rubber band
src/render/           three.js (all take THREE as a parameter, none import it)
  stage.js            renderer, sky shader, sun + shadow follow
  cameraRig.js        chase camera: speed-scaled distance, fov kick, split aspects
  trackMesh.js        road ribbon, kerbs, barriers, grandstands, props
  kartModel.js        karts, drivers, items, effects (all lathed geometry)
  fx.js               pooled instanced particles
src/ui/
  hud.js              split-screen HUD: position, laps, items, speed, minimap
  menu.js             title / pause / controls
src/main.js           fixed-step loop (120 Hz), viewport math, orchestration
vendor/               three.module.js + three.core.js (pinned r186, no CDN, no npm install)
```

## How it is verified

The game logic and the camera are checked headlessly, with no browser and no GPU:

```bash
npm test                 # 82 unit + contract tests (physics, track queries, items, race)
npm run sim -- --all     # full AI races on both circuits; asserts pacing, no NaN, no stuck karts
npm run smoke:render     # builds every mesh; audits triangle counts, geometry, kart footprint
npm run probe:camera     # projects the real kart bounding box into each split viewport and asserts
                         # it stays on screen at a readable size, road ahead in frame, camera above
                         # the surface — on both tracks
```

## Develop

```bash
python3 -m http.server 8098      # then open http://localhost:8098
npm test                         # unit + contract tests
npm run sim -- --all --laps=2    # headless races, pacing assertions
npm run check                    # syntax-check every module
```

Debug / performance switches (URL params): `?p=1` single player, `?test=1` all-CPU race,
`?laps=1`, `?track=shell-coast`, `?shot=kart|front|aerial|drift` fixed review camera,
`?scale=0.6` render the 3D at 60% resolution (HUD stays crisp — for weak GPUs),
`?noshadow=1` drop shadow mapping.

## Credits

Built in one session by Anakin (Hermes agent) for muha7a, with five worker sub-agents implementing
the modules against `docs/INTERFACES.md`. MIT licensed. No Nintendo assets or IP are used.
