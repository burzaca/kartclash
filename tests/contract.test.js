// tests/contract.test.js — the PM's integration gate. Validates every module against
// docs/INTERFACES.md exactly as written. Worker-authored tests check behaviour; this checks contract.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TRACKS, KART, ITEM, ITEMS, GAME, RACE, PLAYERS, AI_DRIVERS } from '../src/config.js';
import { mulberry32 } from '../src/foundation.js';
import { buildTrack } from '../src/core/track.js';
import { createKart, stepKart, resolveKartCollisions, recoverKart, resetKart } from '../src/core/kart.js';
import { createControllers } from '../src/core/input.js';
import { createItemSystem } from '../src/core/items.js';
import { createRace, standings } from '../src/core/race.js';
import { createAI, stepAI } from '../src/core/ai.js';

const KART_FIELDS = ['id', 'name', 'spec', 'human', 'ai', 'pos', 'heading', 'speed', 'vel', 'input',
  'drift', 'air', 'boost', 'item', 'count', 'star', 'invisible', 'shrunk', 'spin', 'offRoad', 'onPad',
  'wallHit', 'hitFlash', 'plIdx', 'lap', 'progress', 'place', 'finished', 'finishTime', 'raceTime',
  'lapStart', 'lapTimes', 'fx', 'lean', 'wheelSpin', 'steerVis'];

test('§0 kart state matches the contract field-for-field', () => {
  const k = createKart(0, PLAYERS[0], true);
  for (const f of KART_FIELDS) assert.ok(f in k, `kart missing field: ${f}`);
  assert.equal(typeof k.heading, 'number');
  assert.equal(typeof k.input.throttle, 'number');
  assert.equal(typeof k.drift.tier, 'number');
  assert.equal(typeof k.fx.shake, 'number');
});

for (const def of TRACKS) {
  test(`§1 track '${def.id}' exposes the full query surface`, () => {
    const track = buildTrack(def);
    for (const f of ['pl', 'total', 'halfWidth', 'surfaceY', 'sample', 'progressOf', 'checkpoints',
      'startIdx', 'gridSlot', 'itemNodes', 'pads', 'decor', 'bounds', 'minimap']) {
      assert.ok(track[f] !== undefined, `track missing ${f}`);
    }
    assert.ok(track.total > 600 && track.total < 2500, `track length implausible: ${track.total}`);
    assert.equal(track.pl.count, track.pl.pts.length);
    assert.ok(track.checkpoints.length >= 4);
    assert.ok(track.itemNodes.length === def.itemNodes.length, 'itemNodes count mismatch');
    assert.ok(track.pads.length === def.boostPads.length, 'pads count mismatch');
    assert.ok(track.decor.length > 40, 'too little scenery');

    // sample shape, on the centreline and off it
    const i0 = track.startIdx;
    const p = track.pl.pts[i0];
    const s = track.sample(p.x, p.z, i0);
    for (const f of ['idx', 'dist', 'side', 'half', 'onRoad', 'tx', 'tz', 'nx', 'nz', 'y', 'pad']) {
      assert.ok(f in s, `sample missing ${f}`);
    }
    assert.ok(Math.abs(s.side) < 0.6, `centreline side=${s.side}`);
    assert.equal(s.onRoad, true);
    const y0 = track.surfaceY(p.x, p.z);
    assert.equal(s.y, y0, 'sample.y must equal surfaceY at the same point');
    const off = track.sample(p.x + s.nx * (s.half + 6), p.z + s.nz * (s.half + 6), i0);
    assert.equal(off.onRoad, false, `off-track point reported onRoad (side=${off.side}, half=${off.half})`);
    assert.ok(Math.abs(off.side) > s.half + 4);

    // grid slots are on-road, ordered, separated
    const slots = [];
    for (let i = 0; i < 6; i++) {
      const g = track.gridSlot(i, 6);
      const gs = track.sample(g.x, g.z, track.startIdx);
      assert.ok(gs.onRoad, `grid slot ${i} is off-road`);
      slots.push(g);
    }
    for (let a = 0; a < slots.length; a++) for (let b = a + 1; b < slots.length; b++) {
      assert.ok(Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z) > 3.5, 'grid slots overlap');
    }

    // progress around the lap must advance
    let prev = -1, wraps = 0, monotonic = 0;
    for (let i = 0; i < track.pl.count; i += 7) {
      const q = track.pl.pts[i];
      const pr = track.progressOf(q.x, q.z, i);
      if (pr.frac < prev) wraps++;
      if (pr.frac > prev) monotonic++;
      prev = pr.frac;
      assert.ok(pr.frac >= 0 && pr.frac <= 1, 'progress frac out of range');
    }
    assert.ok(monotonic > track.pl.count / 20, 'progressOf not monotonic forward');
    assert.ok(wraps <= 2, 'progressOf wrapped too often');

    // decor never inside the road
    for (const d of track.decor.slice(0, 200)) {
      const ds = track.sample(d.x, d.z, -1);
      assert.ok(Math.abs(ds.side) > ds.half + 1.5, `decor ${d.kind} sits on the road`);
    }
  });
}

test('§2 physics: contract-level behaviour on the real track', () => {
  const track = buildTrack(TRACKS[0]);
  const k = createKart(0, PLAYERS[0], true);
  resetKart(k, 0, track);
  const ctx = { karts: [k], track, items: null, fx: null, rng: mulberry32(7), time: 0 };
  k.input.throttle = 1;
  let maxSpeed = 0, off = 0, escaped = 0;
  const STEPS = 120 * 8;
  for (let i = 0; i < STEPS; i++) {
    stepKart(k, track, 1 / 120, ctx);
    maxSpeed = Math.max(maxSpeed, Math.abs(k.speed));
    // the first ~190 m from the grid is the start straight: no reason to leave the road there
    if (k.offRoad && i < 120 * 4) off++;
    const s = track.sample(k.pos.x, k.pos.z, k.plIdx);
    if (Math.abs(s.side) > s.half + 0.6) escaped++;
  }
  assert.ok(maxSpeed >= KART.maxSpeed * 0.95, `top speed ${maxSpeed}`);
  assert.ok(maxSpeed <= KART.maxSpeed * 1.02, `oversped ${maxSpeed}`);
  assert.ok(Number.isFinite(k.pos.x) && Number.isFinite(k.pos.z), 'kart position went non-finite');
  assert.ok(off === 0, 'a straight-line full-throttle kart left the road on the start straight');
  assert.ok(escaped === 0, `the kart escaped the barriers ${escaped} times while driving flat out`);
  assert.ok(k.lap === 0 && k.plIdx === k.plIdx, 'physics owns driving only; race.js owns lap state');
  assert.ok(k.lap === 0, 'physics must not touch lap counters');

  // hard steering at speed must not teleport the kart out of the world
  k.input.steer = 1;
  for (let i = 0; i < 120 * 4; i++) stepKart(k, track, 1 / 120, ctx);
  assert.ok(Number.isFinite(k.heading) && Number.isFinite(k.lean));

  // wall containment: aim straight at the barrier
  const s0 = track.sample(k.pos.x, k.pos.z, k.plIdx);
  k.heading = Math.atan2(s0.nz, s0.nx);
  k.input.steer = 0; k.input.throttle = 1;
  for (let i = 0; i < 120 * 3; i++) stepKart(k, track, 1 / 120, ctx);
  const s1 = track.sample(k.pos.x, k.pos.z, k.plIdx);
  assert.ok(Math.abs(s1.side) <= s1.half + 0.5, `kart escaped the wall: side=${s1.side} half=${s1.half}`);

  // karts push each other apart
  const a = createKart(1, PLAYERS[0], true), b = createKart(2, AI_DRIVERS[0], false);
  resetKart(a, 0, track); resetKart(b, 1, track);
  b.pos.x = a.pos.x + 0.4; b.pos.z = a.pos.z + 0.4; b.heading = a.heading;
  resolveKartCollisions([a, b]);
  const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  assert.ok(d > 1.2, `overlapping karts did not separate (d=${d})`);
});

test('§2 controllers map physical keys to intents', () => {
  const [c] = createControllers(1, [{ human: true, keys: 'wasd' }]);
  c.press('up'); c.press('right');
  const it = c.intent();
  assert.ok(it.throttle > 0.5, 'throttle not read');
  assert.ok(it.steer > 0.5, 'steer not read');
  c.release('up'); c.release('right');
  const it2 = c.intent();
  assert.ok(Math.abs(it2.throttle) < 0.01 && Math.abs(it2.steer) < 0.01, 'keys stuck after release');
});

test('§3 item system contract: boxes, weighted table by place, effects, hits', () => {
  const track = buildTrack(TRACKS[0]);
  const rng = mulberry32(11);
  const items = createItemSystem(track, rng);
  assert.ok(Array.isArray(items.boxes) && items.boxes.length >= track.itemNodes.length);
  for (const b of items.boxes) for (const f of ['x', 'y', 'z', 'active']) assert.ok(f in b, `box missing ${f}`);
  assert.ok(Array.isArray(items.effects));

  // the table must differ by position
  const k = createKart(0, PLAYERS[0], true);
  resetKart(k, 0, track);
  const ctx = { karts: [k], track, items, fx: null, rng, time: 0 };
  const seenFirst = new Set(), seenLast = new Set();
  for (let round = 0; round < 400; round++) {
    k.place = 1;
    k.pos.x = track.itemNodes[0].x; k.pos.z = track.itemNodes[0].z;
    for (const b of items.boxes) { b.active = true; }
    const got = items.collect(k, ctx);
    if (got) seenFirst.add(got);
    k.item = 0; k.count = 0;
    k.place = 6;
    for (const b of items.boxes) b.active = true;
    const got2 = items.collect(k, ctx);
    if (got2) seenLast.add(got2);
    k.item = 0; k.count = 0;
  }
  assert.ok(seenFirst.size >= 2, 'no items collected at all');
  const strong = new Set([ITEM.RED_SHELL, ITEM.TRIPLE_RED, ITEM.LIGHTNING, ITEM.STAR, ITEM.TRIPLE_MUSHROOM]);
  const lastStrong = [...seenLast].filter((i) => strong.has(i) || strong.has(ITEM_TRIPLE_OF(i)));
  assert.ok(lastStrong.length >= 1, 'last place never got a strong item');
  for (const i of seenFirst) {
    assert.ok(![ITEM.LIGHTNING, ITEM.STAR].includes(i), `first place got a strong item: ${i}`);
  }

  // throwing a mushroom boosts
  const k2 = createKart(1, PLAYERS[1], true);
  resetKart(k2, 0, track);
  k2.item = ITEM.MUSHROOM; k2.count = 1;
  const okUse = items.use(k2, ctx);
  assert.ok(okUse, 'use(mushroom) returned false');
  assert.ok(k2.boost.time > 0 && k2.boost.mul > 1, 'mushroom did not boost');
  assert.equal(k2.item, ITEM.NONE, 'item not consumed');
});
const ITEM_TRIPLE_OF = (i) => i;

test('race contract: AI-driven race reaches the flag with real lap times', () => {
  const track = buildTrack({ ...TRACKS[0], laps: 2 });
  const rng = mulberry32(5);
  const karts = [createKart(0, PLAYERS[0], false), createKart(1, PLAYERS[1], false)];
  karts.forEach((k, i) => { k.ai = createAI(k.spec, mulberry32(97 + i * 31)); });
  const items = createItemSystem(track, rng);
  const race = createRace(track, karts);
  race.start();
  assert.equal(race.phase, 'countdown');
  const ctx = { karts, track, items, fx: null, rng, time: 0 };
  let steps = 0;
  while (race.phase !== 'finished' && steps < 120 * 60 * 6) {
    for (const k of karts) {
      if (k.ai) stepAI(k, k.ai, track, ctx, 1 / 120);
      stepKart(k, track, 1 / 120, ctx);
    }
    resolveKartCollisions(karts);
    items.update(1 / 120, ctx);
    for (const k of karts) if (k.input.use) { items.use(k, ctx); k.input.use = false; }
    items.applyHits(ctx);
    race.step(1 / 120, ctx);
    steps++;
  }
  assert.equal(race.phase, 'finished', `race did not finish (${race.phase})`);
  const rows = standings(race);
  assert.ok(rows[0].finished && rows[0].lapTimes.length >= 2, 'winner without lap times');
  assert.ok(rows[0].place === 1 && rows[1].place === 2, 'standings not ordered');
  assert.ok(rows.every((r) => r.lapTimes.every((t) => t > 15 && t < 300)), 'implausible lap times');
  assert.ok(rows[0].lapTimes[0] === rows[0].bestLap || rows[0].bestLap <= rows[0].lapTimes[0], 'best lap not tracked');
});

// --- vendor integrity -------------------------------------------------------
test('the vendored three.js build is present, complete, and loads with the APIs we use', async () => {
  const fs = await import('node:fs');
  // three's build is split: three.module.js re-exports from three.core.js, so BOTH must ship
  for (const f of ['../vendor/three.module.js', '../vendor/three.core.js']) {
    const p = new URL(f, import.meta.url);
    assert.ok(fs.existsSync(p), `${f} must be committed (no CDN, no node_modules)`);
    assert.ok(fs.readFileSync(p, 'utf8').length > 500000, `${f} looks truncated`);
  }
  const THREE = await import('../vendor/three.module.js');
  assert.ok(THREE.REVISION, 'vendored three.js has no REVISION');
  for (const api of ['PerspectiveCamera', 'WebGLRenderer', 'Box3', 'Vector3', 'Scene', 'LatheGeometry']) {
    assert.equal(typeof THREE[api], 'function', `vendored three.js is missing ${api}`);
  }
});

// Wiring guard for a browser-only handler (main.js): pause keys must be inert at the title —
// an unguarded toggle silently set paused=true while the title showed, freezing the next race.
test('pause keys are guarded by started+phase in the key handler', () => {
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(src, /if \(started && race\.phase !== 'finished' && GLOBAL_KEYS\.pause\.includes\(e\.code\)\)/);
});

// Layering guard: an emptied menu overlay must be display:none and both overlays must be
// absolutely positioned — block-flow stacking made the black sheet land on the canvas on some
// browsers (the 2026-11-08 "black screen" incident).
test('menu/HUD overlays are absolute and the empty menu hides itself', () => {
  const menu = readFileSync(new URL('../src/ui/menu.js', import.meta.url), 'utf8');
  const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
  assert.match(menu, /\.kc-menu:empty \{ display: none; \}/);
  assert.match(menu, /\.kc-menu \{[\s\S]*?position: absolute; inset: 0;/);
  assert.match(hud, /\.kc-hud \{ position: absolute; inset: 0;/);
});
