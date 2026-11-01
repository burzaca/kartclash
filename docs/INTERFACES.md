# INTERFACES — KART CLASH (contract, binding for every worker)

Game: arcade kart racer in the spirit of Mario Kart (our own IP, no Nintendo assets), three.js,
zero build step, zero external assets besides three.js itself. **2-player split screen is a hard
requirement.** All code is plain ESM; `package.json` has `"type":"module"`, so `node --check` works.

Rules for every worker:
1. Only touch the files assigned to you. Never edit `src/config.js`, `src/foundation.js`, or another
   worker's file. Read them first.
2. Import tuning numbers from `../config.js` and math/RNG from `../foundation.js`. **Never hardcode
   a number that already exists as a knob.** Local cosmetic constants are fine.
3. `src/core/*` must stay PURE: no DOM, no THREE, no `window` at import time (inside functions you
   may guard with `typeof window !== 'undefined'`). It has to run under `node --test`.
4. `src/render/*` and `src/ui/*` receive `THREE` (or a DOM root) as a **parameter** — do not
   `import 'three'` inside a core file.
5. Write the file FIRST, then run the stated verification and fix until it passes. Report DONE with
   the file paths. A report without a written file is worthless.

---

## 0. Shared state shape (created by main.js — you consume it, do not invent new fields)

```js
kart = {
  id: 0, name: 'P1', spec: PLAYERS[0], human: true, ai: null,   // ai = {} for CPU racers
  pos: { x: 0, y: 0, z: 0 },        // world position; y = surface height + air.y
  heading: 0,                       // rad; forward = {x: Math.cos(heading), z: Math.sin(heading)}
  speed: 0,                         // SIGNED scalar along forward, m/s (negative = reversing)
  vel: { x: 0, z: 0 },              // actual velocity (differs from heading while sliding)
  input: { throttle: 0, steer: 0, drift: false, use: false },   // throttle/steer in -1..1
  drift: { on: false, dir: 0, time: 0, tier: -1 },              // tier -1 none, 0/1/2 = mini/super/ultra
  air: { y: 0, vy: 0, onGround: true },                          // hop/jump off the surface
  boost: { time: 0, mul: 1 },       // active speed boost (drift release, mushroom, pad, star)
  item: 0, count: 0,                // held item id (ITEM.*) and stack count
  star: 0, invisible: 0, shrunk: 0, spin: 0,   // seconds remaining of each effect (0 = off)
  offRoad: false, onPad: false, wallHit: 0, hitFlash: 0,       // wallHit/hitFlash = s since event (FX)
  plIdx: 0,                          // nearestPolyline hint index, kept fresh by race.js
  lap: 0, progress: 0, place: 1, finished: false, finishTime: 0, raceTime: 0, lapStart: 0, lapTimes: [],
  fx: { shake: 0, boost: 0, spark: -1 },   // render hints written by physics, read by renderer
  lean: 0, wheelSpin: 0, steerVis: 0,      // visual state written by physics
};
```
`race.js` (mine) owns `plIdx`, lap/progress/place, and calls every module in this order each fixed
step: `input → ai → stepKart(×) → kart-vs-kart → items.update/use/collect → race.laps+rank`.

---

## 1. Track — `src/core/track.js`  (WORKER 2, strong route)

```js
export function buildTrack(def) -> track
```
`def` is one entry of `TRACKS` from config.js (`ctrl`, `width`, `widthVar`, `itemNodes`, `boostPads`,
`elev`, `seed`, `theme`, `name`, `id`, `laps`).

```js
track = {
  def, name, id,
  pl,                        // from buildPolyline(def.ctrl, 2.5)
  total,                     // pl.total (arc length, m)
  halfWidth(idx) -> number,  // lateral half-width at that index; varies within widthVar
  surfaceY(x, z) -> number,  // elevation from def.elev (waves over the lap), metres
  sample(x, z, hintIdx = -1) -> s,
  progressOf(x, z, hintIdx) -> { idx, frac },   // frac 0..1 around the lap
  checkpoints: [ {idx, x, z, tx, tz} ],          // 8 evenly spaced gates, ordered by idx
  startIdx,                                      // index of the start/finish line (grid at t≈0)
  gridSlot(i, count) -> { x, z, heading },       // i-th grid slot (i=0 = pole), staggered 2 columns
  itemNodes: [ {idx, x, z} ],                   // from def.itemNodes fractions
  pads: [ {idx, x, z, tx, tz, halfW} ],         // from def.boostPads
  decor: [ decorItem ],                          // deterministic from def.seed via mulberry32
  bounds: { minX, maxX, minZ, maxZ },           // of the road ribbon + 30 m margin
  minimap: { xs:[], zs:[], minX, maxX, minZ, maxZ },  // simplified outline for the HUD
}
```
`sample()` returns exactly:
```js
s = { idx, dist, side, half, onRoad, tx, tz, nx, nz, y, slopeX, slopeZ, pad }
//  side  = signed lateral offset from centreline (+ = left of travel)
//  half  = halfWidth(idx)
//  onRoad= Math.abs(side) <= half - KART.radius
//  pad   = true when inside a boost pad footprint (|side| <= pad.halfW*w and near pad idx)
//  y     = surfaceY(x, z)   (also used to place karts, items, props)
//  slopeX/slopeZ = dY/dx, dY/dz (finite difference is fine)
```
`onRoad` must use the * kart radius inset* as written above. Off-road detection and the wall push both
come from `sample()`.

Design requirements:
- Walls are the ribbon edge: a kart is kept inside by the physics using `side`/`half` (see §2). Do not
  build collision geometry; the track only answers queries.
- `decor` is data for the renderer, kinds: `'tree' | 'rock' | 'bush' | 'stand' | 'flag' | 'lamp' |
  'arch' | 'sign' | 'billboard' | 'tirestack' | 'cone'`. Rules: never inside the road + 4 m shoulder,
  never within 60 m of the start line except grandstands/arch, trees use theme color, positions from
  the seeded RNG. ~180 items is a good target.
- `gridSlot`: rows behind the line, `RACE.startGridGap` apart, alternating lateral offset
  `±RACE.startLateral`, heading = track tangent at that index.

Verification: `node --test tests/test_track.test.js` (you write it) — must assert: closed polyline is
continuous (no jump > 6 m between neighbours), `total` in 900–1600 m, `sample` on the centreline gives
`|side| < 0.6`, `onRoad === true` at centreline and `false` at `half + 5` offset, `progressOf` is
monotonic along a full lap walk, `gridSlot` slots are all on-road and ≥ 4 m apart, `decor` items are
all off the road (|side| > half + 4), `bounds` contains every centreline point.

## 1b. Track geometry — `src/render/trackMesh.js` (WORKER 2)

```js
export function buildTrackScene(THREE, track, theme) -> { group, meshes: { road, curb, wall, ground, props } }
```
- Road ribbon from `pl` using `halfWidth(idx)`: BufferGeometry with position + normal + color
  (vertex-colour stripes: darker racing line, start-line checker band, boost-pad chevrons glowing).
- Curbs: alternating red/white blocks on the outer edge of the ribbon (real Mario Kart look).
- Barriers: low wall along both edges (instanced segments or an extruded ribbon), with the theme wall
  colour and posts at corners. Must read as a solid wall, not a floating stripe.
- Ground: large plane with subtle vertex-colour mottling (theme grass), no texture files.
- Props from `track.decor`: one `InstancedMesh` per kind, colour per instance via instanceColor.
- Grandstands + start arch + finish gantry at `startIdx`.
- All meshes: `castShadow`/`receiveShadow` set sensibly (road receives only).
- No `flatShading: true` on anything.

## 2. Input + kart physics — `src/core/input.js`, `src/core/kart.js` (WORKER 1, strong route)

```js
// input.js
export function createControllers(count, specs) -> controllers[]
// specs[i] = { human: bool, keys: 'wasd'|'arrows' }
controller = {
  human, keys, map,
  state: { up:false,down:false,left:false,right:false,drift:false,use:false },
  attach(target = (typeof window!=='undefined'?window:null)),   // adds keydown/keyup listeners
  detach(),
  press(action), release(action),            // programmatic — used by tests and touch fallback
  intent() -> { throttle, steer, drift, use },   // use = EDGE (true only on the frame it was pressed)
}
// kart.js
export function createKart(id, spec, human) -> kart          // exact shape from §0
export function stepKart(kart, track, dt, ctx) -> void       // one fixed step, mutates kart
export function resolveKartCollisions(karts) -> void         // kart-vs-kart push (bumper radius)
export function recoverKart(kart, track) -> void             // stuck/off-course recovery: put it back on the centreline at plIdx, speed 0
export function resetKart(kart, slot, track) -> void         // grid placement via track.gridSlot
```
`ctx = { items, fx, karts, rng, time }` (fx may be undefined in tests — guard every fx call).

Physics spec (arcade, the feel is everything — this is why you get the strong route):
- Throttle: `speed` ramps to `maxEff` with `KART.accel` (brake with `KART.brake`, reverse to
  `KART.reverseMax`). `maxEff = KART.maxSpeed * boostMul * (shrunk?0.85:1) * (offRoad?KART.offRoadMul:1) * starMul`.
- Velocity follows heading with grip: `vel = damp(vel, forward*speed, grip)` where grip =
  `KART.grip`, or `KART.driftGrip` while drifting, `KART.offRoadGrip` off-road. `speed` is derived
  from `vel` projected on forward (clamped to `maxEff`) — the classic arcade slide.
- Steering: `heading += steer * KART.steerRate * steerFalloffFactor(speed) * (drift?driftTurnBoost:1) * dt`,
  reduced to `KART.airSteer` while `!air.onGround`.
- Drift/mini-turbo: hold `drift` + a steer direction → latched (`drift.on`), one hop
  (`air.vy = KART.driftHopImpulse`), `drift.time` accumulates, tiers at `KART.driftCharge`. Releasing
  drift (or the steer) fires the boost for that tier (`KART.driftBoost[tier]` × `driftBoostTime[tier]`).
  Tier must be visible in `kart.drift.tier` and `kart.fx.spark` (0/1/2) so the renderer can spark.
- Boost: `boost.time` counts down; `boost.mul` is the multiplier. Fresh boost replaces a weaker one.
- Walls: if `|side| > half - KART.radius` push the kart back to the limit and reflect the outward
  velocity with `KART.wallBounce`, cut `speed *= KART.wallSpeedLoss`, set `wallHit` (for shake/FX).
- Off-road: from `sample().onRoad`; set `kart.offRoad` and drop grip/max speed. Also emit dust via fx.
- Air: `air.y` integrates with `KART.hopGravity`; landing sets `onGround` and calls fx once.
- Items in `kart` affect driving only here: `star` → `KART.starMul`, `shrunk` → 0.85, `spin` → lock
  steering/throttle and `speed` decays, `invisible` is inert for driving.
- Effects the renderer needs (write them, do not skip): `lean` (body roll, ≤ `KART.bankMax`, from
  lateral accel), `wheelSpin` (rad accumulated), `steerVis` (damped steering angle for front wheels),
  `fx.boost`, `fx.spark`, `fx.shake`, `hitFlash`, `wallHit`.
- `resolveKartCollisions`: for overlapping bumpers, separate both along the line joining them and
  exchange a fraction of velocity (`KART.pushForce`); a kart under a STAR pushes the other instead.
- `stepKart` must be deterministic given the same inputs + seeded ctx.rng.

Verification: `node --test tests/test_kart.test.js` (you write it, and build a tiny fake track:
`{sample:(x,z)=>({idx:0,dist:0,side:0,half:20,onRoad:true,tx:1,tz:0,nx:0,nz:0,y:0,pad:false}), halfWidth:()=>20, surfaceY:()=>0, pl:{count:1,pts:[{x:0,z:0}]}}`).
Must assert at minimum: full throttle reaches `KART.maxSpeed` within 6 s and never exceeds it;
`speed` stays under `maxSpeed*1.5` with boost; a 90° steer input turns the kart and does not flip it;
drift for 1.2 s reaches tier ≥ 0 and releasing sets `boost.time > 0`; tier 2 needs ≥ `driftCharge[2]`;
a fake wall (`side` forced to `half+3`) leaves the kart inside after one step with reduced speed;
off-road (onRoad=false) tops out near `maxSpeed*KART.offRoadMul`; `recoverKart` puts it on-road with
speed 0; a kart held in `spin` cannot accelerate; two overlapping karts get separated.

## 3. Items — `src/core/items.js` (WORKER 3, strong route)

```js
export function createItemSystem(track, rng) -> items
items = {
  boxes,                       // [{x,y,z,active,respawnAt}] built from track.itemNodes, ITEMS.boxCount per node
  effects,                     // live world objects (see shape below)
  reset(),
  update(dt, ctx),             // box respawn + effect motion/lifetime + hit detection
  collect(kart, ctx) -> itemId|0,   // grabs a box if inside ITEMS.boxRadius; assigns via tableForPlace(kart.place)
  use(kart, ctx) -> bool,      // consume held item (respects ITEM_COUNT stacks + ITEMS.itemGap cooldown)
  applyHits(ctx),              // effect vs kart collisions -> writes the victim's state
}
ctx = { karts, track, items, fx, rng, time }
```
Effect object shape (plain, renderer reads `kind/pos/radius/item/owner`):
```js
{ kind:'shell'|'banana'|'zap'|'cloud'|'starburst', item: ITEM.GREEN_SHELL, owner: 2,
  pos: {x,y,z}, vel: {x,z}, heading, radius, life, active: true, homing: null|kartId, spin: 0 }
```
Behaviour rules (implement exactly; ask no questions):
- Green shell: thrown forward at `ITEMS.shell.speed`, hugs the road (follow the centreline using
  `track.sample` — bounce off walls with `ITEMS.shell.bounce`), `life = ITEMS.shell.life`, knocks out
  the first rival it touches (any kart except the owner; a STAR victim instead destroys the shell).
- Red shell: homes to the nearest rival AHEAD within `ITEMS.redHomingRadius`, turning at
  `ITEMS.redTurnRate` rad/s, otherwise behaves like a green shell.
- Banana: dropped `ITEMS.banana.dropBack` m behind the owner, static, `life = ITEMS.banana.life`,
  spins out the victim.
- Shell/banana hitting a wall ends its life.
- `use(ITEM.MUSHROOM)` → `boost = { time: ITEMS… use KART.boostItemTime, mul: KART.boostItemMul }`.
- `use(ITEM.LIGHTNING)` → every *other* kart gets `shrunk = ITEMS.lightning.shrinkTime` and a speed
  penalty handled by physics; bigger gaps get a stronger version (2 extra seconds).
- `use(ITEM.CLOUD / FAKE_ITEM)` → `invisible = ITEMS.cloud.invisTime`; the kart also drops a banana
  behind it every 1.2 s while invisible (MK: fake-item drops bananas).
- `use(ITEM.STAR)` → `star = ITEMS.star.time`, plus a rolling item drop: every ~2 s the star holder
  drops a banana behind (harmless to it) and is immune to spin-outs.
- Triples: `count` from `ITEM_COUNT`, each `use` consumes one and converts via `ITEM_TRIPLE`.
- Item use cooldown `ITEMS.itemGap`; a kart holding an item cannot collect another.
- A kart that has already finished never collects boxes.
- On any hit write the victim state: `spin = ITEMS.spinOutTime`, `speed *= KART.spinSpeedLoss`,
  `hitFlash = 0.6`, `fx.shake = 1`, and call `fx.burst(...)`, `fx.ring(...)` where sensible.

Verification: `node --test tests/test_items.test.js` (you write; use the fake track from §2 and real
karts from `createKart`). Must assert: 1st place never gets RED_SHELL/LIGHTNING/STAR, 6th place gets
those with nonzero weight over 200 draws; a green shell thrown in front of a rival sets their `spin`;
a red shell curves toward a rival ahead and hits it; a banana behind a kart spins it out; triple item
stack decrements correctly and cannot go negative; lightning shrinks all other karts and not the user;
boxes respawn after `ITEMS.boxRespawn`; collecting requires proximity and gives exactly one item.

## 4. Renderer parts — `src/render/kartModel.js`, `src/render/fx.js` (WORKER 4)

```js
// kartModel.js
export function buildKartModel(THREE, spec) -> group
// group.userData.parts = { body, chassis, wheels: [4 meshes], driver, helmet, visor, exhaust: [2],
//                          flame: [2], shield, spark: null, shadowBlob }
export function updateKartModel(group, kart, dt) -> void
```
Kart = go-kart silhouette + a driver with a helmet, per-player colours from `spec`
(`color/trim/skin/helmet`). Look rules (from our proven recipe — follow them or it looks toy-like):
**no `flatShading`, high segment counts** (spheres 24-32, `LatheGeometry` with 20-24 profile points).
Body/chassis/driver built from **lathed profiles** and rounded boxes, not stacked cubes. Wheels =
torus + cylinder rims with a hub, front wheels steer via `kart.steerVis`, all spin by `kart.wheelSpin`.
Body roll from `kart.lean`, chassis pitch on hop, whole group at `kart.pos` with **`group.rotation.y = Math.PI / 2 - kart.heading`**.
Derivation you must not get wrong: world forward is `(cos h, 0, sin h)`; a Y-rotation of θ sends local
`+Z` to `(sin θ, 0, cos θ)`; so θ = π/2 − h. Therefore **author every model facing local +Z** (nose at
+Z, driver's face at +Z, left side at −X since +Z is to the right of travel).
`updateKartModel` must drive: wheel spin/steer, lean/pitch, boost flame length from `kart.boost.time`
(additive cone), drift sparks colour from `kart.drift.tier`, star rainbow tint (`kart.star`), cloud
blink/transparency (`kart.invisible`), spin-out wobble (`kart.spin`), shrink scale (`kart.shrunk`),
hit flash (emissive pulse from `kart.hitFlash`), a fake shadow blob under the kart when airborne
(`kart.air.y > 0.3`).

```js
// fx.js
export function createFX(THREE, scene) -> fx
fx = {
  burst(x, y, z, { color = 0xffffff, count = 12, speed = 6, life = 0.6, size = 0.35, gravity = -8, additive = false, spread = 1 }),
  trail(x, y, z, { color, life = 0.35, size = 0.3 }),
  ring(x, y, z, { color, r0 = 0.5, r1 = 4, life = 0.5 }),
  confetti(x, y, z, count),
  update(dt), reset(), dispose(),
}
```
One pooled `InstancedMesh` (capacity ≥ 1500) — no per-particle objects, no allocation in the update
loop (reuse scratch vectors). Zero external assets.

Both files are browser-only; verify with `npm run check` (i.e. `node --check`) and by reading your own
code for undefined identifiers — every symbol you reference must be defined in the file or imported.

## 4c. Item and effect props — also `src/render/kartModel.js` (WORKER 4)

```js
export function buildItemProps(THREE) -> props
props = {
  itemBox,                 // a fresh rotating cube-question-mark box (main.js clones it per box slot)
  itemMesh(itemId),        // fresh Object3D for a HELD item: mushroom/shell/banana/cloud/lightning/star
  effectMesh(effect),      // fresh Object3D for a live effect: {kind:'shell'|'banana'|'zap'|'cloud'|'starburst'}
}
export function setHeldItem(THREE, group, itemId, count) -> void  // floats the held item beside the driver, removes it when itemId === 0
```
`effect.kind` matches the effect objects from `src/core/items.js` (section 3). Green and red shells must
be visually different (red has a tail/heat-seeking look). main.js keeps one mesh per live effect and
positions it from `effect.pos` each frame, so the meshes you return must be positioned at the origin
and sized to `effect.radius`.


## 5. HUD + menus — `src/ui/hud.js`, `src/ui/menu.js` (WORKER 5)

```js
// hud.js
export function createHUD(root, racerSpecs, opts) -> hud
hud = {
  setTrack(plOrMinimap),                // { xs, zs, minX, maxX, minZ, maxZ, pts } from track.minimap
  setViewport(i, { x, y, w, h }),      // px, y measured from TOP of the canvas
  update(view),                         // called every animation frame
  banner(text, sub, dur), flash(color), results(rows), hideResults(), setStatus(text),
  dispose(),
}
view = {
  phase: 'title'|'countdown'|'racing'|'finished',
  time, laps: RACE, leaderGap: seconds, karts: [ { id, name, spec, place, lap, laps, progress,
            speed, item, count, star, invisible, shrunk, spin, offRoad, boost, finished, finishTime,
            bestLap, lapTimes, gapToLeader, isPlayer, viewport: {x,y,w,h} } ],
  countdownText: '3'|'GO'|null,
}
```
Per-viewport HUD (both viewports must be fully independent — this is the whole point of split screen):
position badge (1st/2nd…), lap counter `x/3`, item slot with an icon **drawn procedurally** (CSS/SVG,
no image files: mushroom, shell, banana, cloud, lightning, star — recognisable silhouettes), a speed
readout in km/h with a gauge arc, a minimap (canvas 2D: track outline + a dot per racer, your dot
larger + facing arrow), lap/best-lap panel, and a "positional" ghost of the field. Everything absolute
positioned inside its viewport with a CSS scale that follows the viewport size; `pointer-events: none`.
`results(rows)` = a full-screen standings table (name, time or +gap, best lap) that must look designed,
not a raw HTML table dump: dark panel, gold highlight for the winner, per-player colour chips.

```js
// menu.js
export function createMenu(root, opts) -> menu
menu = { showTitle(info), hide(), showPause(), hidePause(), showControls(), hideControls(),
         onAction(cb) /* cb('start'|'p1only'|'restart'|'resume'|'quit'|'next') */ }
info = { title, subtitle, tracks: [{name, selected}], players: [{name, keys, color}] }
```
Title screen must state the control map for both players (use `KEYMAP_LABEL` from config), the current
track name, and the buttons: Start 2P race, Start 1P race, Change track, Restart. Style: bold arcade
poster look, CSS only, big display type from system fonts (`system-ui` stack), colour from the
`PLAYERS` palette. No external fonts, no images, no frameworks. Keyboard focus handling so Enter works.

Verify with `npm run check` and by writing a tiny static smoke test you can run headlessly:
`node --check src/ui/hud.js && node --check src/ui/menu.js` plus a jsdom-free sanity review. Layout
correctness is checked by the PM in a real browser — make the DOM structure obvious and semantic
(one container per viewport, class names prefixed `kc-`), and keep all CSS in a single injected
`<style>` string inside the module (no external stylesheet).

---

## 6. What the PM owns (do not touch)
`src/foundation.js`, `src/config.js`, `src/core/race.js`, `src/core/ai.js`, `src/render/stage.js`,
`src/main.js`, `index.html`, `tests/contract.test.js`, `tools/*`, docs, CI, deploy.

Fixed-step order, camera rig, split-screen viewport math, lighting/sky/shadow, and the final look and
feel are mine. If your module needs something from them, code to this document, not to a guess.
