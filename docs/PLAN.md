# PLAN — KART CLASH (three.js arcade kart racer, 2P split screen)

Deliverable: a playable, polished browser game at `burzaca.github.io/kartclash/` + a repo. Mario-Kart-style
arcade racing with drift/mini-turbo chains, items, 6 racers (2 human + 4 CPU), 3 laps, split-screen
2-player on one keyboard, and 2 tracks. Zero build step, zero assets beyond three.js (r186 import map).

## Architecture
- Pure core (`src/core`, testable in node): track queries, kart physics, items, race state, AI.
- Render (`src/render`, three.js passed in): stage/lighting/sky (PM), track mesh, kart models, FX.
- UI (`src/ui`): split-screen HUD with per-viewport minimap, menus/results. DOM+CSS, no assets.
- `src/main.js`: fixed-step loop (120 Hz), camera rig, viewport math, split-screen orchestration.

## File ownership
| Owner | Files |
|---|---|
| PM (me) | foundation.js, config.js, core/race.js, core/ai.js, render/stage.js, main.js, index.html, tools, tests/contract.test.js, CI, deploy |
| W1 (strong) | core/input.js, core/kart.js, tests/test_kart.test.js |
| W2 (strong) | core/track.js, render/trackMesh.js, tests/test_track.test.js |
| W3 (strong) | core/items.js, tests/test_items.test.js |
| W4 (free) | render/kartModel.js, render/fx.js |
| W5 (free) | ui/hud.js, ui/menu.js |

## Order
1. PM writes foundation + config + INTERFACES (done).
2. 5 workers in parallel, disjoint files, self-tested against their own node tests.
3. PM writes race.js, ai.js, stage.js, main.js, index.html while they run.
4. Integrate: `npm run check`, `npm test`, then the real browser: boot check (`window.__bootErr`),
   fixed review shots (`?shot=`, `?test=`), measured speeds/lap times from the engine, both viewports.
5. Fix what the browser shows (the workers' reports are not facts).
6. `tools/simulate.js` headless: 6-AI race must finish 3 laps in a sane band with no NaN and no
   kart stuck off-track — CI runs it plus the unit tests.
7. Deploy GitHub Pages, document in the Obsidian vault, report to the user.

## Acceptance (what "AAA-quality" means here, measurable)
- Boots clean (no console errors, `__bootErr` null), 60 fps at 1920x1080 with 2 viewports.
- 2P split screen works on one keyboard (P1 WASD+LShift+Space, P2 arrows+.+/) with independent HUDs.
- Drift chain works: tier 1/2/3 boosts visible in the HUD/FX; walls, off-road, recovery all behave.
- Items work end-to-end: boxes → weighted table by position → use → effects → victims react.
- A full 3-lap race with 6 racers finishes and shows results with gaps and best laps.
- Look: procedural, no textures, soft shadows, sky, curbs, grandstands, particles; not toy-like.
