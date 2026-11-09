// test_items.test.js — rules for src/core/items.js (docs/INTERFACES.md section 3).
import test from 'node:test';
import assert from 'node:assert/strict';

import { ITEM, ITEM_COUNT, ITEM_TABLE, ITEMS, KART, PLAYERS, tableForPlace } from '../src/config.js';
import { mulberry32, buildPolyline, nearestOnPolyline, frameAt, advanceIdx } from '../src/foundation.js';
import { createItemSystem } from '../src/core/items.js';

// ---------------------------------------------------------------- fakes
// src/core/kart.js is written by another worker in parallel; it did not exist when this test was
// written, so build the exact section-0 kart shape locally.
function makeTestKart(id, opts = {}) {
  return {
    id, name: `K${id}`, spec: PLAYERS[0], human: id < 2, ai: id < 2 ? null : {},
    pos: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0, vel: { x: 0, z: 0 },
    input: { throttle: 0, steer: 0, drift: false, use: false },
    drift: { on: false, dir: 0, time: 0, tier: -1 },
    air: { y: 0, vy: 0, onGround: true },
    boost: { time: 0, mul: 1 },
    item: 0, count: 0,
    star: 0, invisible: 0, shrunk: 0, spin: 0,
    offRoad: false, onPad: false, wallHit: 0, hitFlash: 0,
    plIdx: 0,
    lap: 0, progress: 0, place: 1, finished: false, finishTime: 0, raceTime: 0, lapStart: 0, lapTimes: [],
    fx: { shake: 0, boost: 0, spark: -1 },
    lean: 0, wheelSpin: 0, steerVis: 0,
    ...opts,
  };
}

// A closed circular circuit (radius 160 m, half-width 10 m) that answers the section-1 queries,
// so shells can follow a real curving centreline and "ahead" has to wrap the loop seam.
const HALF = 10;
function makeLoopTrack() {
  const ctrl = [];
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; ctrl.push({ x: Math.cos(a) * 160, z: Math.sin(a) * 160 }); }
  const pl = buildPolyline(ctrl, 2.5);
  const track = {
    pl, total: pl.total,
    halfWidth: () => HALF,
    surfaceY: () => 0,
    sample(x, z, hint = -1) {
      const n = nearestOnPolyline(pl, x, z, hint);
      return { idx: n.idx, dist: n.dist, side: n.side, half: HALF, onRoad: Math.abs(n.side) <= HALF - KART.radius,
        tx: n.tx, tz: n.tz, nx: n.nx, nz: n.nz, y: 0, slopeX: 0, slopeZ: 0, pad: false };
    },
  };
  const node = (idx) => ({ idx, x: pl.pts[idx].x, z: pl.pts[idx].z });
  track.itemNodes = [node(100), node(250)];
  return track;
}

function place(track, k, idx, lateral = 0, speed = 0) {
  const f = frameAt(track.pl, idx);
  k.pos.x = f.x + f.nx * lateral; k.pos.z = f.z + f.nz * lateral;
  k.heading = Math.atan2(f.tz, f.tx);
  k.plIdx = ((idx % track.pl.count) + track.pl.count) % track.pl.count;
  k.speed = speed; k.vel.x = f.tx * speed; k.vel.z = f.tz * speed;
  return k;
}

function run(items, ctx, seconds, until) {
  const dt = 1 / 120;
  for (let t = 0; t < seconds; t += dt) { items.update(dt, ctx); if (until && until()) return true; }
  return false;
}

const STRONG = new Set([ITEM.RED_SHELL, ITEM.TRIPLE_RED, ITEM.LIGHTNING, ITEM.STAR]);

// ---------------------------------------------------------------- tests
test('item boxes: built from itemNodes x boxCount, spread across the road, all active', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(1));
  assert.equal(items.boxes.length, track.itemNodes.length * ITEMS.boxCount);
  for (const b of items.boxes) {
    assert.equal(b.active, true);
    for (const k of ['x', 'y', 'z', 'respawnAt']) assert.equal(typeof b[k], 'number');
    assert.ok(Math.abs(track.sample(b.x, b.z).side) < HALF, 'box on the road');
  }
  const xs = items.boxes.slice(0, ITEMS.boxCount).map((b) => track.sample(b.x, b.z).side);
  assert.ok(Math.max(...xs) - Math.min(...xs) > HALF, 'boxes spread across the width');
});

test('weighted table: 1st place never gets RED/LIGHTNING/STAR, last place does (200 draws each)', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(42));
  const field = [0, 1, 2, 3, 4, 5].map((i) => makeTestKart(i));
  const draw = (placeN) => {
    const k = field[0]; k.place = placeN;
    place(track, k, track.itemNodes[0].idx);
    const counts = new Map();
    for (let i = 0; i < 200; i++) {
      k.item = 0; k.count = 0;
      for (const b of items.boxes) b.active = true;
      const id = items.collect(k, { karts: field });
      assert.notEqual(id, 0);
      counts.set(id, (counts.get(id) || 0) + 1);
      items.update(ITEMS.pickGap + 0.01, { karts: field });  // one draw per pickGap, like a real lap
    }
    return counts;
  };
  const first = draw(1), last = draw(6);
  const strongFirst = [...first].filter(([id]) => STRONG.has(id)).reduce((s, [, n]) => s + n, 0);
  const strongLast = [...last].filter(([id]) => STRONG.has(id)).reduce((s, [, n]) => s + n, 0);
  assert.equal(strongFirst, 0, '1st place drew a strong item');
  assert.ok(strongLast > 40, `last place should draw plenty of strong items, got ${strongLast}/200`);
  assert.ok((last.get(ITEM.RED_SHELL) || 0) + (last.get(ITEM.TRIPLE_RED) || 0) > 0);
  assert.ok((last.get(ITEM.LIGHTNING) || 0) > 0);
  // the tables themselves: zero weight up front, nonzero at the back
  const w = (tab, id) => tab.find((e) => e.id === id).w;
  for (const id of [ITEM.RED_SHELL, ITEM.LIGHTNING, ITEM.STAR]) {
    assert.equal(w(tableForPlace(1, 6), id), 0);
    assert.ok(w(tableForPlace(6, 6), id) > 0);
  }
  const backHeavy = strongLast - strongFirst;
  assert.ok(backHeavy > 0, 'the back of the pack gets the good stuff');
});

test('collect: needs proximity, gives exactly one item, holder/finished cannot collect; boxes respawn', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(7));
  const k = place(track, makeTestKart(0), 30);
  const ctx = { karts: [k] };
  assert.equal(items.collect(k, ctx), 0, 'far from any box');
  assert.equal(k.item, 0);

  const b = items.boxes[2];
  k.pos.x = b.x; k.pos.z = b.z;
  const id = items.collect(k, ctx);
  assert.notEqual(id, 0);
  assert.equal(k.item, id);
  assert.equal(k.count, ITEM_COUNT[id] || 1);
  assert.equal(items.boxes.filter((x) => !x.active).length, 1, 'exactly one box taken');
  assert.equal(b.active, false);

  items.update(ITEMS.pickGap + 0.01, ctx); // the earlier collect set the pickup gap

  // 2026-11-09 rule: whatever is in hand gets used first. A second box while holding anything
  // is refused, the box stays untouched, and the caller is told why. (Replaces the old
  // top-up/replace behaviour that let players end up with a new powerup unused.)
  const nb = items.boxes[3]; k.pos.x = nb.x; k.pos.z = nb.z;
  k.item = ITEM.MUSHROOM; k.count = 1;
  let blocked = null;
  assert.equal(items.collect(k, { ...ctx, onBlocked: (kk, box, why) => { blocked = { id: kk.id, why }; } }), 0,
    'a second item must not appear while one is held');
  assert.equal(nb.active, true, 'the box must stay for the next pass');
  assert.deepEqual(blocked, { id: 0, why: 'busy' }, 'the caller was not told why the box did nothing');

  // empty the hand by using it, and boxes work again
  assert.ok(items.use(k, ctx), 'using the held mushroom failed');
  items.update(ITEMS.pickGap + 0.01, ctx);
  assert.notEqual(items.collect(k, ctx), 0, 'with an empty hand boxes work again');

  // finished kart never collects
  const f = makeTestKart(1, { finished: true }); f.pos.x = nb.x; f.pos.z = nb.z;
  assert.equal(items.collect(f, { karts: [k, f] }), 0);

  // respawn after ITEMS.boxRespawn (re-armed from the current clock: the pickup-gap advances
  // inserted above moved the timeline)
  b.active = false; b.respawnAt = items.clock() + ITEMS.boxRespawn;
  items.update(ITEMS.boxRespawn - 0.1, ctx);
  assert.equal(b.active, false);
  items.update(0.2, ctx);
  assert.equal(b.active, true);
});

test('green shell thrown at a rival ahead spins it out; owner unharmed; effect shape', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(3));
  const me = place(track, makeTestKart(0), 10, 0, 20);
  const rival = place(track, makeTestKart(1), 22, 0, 0);
  rival.speed = 25; rival.vel.x = 0; rival.vel.z = 0;
  const ctx = { karts: [me, rival], fx: undefined };
  me.item = ITEM.GREEN_SHELL; me.count = 1;
  assert.equal(items.use(me, ctx), true);
  assert.equal(me.item, 0);
  assert.equal(items.effects.length, 1);
  const e = items.effects[0];
  for (const key of ['kind', 'item', 'owner', 'pos', 'vel', 'heading', 'radius', 'life', 'active', 'homing', 'spin']) assert.ok(key in e, key);
  assert.equal(e.kind, 'shell'); assert.equal(e.item, ITEM.GREEN_SHELL); assert.equal(e.owner, 0);
  assert.equal(e.radius, ITEMS.shell.radius); assert.equal(e.homing, null);
  assert.ok(Math.abs(Math.hypot(e.vel.x, e.vel.z) - ITEMS.shell.speed) < 1e-9);

  assert.ok(run(items, ctx, 2, () => rival.spin > 0), 'rival got hit');
  assert.equal(rival.spin, ITEMS.spinOutTime);
  assert.ok(Math.abs(rival.speed - 25 * KART.spinSpeedLoss) < 1e-9);
  assert.equal(rival.hitFlash, 0.6);
  assert.equal(rival.fx.shake, 1);
  assert.equal(me.spin, 0);
  assert.equal(items.effects.length, 0, 'shell consumed by the hit');
});

test('a STAR victim is immune and destroys the shell', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(3));
  const me = place(track, makeTestKart(0), 10);
  const rival = place(track, makeTestKart(1), 22, 0, 20);
  rival.star = 5;
  const ctx = { karts: [me, rival] };
  me.item = ITEM.GREEN_SHELL; me.count = 1;
  items.use(me, ctx);
  run(items, ctx, 2, () => items.effects.length === 0);
  assert.equal(items.effects.length, 0);
  assert.equal(rival.spin, 0);
  assert.equal(rival.speed, 20);
});

test('green shell hugs the curving road and dies on walls', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(3));
  const me = place(track, makeTestKart(0), 40);
  const ctx = { karts: [me] };
  me.item = ITEM.GREEN_SHELL; me.count = 1;
  items.use(me, ctx);
  const e = items.effects[0];
  let maxSide = 0, travelled = 0, lastIdx = e.idx;
  for (let i = 0; i < 120 * 3 && items.effects.length; i++) {
    items.update(1 / 120, ctx);
    if (!e.active) break;
    const s = track.sample(e.pos.x, e.pos.z, lastIdx);
    maxSide = Math.max(maxSide, Math.abs(s.side));
    travelled += (s.idx - lastIdx + track.pl.count) % track.pl.count; lastIdx = s.idx;
  }
  assert.ok(maxSide <= HALF, `shell left the road (side ${maxSide.toFixed(2)})`);
  assert.ok(travelled > 30, 'shell travelled along the loop');

  // thrown straight at the wall: bounces, stays inside, and its life ends shortly after
  const items2 = createItemSystem(track, mulberry32(3));
  const k = place(track, makeTestKart(0), 40, 0);
  k.heading += Math.PI / 2;   // facing a wall
  k.item = ITEM.GREEN_SHELL; k.count = 1;
  items2.use(k, { karts: [k] });
  const w = items2.effects[0];
  let maxS = 0;
  for (let i = 0; i < 120 && w.active; i++) {
    items2.update(1 / 120, { karts: [k] });
    maxS = Math.max(maxS, Math.abs(track.sample(w.pos.x, w.pos.z).side));
  }
  assert.ok(w.wallHits >= 1, 'hit the wall');
  assert.ok(maxS <= HALF, 'kept inside the wall');
  assert.ok(w.life <= ITEMS.shell.wallBounceLife);
  run(items2, { karts: [k] }, ITEMS.shell.wallBounceLife + 0.1);
  assert.equal(items2.effects.length, 0, 'wall-hit shell is gone');
});

test('red shell homes onto the nearest rival AHEAD (not the closer one behind) and hits it', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(9));
  const me = place(track, makeTestKart(0), 100);
  const ahead = place(track, makeTestKart(1), 116, 6, 0);       // 40 m ahead, 6 m to the side
  const behind = place(track, makeTestKart(2), 96, 0, 0);       // 10 m behind (closer!)
  const ctx = { karts: [me, ahead, behind] };
  me.item = ITEM.RED_SHELL; me.count = 1;
  items.use(me, ctx);
  const e = items.effects[0];
  assert.equal(e.item, ITEM.RED_SHELL);
  assert.equal(e.homing, ahead.id);
  let maxSide = -Infinity;
  const hit = run(items, ctx, 3, () => {
    if (e.active) maxSide = Math.max(maxSide, track.sample(e.pos.x, e.pos.z, e.idx).side);
    return ahead.spin > 0;
  });
  assert.ok(hit, 'red shell hit the rival ahead');
  assert.ok(maxSide > 3, `red shell curved toward the target (side ${maxSide.toFixed(2)})`);
  assert.equal(behind.spin, 0);
  assert.equal(me.spin, 0);
});

test('red shell ahead-ness wraps the loop seam (track index, not dot product)', () => {
  const track = makeLoopTrack();
  const n = track.pl.count;
  const items = createItemSystem(track, mulberry32(9));
  const me = place(track, makeTestKart(0), advanceIdx(track.pl, 0, -5));
  const across = place(track, makeTestKart(1), 6, 0);          // ahead, across idx 0
  const ctx = { karts: [me, across] };
  me.item = ITEM.TRIPLE_RED; me.count = 3;
  items.use(me, ctx);
  assert.equal(items.effects[0].homing, across.id);
  assert.equal(me.item, ITEM.TRIPLE_RED); assert.equal(me.count, 2);

  // a rival just behind across the seam is NOT a target
  const items2 = createItemSystem(track, mulberry32(9));
  const me2 = place(track, makeTestKart(0), 5);
  const back = place(track, makeTestKart(1), n - 6, 0);
  me2.item = ITEM.RED_SHELL; me2.count = 1;
  items2.use(me2, { karts: [me2, back] });
  assert.equal(items2.effects[0].homing, null);

  // out of ITEMS.redHomingRadius: no target
  const items3 = createItemSystem(track, mulberry32(9));
  const me3 = place(track, makeTestKart(0), 50);
  const far = place(track, makeTestKart(1), 50 + Math.ceil((ITEMS.redHomingRadius + 20) / 2.5), 0);
  me3.item = ITEM.RED_SHELL; me3.count = 1;
  items3.use(me3, { karts: [me3, far] });
  assert.equal(items3.effects[0].homing, null);
});

test('banana dropped behind spins out a kart that drives into it, not its owner', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(5));
  const me = place(track, makeTestKart(0), 60);
  const victim = place(track, makeTestKart(1), 20, 0, 18);
  const ctx = { karts: [me, victim] };
  me.item = ITEM.BANANA; me.count = 1;
  assert.equal(items.use(me, ctx), true);
  const e = items.effects[0];
  assert.equal(e.kind, 'banana'); assert.equal(e.radius, ITEMS.banana.radius); assert.equal(e.life, ITEMS.banana.life);
  const back = Math.hypot(e.pos.x - me.pos.x, e.pos.z - me.pos.z);
  assert.ok(Math.abs(back - ITEMS.banana.dropBack) < 1e-6, 'dropBack metres behind');
  assert.ok(track.sample(e.pos.x, e.pos.z, me.plIdx).idx < me.plIdx, 'behind the owner');

  // owner reverses over its own banana: harmless
  me.pos.x = e.pos.x; me.pos.z = e.pos.z;
  items.update(1 / 120, ctx);
  assert.equal(me.spin, 0);
  assert.equal(items.effects.length, 1, 'banana still there');

  // banana is static
  const p0 = { ...e.pos };
  run(items, ctx, 0.5);
  assert.deepEqual({ x: e.pos.x, z: e.pos.z }, { x: p0.x, z: p0.z });

  victim.pos.x = e.pos.x + 1; victim.pos.z = e.pos.z;
  items.update(1 / 120, ctx);
  assert.equal(victim.spin, ITEMS.spinOutTime);
  assert.ok(Math.abs(victim.speed - 18 * KART.spinSpeedLoss) < 1e-9);
  assert.equal(items.effects.length, 0);
});

test('triple stack decrements through ITEM_COUNT/ITEM_TRIPLE, respects itemGap, never negative', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(5));
  const me = place(track, makeTestKart(0), 60);
  const ctx = { karts: [me] };
  me.item = ITEM.TRIPLE_BANANA; me.count = ITEM_COUNT[ITEM.TRIPLE_BANANA];
  assert.equal(items.use(me, ctx), true);
  assert.equal(me.count, 2); assert.equal(me.item, ITEM.TRIPLE_BANANA);
  assert.equal(items.use(me, ctx), false, 'cooldown ITEMS.itemGap');
  assert.equal(me.count, 2);
  items.update(ITEMS.itemGap + 0.01, ctx);
  assert.equal(items.use(me, ctx), true); assert.equal(me.count, 1);
  items.update(ITEMS.itemGap + 0.01, ctx);
  assert.equal(items.use(me, ctx), true); assert.equal(me.count, 0); assert.equal(me.item, 0);
  items.update(ITEMS.itemGap + 0.01, ctx);
  assert.equal(items.use(me, ctx), false);
  assert.equal(me.count, 0);
  assert.equal(items.effects.filter((e) => e.kind === 'banana').length, 3);
  assert.ok(items.effects.every((e) => e.item === ITEM.BANANA), 'converted via ITEM_TRIPLE');

  // a corrupted stack (count already 0) still cannot go negative
  me.item = ITEM.TRIPLE_MUSHROOM; me.count = 0;
  items.update(ITEMS.itemGap + 0.01, ctx);
  items.use(me, ctx);
  assert.equal(me.count, 0); assert.equal(me.item, 0);
});

test('mushroom boosts; star grants immunity + rolling harmless bananas; cloud = invisible + bananas', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(5));
  const me = place(track, makeTestKart(0), 60);
  const other = place(track, makeTestKart(1), 200);
  const ctx = { karts: [me, other] };

  me.item = ITEM.MUSHROOM; me.count = 1;
  items.use(me, ctx);
  assert.deepEqual({ ...me.boost }, { time: KART.boostItemTime, mul: KART.boostItemMul });

  items.update(1, ctx);
  me.spin = 1.5;
  me.item = ITEM.STAR; me.count = 1;
  items.use(me, ctx);
  assert.equal(me.star, ITEMS.star.time);
  assert.equal(me.spin, 0);
  assert.ok(items.effects.some((e) => e.kind === 'starburst' && e.owner === 0));
  run(items, ctx, 2.05);
  const nb = items.effects.filter((e) => e.kind === 'banana' && e.owner === 0).length;
  assert.equal(nb, 1, 'one rolling banana after ~2 s');
  assert.equal(me.spin, 0, 'own star bananas are harmless');

  me.star = 0; items.update(1 / 120, ctx);
  assert.ok(!items.effects.some((e) => e.kind === 'starburst'), 'starburst ends with the star');

  me.item = ITEM.FAKE_ITEM; me.count = 1;
  assert.equal(ITEM.CLOUD, ITEM.FAKE_ITEM);
  items.use(me, ctx);
  assert.equal(me.invisible, ITEMS.cloud.invisTime);
  const before = items.effects.filter((e) => e.kind === 'banana').length;
  run(items, ctx, 1.25);
  assert.equal(items.effects.filter((e) => e.kind === 'banana').length, before + 1, 'banana every 1.2 s while invisible');
  const cloud = items.effects.find((e) => e.kind === 'cloud');
  assert.ok(cloud && Math.hypot(cloud.pos.x - me.pos.x, cloud.pos.z - me.pos.z) < 1e-6, 'cloud follows the kart');

  // invisible karts are not targeted by red shells
  const items2 = createItemSystem(track, mulberry32(1));
  const a = place(track, makeTestKart(0), 100), b = place(track, makeTestKart(1), 110, 0);
  b.invisible = 3;
  a.item = ITEM.RED_SHELL; a.count = 1;
  items2.use(a, { karts: [a, b] });
  assert.equal(items2.effects[0].homing, null);
});

test('lightning shrinks every other kart (bigger gap = +2 s), not the user', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(5));
  const field = [0, 1, 2, 3, 4, 5].map((i) => place(track, makeTestKart(i, { place: i + 1 }), 20 + i * 10, 0, 20));
  const user = field[5];                  // last place fires it
  user.item = ITEM.LIGHTNING; user.count = 1;
  const ctx = { karts: field };
  assert.equal(items.use(user, ctx), true);
  assert.equal(user.shrunk, 0);
  assert.equal(user.speed, 20);
  for (const k of field.slice(0, 5)) {
    assert.ok(k.shrunk >= ITEMS.lightning.shrinkTime, `kart ${k.id} shrunk`);
    assert.ok(Math.abs(k.speed - 20 * ITEMS.lightning.slowFactor) < 1e-9);
  }
  assert.equal(field[0].shrunk, ITEMS.lightning.shrinkTime + 2, 'leader far ahead gets the strong version');
  assert.equal(field[4].shrunk, ITEMS.lightning.shrinkTime, 'adjacent kart gets the normal version');
  assert.ok(items.effects.filter((e) => e.kind === 'zap').length === 5);
});

test('hits call fx.burst/fx.ring when fx exists; reset clears effects and boxes', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(5));
  const calls = [];
  const fx = { burst: (...a) => calls.push(['burst', ...a]), ring: (...a) => calls.push(['ring', ...a]) };
  const me = place(track, makeTestKart(0), 60);
  const v = place(track, makeTestKart(1), 30, 0, 10);
  const ctx = { karts: [me, v], fx };
  me.item = ITEM.BANANA; me.count = 1;
  items.use(me, ctx);
  const e = items.effects[0];
  v.pos.x = e.pos.x; v.pos.z = e.pos.z;
  calls.length = 0;
  items.update(1 / 120, ctx);
  assert.ok(v.spin > 0);
  assert.ok(calls.some((c) => c[0] === 'burst'));
  assert.ok(calls.some((c) => c[0] === 'ring'));

  items.boxes[0].active = false;
  me.item = ITEM.BANANA; me.count = 1; items.update(1, ctx); items.use(me, ctx);
  items.reset();
  assert.equal(items.effects.length, 0);
  assert.ok(items.boxes.every((b) => b.active));
});

test('works on the minimal section-2 fake track (single-point polyline, no homing possible)', () => {
  const fake = { sample: () => ({ idx: 0, dist: 0, side: 0, half: 20, onRoad: true, tx: 1, tz: 0, nx: 0, nz: 0, y: 0, pad: false }),
    halfWidth: () => 20, surfaceY: () => 0, pl: { count: 1, pts: [{ x: 0, z: 0 }] } };
  const items = createItemSystem(fake, mulberry32(2));
  assert.equal(items.boxes.length, 0);
  const me = makeTestKart(0), rival = makeTestKart(1, { pos: { x: 15, y: 0, z: 0 } });
  me.item = ITEM.RED_SHELL; me.count = 1;
  items.use(me, { karts: [me, rival] });
  assert.equal(items.effects[0].homing, null);
  assert.ok(run(items, { karts: [me, rival] }, 1, () => rival.spin > 0), 'straight shell still hits');
});

test('one RNG stream gives a variety of items at the same running position', () => {
  // The player's report was "I keep getting the same pickup". The cause was upstream (the game
  // loop re-seeded the RNG every physics step), but this is the behaviour that must hold: with a
  // single stream, repeated boxes for the same place are not all the same item.
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(99));
  const k = place(track, makeTestKart(0), 30);
  k.place = 4;
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const b = items.boxes[i % items.boxes.length];
    k.pos.x = b.x; k.pos.z = b.z;
    k.item = 0; k.count = 0;
    const id = items.collect(k, { karts: [k] });
    if (id) seen.add(id);
    items.update(ITEMS.boxRespawn + 0.01, { karts: [k] });
  }
  assert.ok(seen.size >= 3, `only ${seen.size} distinct items over 40 boxes — the roll is stuck`);
});

test('regression 2026-11-08: a near-centered pass at 1.7 m must collect (was a squared/linear unit bug)', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(11));
  const k = place(track, makeTestKart(0), 30);
  const ctx = { karts: [k] };
  const b = items.boxes[2];
  k.pos.x = b.x + 1.7; k.pos.z = b.z;           // visually inside a 1.5 m crate's neighborhood
  assert.notEqual(items.collect(k, ctx), 0, '1.7 m from an empty-handed kart must be inside the 1.9 m pickup radius');
});

test('regression 2026-11-09: the RED shell is the stronger shell — measurably faster than a green one (both spawned at 42 m/s)', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(3));
  const speedOf = (item) => {
    const k = place(track, makeTestKart(item), item);
    k.item = item; k.count = 1;
    assert.ok(items.use(k, { karts: [k] }), 'the shell was not used');
    const e = items.effects.find((x) => x.item === item);
    assert.ok(e, 'no shell effect was spawned');
    return Math.hypot(e.vel.x, e.vel.z);
  };
  const green = speedOf(ITEM.GREEN_SHELL);
  const red = speedOf(ITEM.RED_SHELL);
  assert.ok(red > green * 1.2, `red ${red} m/s vs green ${green} m/s — red must be clearly stronger`);
});

test('regression 2026-11-08c: a 3-box cluster must not be machine-gunned — second pickup needs pickGap', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(5));
  const k = place(track, makeTestKart(0), 30);
  const ctx = { karts: [k] };
  const b1 = items.boxes[1], b2 = items.boxes[2];
  k.pos.x = b1.x; k.pos.z = b1.z;
  assert.notEqual(items.collect(k, ctx), 0, 'first box takes');
  k.pos.x = b2.x; k.pos.z = b2.z;                 // simulate driving straight into the next box
  assert.equal(items.collect(k, ctx), 0, 'inside pickGap no second box may be taken');
  assert.equal(b2.active, true, 'the second box stays for whoever comes later');
  items.update(ITEMS.pickGap + 0.1, ctx);         // wait out the gap
  k.item = 0; k.count = 0;                        // and use up what was in hand (2026-11-09: holding blocks regardless of the gap)
  assert.notEqual(items.collect(k, ctx), 0, 'after the gap, with an empty hand, it works again');
});

test('MAGNET (borrowed from Re-Volt, 2026-11-09): use sets magnetT and attaches a following effect', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(11));
  const me = place(track, makeTestKart(0), 60);
  const ctx = { karts: [me] };
  me.item = ITEM.MAGNET; me.count = 1;
  assert.ok(items.use(me, ctx), 'magnet use failed');
  assert.ok(me.magnetT >= ITEMS.magnet.time - 0.001, `magnetT=${me.magnetT}`);
  assert.equal(me.count, 0, 'magnet is single-shot');
  const fx = items.effects.find((e) => e.kind === 'magnet' && e.owner === me.id);
  assert.ok(fx, 'no following magnet effect');
});

test('MAGNET is in every position table (it helps any place equally)', () => {
  for (let p = 0; p < 6; p++) {
    const t = tableForPlace(p + 1, 6);
    assert.ok(t.some((e) => e.id === ITEM.MAGNET && e.w > 0), `place ${p + 1} has no magnet`);
  }
});

test('BOXING GLOVE (Re-Volt): punches the nearest kart ahead, misses what is behind', () => {
  const track = makeLoopTrack();
  const items = createItemSystem(track, mulberry32(7));
  const me = makeTestKart(0); me.heading = 0;   // forward = +Z
  const ahead = makeTestKart(1); ahead.pos = { x: 0, y: 0, z: 5 }; ahead.heading = 0;
  const behind = makeTestKart(2); behind.pos = { x: 0, y: 0, z: -5 }; behind.heading = 0;
  const ctx = { karts: [me, ahead, behind] };
  me.item = ITEM.GLOVE; me.count = 1;
  assert.ok(items.use(me, ctx));
  assert.ok(ahead.spin > 0, 'kart ahead should be spun out');
  assert.equal(behind.spin, 0, 'kart behind must be untouched');

  // out of range: still consumed, nobody spun (a punch in the air is a miss, not an error)
  const far = makeTestKart(3); far.pos = { x: 0, y: 0, z: 30 }; far.heading = 0;
  const me2 = makeTestKart(4); me2.heading = 0;
  const ctx2 = { karts: [me2, far] };
  me2.item = ITEM.GLOVE; me2.count = 1;
  assert.ok(items.use(me2, ctx2));
  assert.equal(far.spin, 0, 'out of range must miss');
});

test('glove never appears for the leader (chaser weapon, rows 2+ only)', () => {
  assert.ok(!ITEM_TABLE[0].some((e) => e.id === ITEM.GLOVE && e.w > 0));
  assert.ok(ITEM_TABLE[6].some((e) => e.id === ITEM.GLOVE && e.w > 0));
});
