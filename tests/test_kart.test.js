// tests/test_kart.test.js — kart physics + input contract (docs/INTERFACES.md §0, §2).
// Uses only fake tracks: stepKart must not need the real track module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KART, ITEMS, PLAYERS, KEYMAP } from '../src/config.js';
import { mulberry32 } from '../src/foundation.js';
import {
  createKart, stepKart, resolveKartCollisions, recoverKart, resetKart, applyBoost,
} from '../src/core/kart.js';
import { createControllers } from '../src/core/input.js';

const DT = 1 / 120;

// The exact fake track from the contract (§2): no walls, always on-road.
function fakeTrack(over = {}) {
  return {
    sample: (x, z) => ({ idx: 0, dist: 0, side: 0, half: 20, onRoad: true, tx: 1, tz: 0, nx: 0, nz: 0, y: 0, pad: false, ...over }),
    halfWidth: () => 20, surfaceY: () => 0, pl: { count: 1, pts: [{ x: 0, z: 0 }] },
  };
}
// Straight road along +x whose `side` really follows the kart (left normal = (0,-1) -> side = -z).
function straightTrack(half = 20) {
  return {
    sample: (x, z) => {
      const side = -z;
      return { idx: 0, dist: Math.abs(side), side, half, onRoad: Math.abs(side) <= half - KART.radius,
        tx: 1, tz: 0, nx: 0, nz: -1, y: 0, pad: false };
    },
    halfWidth: () => half, surfaceY: () => 0, pl: { count: 1, pts: [{ x: 0, z: 0 }] },
  };
}
// Circular ring road (radius R, travel counter-clockwise in heading terms), real geometry.
function ringTrack(R = 80, half = 9) {
  const N = 400;
  const pts = [], tangents = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push({ x: R * Math.cos(a), z: R * Math.sin(a) });
    tangents.push({ x: -Math.sin(a), z: Math.cos(a) });
  }
  return {
    sample: (x, z) => {
      const a = Math.atan2(z, x), r = Math.hypot(x, z);
      const tx = -Math.sin(a), tz = Math.cos(a);
      // travel tangent (-sin, cos); left of travel = (tz, -tx) = (cos a, sin a) = outward
      const side = r - R;
      let idx = Math.round(((a + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * N) % N;
      return { idx, dist: Math.abs(side), side, half, onRoad: Math.abs(side) <= half - KART.radius,
        tx, tz, nx: tz, nz: -tx, y: 0, pad: false };
    },
    halfWidth: () => half, surfaceY: () => 0, pl: { count: N, pts, tangents },
  };
}

function newKart(id = 0, human = true) { return createKart(id, PLAYERS[0], human); }
function drive(k, track, seconds, input, ctx = {}) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { Object.assign(k.input, input); stepKart(k, track, DT, ctx); }
}
const finite = (k) => [k.pos.x, k.pos.y, k.pos.z, k.heading, k.speed, k.vel.x, k.vel.z, k.lean, k.wheelSpin, k.steerVis]
  .every(Number.isFinite);

// ------------------------------------------------------------------ shape
test('createKart matches the §0 shape field for field', () => {
  const k = createKart(0, PLAYERS[0], true);
  assert.deepEqual(Object.keys(k), ['id', 'name', 'spec', 'human', 'ai', 'pos', 'heading', 'speed', 'vel', 'input',
    'drift', 'air', 'boost', 'item', 'count', 'star', 'invisible', 'shrunk', 'spin', 'offRoad', 'onPad', 'wallHit',
    'hitFlash', 'plIdx', 'lap', 'progress', 'place', 'finished', 'finishTime', 'raceTime', 'lapStart', 'lapTimes',
    'fx', 'lean', 'wheelSpin', 'steerVis']);
  assert.deepEqual(k.pos, { x: 0, y: 0, z: 0 });
  assert.deepEqual(k.vel, { x: 0, z: 0 });
  assert.deepEqual(k.input, { throttle: 0, steer: 0, drift: false, use: false });
  assert.deepEqual(k.drift, { on: false, dir: 0, time: 0, tier: -1 });
  assert.deepEqual(k.air, { y: 0, vy: 0, onGround: true });
  assert.deepEqual(k.boost, { time: 0, mul: 1 });
  assert.deepEqual(k.fx, { shake: 0, boost: 0, spark: -1, ag: 0 });
  assert.deepEqual(k.lapTimes, []);
  assert.equal(k.name, 'P1'); assert.equal(k.ai, null); assert.equal(k.spec, PLAYERS[0]);
  const cpu = createKart(3, { name: 'ZIP' }, false);
  assert.deepEqual(cpu.ai, {}); assert.equal(cpu.human, false); assert.equal(cpu.name, 'ZIP');
});

// ------------------------------------------------------------------ speed
test('full throttle reaches KART.maxSpeed within 6 s and never exceeds it', () => {
  const k = newKart(), tr = fakeTrack();
  let reachedAt = -1, peak = 0, peakVel = 0;
  for (let i = 0; i < 6 / DT; i++) {
    k.input.throttle = 1; stepKart(k, tr, DT, {});
    peak = Math.max(peak, k.speed); peakVel = Math.max(peakVel, Math.hypot(k.vel.x, k.vel.z));
    if (reachedAt < 0 && k.speed >= KART.maxSpeed - 1e-9) reachedAt = i * DT;
  }
  assert.ok(reachedAt >= 0 && reachedAt <= 6, `reached at ${reachedAt}`);
  assert.ok(peak <= KART.maxSpeed + 1e-9, `peak ${peak}`);
  assert.ok(peakVel <= KART.maxSpeed + 1e-9, `peak |vel| ${peakVel}`);
});

test('60 simulated seconds of random driving never exceed the configured top speed', () => {
  const rng = mulberry32(1234);
  const k = newKart(), tr = fakeTrack();
  let peak = 0, peakVel = 0, throttle = 1, steer = 0;
  for (let i = 0; i < 60 / DT; i++) {
    if (i % 30 === 0) { throttle = rng() < 0.8 ? 1 : rng() < 0.5 ? 0 : -1; steer = Math.floor(rng() * 3) - 1; }
    k.input.throttle = throttle; k.input.steer = steer; k.input.drift = false;
    stepKart(k, tr, DT, { rng });
    peak = Math.max(peak, k.speed); peakVel = Math.max(peakVel, Math.hypot(k.vel.x, k.vel.z));
    assert.ok(k.speed >= -KART.reverseMax - 1e-9);
  }
  assert.ok(peak <= KART.maxSpeed + 1e-9, `peak ${peak}`);
  assert.ok(peakVel <= KART.maxSpeed + 1e-9, `peak |vel| ${peakVel}`);
  assert.ok(peak > KART.maxSpeed * 0.95, 'it did actually drive fast');
  assert.ok(finite(k));
});

test('60 s with drifting: only drift boosts lift speed, never beyond maxSpeed*max(driftBoost)', () => {
  const rng = mulberry32(99);
  const k = newKart(), tr = fakeTrack();
  const cap = KART.maxSpeed * Math.max(...KART.driftBoost);
  let peak = 0, boosts = 0;
  for (let i = 0; i < 60 / DT; i++) {
    if (i % 60 === 0) { k.input.steer = rng() < 0.5 ? -1 : 1; k.input.drift = rng() < 0.7; }
    k.input.throttle = 1;
    const had = k.boost.time;
    stepKart(k, tr, DT, {});
    if (k.boost.time > had + 1e-9) boosts++;
    peak = Math.max(peak, k.speed);
    if (k.boost.time <= 0) assert.ok(k.speed <= KART.maxSpeed + 1e-9 || peak <= cap);
  }
  assert.ok(boosts > 0, 'some drift boosts fired');
  assert.ok(peak <= cap + 1e-9, `peak ${peak} > ${cap}`);
});

test('speed stays under maxSpeed*1.5 with a mushroom boost, and the boost does lift it', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 4, { throttle: 1 });
  applyBoost(k, KART.boostItemMul, KART.boostItemTime);
  let peak = 0;
  for (let i = 0; i < KART.boostItemTime / DT; i++) { k.input.throttle = 1; stepKart(k, tr, DT, {}); peak = Math.max(peak, k.speed); }
  assert.ok(peak < KART.maxSpeed * 1.5, `peak ${peak}`);
  assert.ok(peak > KART.maxSpeed * 1.3, `boost too weak: ${peak}`);
  drive(k, tr, 3, { throttle: 1 });
  assert.ok(k.boost.time === 0 && k.boost.mul === 1);
  assert.ok(Math.abs(k.speed - KART.maxSpeed) < 1e-6, 'bleeds back to maxSpeed after the boost');
});

test('fresh boost replaces a weaker one; a weaker one does not downgrade', () => {
  const k = newKart();
  applyBoost(k, KART.driftBoost[0], KART.driftBoostTime[0]);
  applyBoost(k, KART.boostItemMul, KART.boostItemTime);
  assert.equal(k.boost.mul, KART.boostItemMul); assert.equal(k.boost.time, KART.boostItemTime);
  applyBoost(k, KART.driftBoost[0], 10);
  assert.equal(k.boost.mul, KART.boostItemMul); assert.equal(k.boost.time, KART.boostItemTime);
});

test('reverse is capped at KART.reverseMax, brake stops forward motion first', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 3, { throttle: 1 });
  const v0 = k.speed;
  drive(k, tr, 0.25, { throttle: -1 });
  assert.ok(k.speed < v0 - KART.brake * 0.2, 'braking uses KART.brake');
  drive(k, tr, 8, { throttle: -1 });
  assert.ok(Math.abs(k.speed + KART.reverseMax) < 1e-6, `reverse ${k.speed}`);
});

test('coasting slows down with drag', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 4, { throttle: 1 });
  drive(k, tr, 2, { throttle: 0 });
  assert.ok(k.speed < KART.maxSpeed * Math.exp(-KART.drag * 2) + 0.5 && k.speed > 0);
});

// ------------------------------------------------------------------ steering
test('a 90° steer input turns the kart and does not flip it', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 2, { throttle: 1 });
  const h0 = k.heading;
  let t = 0;
  while (k.heading - h0 < Math.PI / 2 && t < 10) { k.input.throttle = 1; k.input.steer = 1; stepKart(k, tr, DT, {}); t += DT;
    assert.ok(Math.abs(k.lean) <= KART.bankMax + 1e-9, 'lean bounded by bankMax');
    assert.equal(k.air.y, 0); assert.ok(k.air.onGround);
  }
  assert.ok(k.heading - h0 >= Math.PI / 2, 'turned 90° (steer +1 = heading increases = right)');
  assert.ok(t < 3, `took ${t}s`);
  assert.ok(finite(k));
  assert.ok(k.lean < 0, 'body rolls outward (left) in a right turn');
  assert.ok(k.steerVis > 0);
  // the slide: velocity lags heading while turning
  const velH = Math.atan2(k.vel.z, k.vel.x);
  assert.ok(k.heading - velH > 0.01, 'velocity lags the heading (slide)');
  // straighten: velocity realigns with heading through grip
  drive(k, tr, 1.5, { throttle: 1, steer: 0 });
  const lag = Math.atan2(Math.sin(k.heading - Math.atan2(k.vel.z, k.vel.x)), Math.cos(k.heading - Math.atan2(k.vel.z, k.vel.x)));
  assert.ok(Math.abs(lag) < 1e-3, `lag ${lag}`);
  assert.ok(Math.abs(k.lean) < 0.01);
});

test('no steering when stopped; airborne steering is reduced to KART.airSteer', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 1, { throttle: 0, steer: 1 });
  assert.equal(k.heading, 0);
  const a = newKart(), b = newKart();
  drive(a, tr, 2, { throttle: 1 }); drive(b, tr, 2, { throttle: 1 });
  b.air.onGround = false; b.air.y = 5; b.air.vy = 0;
  a.input.steer = 1; b.input.steer = 1;
  stepKart(a, tr, DT, {}); stepKart(b, tr, DT, {});
  assert.ok(Math.abs(b.heading / a.heading - KART.airSteer) < 1e-9);
});

// ------------------------------------------------------------------ drift chain
test('regression 2026-11-09: holding drift latches without steering, survives a centered wheel, and never hops', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 2, { throttle: 1 });
  k.input.drift = true;                       // straight: no steer at all
  stepKart(k, tr, DT, {});
  assert.ok(k.drift.on && k.drift.dir === 0, 'drift must latch on a straight');
  assert.ok(k.air.onGround && k.air.y === 0, 'drift must not launch the kart (the model "glitched into the ground")');
  k.input.steer = 1; stepKart(k, tr, DT, {});   // then steer
  assert.equal(k.drift.dir, 0);               // dir stays as latched (straight), steering passes through
  k.input.steer = 0;                          // center the wheel mid-drift
  for (let i = 0; i < 10; i++) stepKart(k, tr, DT, {});
  assert.ok(k.drift.on, 'a centered wheel must not cancel the drift');
  k.input.drift = false; stepKart(k, tr, DT, {});   // releasing still ends it
  assert.ok(!k.drift.on);
});

test('drift for 1.2 s reaches tier >= 0 and releasing sets boost.time > 0', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 2, { throttle: 1 });
  drive(k, tr, 1.2, { throttle: 1, steer: 1, drift: true });
  assert.ok(k.drift.on);
  assert.ok(k.drift.tier >= 0, `tier ${k.drift.tier}`);
  assert.equal(k.fx.spark, k.drift.tier);
  const tier = k.drift.tier;
  drive(k, tr, DT, { throttle: 1, steer: 1, drift: false });
  assert.ok(k.boost.time > 0);
  assert.equal(k.boost.mul, KART.driftBoost[tier]);
  assert.ok(Math.abs(k.boost.time - (KART.driftBoostTime[tier] - DT)) < 1e-9 || k.boost.time <= KART.driftBoostTime[tier]);
  assert.equal(k.drift.on, false); assert.equal(k.drift.tier, -1); assert.equal(k.fx.spark, -1);
  assert.ok(k.fx.boost > 0);
});

test('tier timing follows KART.driftCharge exactly; tier 2 needs >= driftCharge[2]', () => {
  const k = newKart(), tr = fakeTrack();
  drive(k, tr, 2, { throttle: 1 });
  const seen = [];
  let t = 0;
  for (let i = 0; i < (KART.driftCharge[2] + 0.5) / DT; i++) {
    Object.assign(k.input, { throttle: 1, steer: 1, drift: true });
    stepKart(k, tr, DT, {});
    t = k.drift.time;
    if (seen[seen.length - 1]?.tier !== k.drift.tier) seen.push({ tier: k.drift.tier, t });
    if (k.drift.tier === 2) assert.ok(k.drift.time >= KART.driftCharge[2] - 1e-9);
    if (k.drift.time < KART.driftCharge[2] - 1e-9) assert.ok(k.drift.tier < 2);
  }
  assert.deepEqual(seen.map((s) => s.tier), [-1, 0, 1, 2]);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(seen[i + 1].t - KART.driftCharge[i]) <= DT + 1e-9);
  assert.ok(k.speed > 15, `drift keeps its speed: ${k.speed}`);
  drive(k, tr, DT, { throttle: 1, steer: 1, drift: false });    // releasing the DRIFT key fires (centering the wheel does not, 2026-11-09)
  assert.equal(k.boost.mul, KART.driftBoost[2]);
});

test('drift released before driftCharge[0] gives no boost; no drift below speed; straight drift allowed (2026-11-09)', () => {
  const tr = fakeTrack();
  const k = newKart();
  drive(k, tr, 2, { throttle: 1 });
  drive(k, tr, KART.driftCharge[0] * 0.5, { throttle: 1, steer: 1, drift: true });
  drive(k, tr, DT, { throttle: 1, steer: 1, drift: false });
  assert.equal(k.boost.time, 0);
  const slow = newKart();
  drive(slow, tr, 0.2, { throttle: 1, steer: 1, drift: true });
  assert.equal(slow.drift.on, false);
  const straight = newKart();
  drive(straight, tr, 2, { throttle: 1 });
  drive(straight, tr, 0.5, { throttle: 1, steer: 0, drift: true });
  assert.equal(straight.drift.on, true, 'holding drift on a straight must charge a mini-turbo');
});

test('drifting grip slides more than normal grip', () => {
  const tr = fakeTrack();
  const a = newKart(), b = newKart();
  drive(a, tr, 3, { throttle: 1 }); drive(b, tr, 3, { throttle: 1 });
  drive(a, tr, 0.8, { throttle: 1, steer: 1 });
  drive(b, tr, 0.8, { throttle: 1, steer: 1, drift: true });
  const slip = (k) => Math.abs(Math.atan2(Math.sin(k.heading - Math.atan2(k.vel.z, k.vel.x)), Math.cos(k.heading - Math.atan2(k.vel.z, k.vel.x))));
  assert.ok(slip(b) > slip(a) * 1.5, `drift slip ${slip(b)} vs grip ${slip(a)}`);
});

// ------------------------------------------------------------------ walls / off-road / pads
test('a fake wall (side forced to half+3) leaves the kart inside after one step with reduced speed', () => {
  const tr = straightTrack(20);
  const k = newKart();
  drive(k, tr, 3, { throttle: 1 });
  const v0 = k.speed;
  k.pos.z = -(20 + 3);                                         // side = half + 3
  assert.equal(tr.sample(k.pos.x, k.pos.z).side, 23);
  stepKart(k, tr, DT, {});
  const s = tr.sample(k.pos.x, k.pos.z);
  assert.ok(Math.abs(s.side) <= s.half - KART.radius + 1e-9, `side ${s.side}`);
  assert.ok(k.speed < v0 * KART.wallSpeedLoss + 0.5, `speed ${k.speed} vs ${v0}`);
  assert.ok(k.wallHit > 0 && k.fx.shake > 0);
});

test('the contract fake track with side forced to half+3 still clamps (normal from tangent)', () => {
  const k = newKart();
  let z = 0;
  const tr = { ...fakeTrack(), sample: (x, zz) => ({ idx: 0, dist: 0, side: 23 - (z - zz), half: 20, onRoad: false, tx: 1, tz: 0, nx: 0, nz: 0, y: 0, pad: false }) };
  k.speed = 20; k.vel.x = 20;
  z = 0;
  stepKart(k, tr, DT, {});
  // left normal from tangent (1,0) is (0,-1); side was 23 -> moved +z by 3 + radius
  assert.ok(Math.abs(k.pos.z - (3 + KART.radius)) < 1e-9, `z ${k.pos.z}`);
  assert.ok(k.speed < 20 * KART.wallSpeedLoss + 1e-9);
});

test('driving into a wall at an angle reflects outward velocity with KART.wallBounce', () => {
  const tr = straightTrack(10);
  const k = newKart();
  k.heading = -Math.PI / 4;                                   // heading toward -z = toward the left wall
  k.speed = 20; k.vel.x = 20 * Math.cos(k.heading); k.vel.z = 20 * Math.sin(k.heading);
  let hit = false;
  for (let i = 0; i < 2 / DT; i++) {
    k.input.throttle = 1; stepKart(k, tr, DT, {});
    const s = tr.sample(k.pos.x, k.pos.z);
    assert.ok(Math.abs(s.side) <= s.half - KART.radius + 1e-9);
    if (k.wallHit > 0 && !hit) { hit = true; assert.ok(k.vel.z >= 0, 'outward (-z) velocity reflected'); }
  }
  assert.ok(hit);
  assert.ok(finite(k));
});

test('off-road (onRoad=false) tops out near maxSpeed*KART.offRoadMul and is flagged', () => {
  const tr = fakeTrack({ onRoad: false });
  const k = newKart();
  drive(k, tr, 10, { throttle: 1 });
  assert.equal(k.offRoad, true);
  assert.ok(Math.abs(k.speed - KART.maxSpeed * KART.offRoadMul) < 0.05, `speed ${k.speed}`);
  // entering off-road at full speed bleeds speed down instead of exceeding the cap forever
  const k2 = newKart();
  drive(k2, fakeTrack(), 4, { throttle: 1 });
  drive(k2, tr, 3, { throttle: 1 });
  assert.ok(k2.speed <= KART.maxSpeed * KART.offRoadMul + 1e-6);
});

test('boost pad gives KART.padMul for KART.padTime', () => {
  const k = newKart();
  drive(k, fakeTrack(), 3, { throttle: 1 });
  drive(k, fakeTrack({ pad: true }), DT, { throttle: 1 });
  assert.ok(k.onPad);
  assert.equal(k.boost.mul, KART.padMul);
  assert.ok(Math.abs(k.boost.time - KART.padTime) < 1e-9);
  drive(k, fakeTrack(), DT, { throttle: 1 });
  assert.equal(k.onPad, false);
});

test('surface height + hop give pos.y', () => {
  const tr = { ...fakeTrack(), surfaceY: () => 4.5 };
  const k = newKart();
  drive(k, tr, 0.1, { throttle: 1 });
  assert.equal(k.pos.y, 4.5);
});

// ------------------------------------------------------------------ item effects in driving
test('a kart held in spin cannot accelerate; its steering is locked', () => {
  const tr = fakeTrack();
  const k = newKart();
  k.spin = 10;
  drive(k, tr, 3, { throttle: 1, steer: 1 });
  assert.equal(k.speed, 0); assert.equal(k.heading, 0);
  const m = newKart();
  drive(m, tr, 3, { throttle: 1 });
  m.spin = ITEMS.spinOutTime;
  let prev = m.speed;
  for (let i = 0; i < 0.5 / DT; i++) { m.input.throttle = 1; stepKart(m, tr, DT, {}); assert.ok(m.speed <= prev); prev = m.speed; }
  drive(m, tr, ITEMS.spinOutTime, { throttle: 1 });
  assert.equal(m.spin, 0);
  assert.ok(m.speed > 0, 'drives again after the spin ends');
});

test('star raises the cap by KART.starMul, shrunk lowers it to 0.85', () => {
  const tr = fakeTrack();
  const s = newKart(); s.star = 30; drive(s, tr, 8, { throttle: 1 });
  assert.ok(Math.abs(s.speed - KART.maxSpeed * KART.starMul) < 1e-6);
  const m = newKart(); m.shrunk = 30; drive(m, tr, 8, { throttle: 1 });
  assert.ok(Math.abs(m.speed - KART.maxSpeed * 0.85) < 1e-6);
  const i = newKart(); i.invisible = 30; drive(i, tr, 8, { throttle: 1 });
  assert.ok(Math.abs(i.speed - KART.maxSpeed) < 1e-6, 'invisible is inert for driving');
});

// ------------------------------------------------------------------ kart vs kart
test('two overlapping karts get separated and pushed apart', () => {
  const a = newKart(0), b = newKart(1);
  a.pos.x = 0; b.pos.x = 1.0;
  resolveKartCollisions([a, b]);
  assert.ok(Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z) >= KART.bumperRadius * 2 - 1e-9);
  assert.ok(a.vel.x < 0 && b.vel.x > 0, 'pushed apart');
  // perfectly stacked karts still separate deterministically
  const c = newKart(2), d = newKart(3);
  resolveKartCollisions([c, d]);
  assert.ok(Math.hypot(d.pos.x - c.pos.x, d.pos.z - c.pos.z) >= KART.bumperRadius * 2 - 1e-9);
  // non-overlapping karts are untouched
  const e = newKart(4), f = newKart(5); f.pos.x = 10;
  resolveKartCollisions([e, f]);
  assert.equal(e.pos.x, 0); assert.equal(f.pos.x, 10); assert.equal(e.vel.x, 0);
});

test('a kart under a STAR pushes the other instead (and spins it out)', () => {
  const a = newKart(0), b = newKart(1);
  a.star = 5; b.pos.x = 2; b.speed = 20;
  resolveKartCollisions([a, b]);
  assert.equal(a.pos.x, 0); assert.equal(a.vel.x, 0);
  assert.ok(b.pos.x >= KART.bumperRadius * 2 - 1e-9);
  assert.equal(b.spin, ITEMS.spinOutTime);
  assert.ok(b.hitFlash > 0);
});

// ------------------------------------------------------------------ recover / reset / determinism
test('recoverKart puts it on-road at plIdx with speed 0', () => {
  const tr = ringTrack();
  const k = newKart();
  k.plIdx = 100; k.pos.x = 500; k.pos.z = -300; k.speed = 25; k.vel.x = 3; k.drift.on = true; k.spin = 1;
  recoverKart(k, tr);
  const s = tr.sample(k.pos.x, k.pos.z);
  assert.ok(s.onRoad); assert.equal(k.speed, 0); assert.deepEqual(k.vel, { x: 0, z: 0 });
  assert.equal(k.drift.on, false); assert.equal(k.plIdx, 100);
  const t = tr.pl.tangents[100];
  assert.ok(Math.abs(Math.cos(k.heading) - t.x) < 1e-9 && Math.abs(Math.sin(k.heading) - t.z) < 1e-9);
  // contract fake track (no tangents)
  const k2 = newKart(); k2.pos.x = 99; k2.speed = 5;
  recoverKart(k2, fakeTrack());
  assert.equal(k2.pos.x, 0); assert.equal(k2.speed, 0); assert.ok(fakeTrack().sample(0, 0).onRoad);
});

test('resetKart places the kart on its grid slot and clears driving state, not race state', () => {
  const calls = [];
  const tr = { ...fakeTrack(), gridSlot: (i, n) => { calls.push([i, n]); return { x: -5 * i, z: 3, heading: 1.2 }; } };
  const k = newKart();
  k.speed = 20; k.boost.time = 3; k.star = 2; k.lap = 2; k.plIdx = 44; k.item = 3; k.drift.on = true;
  resetKart(k, 2, tr);
  assert.deepEqual(calls[0], [2, 6]);
  assert.equal(k.pos.x, -10); assert.equal(k.pos.z, 3); assert.equal(k.heading, 1.2);
  assert.equal(k.speed, 0); assert.equal(k.boost.time, 0); assert.equal(k.star, 0); assert.equal(k.drift.on, false);
  assert.equal(k.item, 0);
  assert.equal(k.lap, 2); assert.equal(k.plIdx, 44);
});

test('stepKart is deterministic and never touches plIdx / lap state', () => {
  const run = () => {
    const rng = mulberry32(7);
    const k = newKart(); k.plIdx = 17;
    const tr = straightTrack(12);
    for (let i = 0; i < 20 / DT; i++) {
      if (i % 45 === 0) { k.input.steer = Math.floor(rng() * 3) - 1; k.input.drift = rng() < 0.5; }
      k.input.throttle = 1;
      stepKart(k, tr, DT, { rng, time: i * DT });
    }
    return k;
  };
  const a = run(), b = run();
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.plIdx, 17); assert.equal(a.lap, 0); assert.equal(a.progress, 0);
});

test('fx hooks are called when provided and optional when not', () => {
  const calls = { burst: 0, ring: 0, trail: 0 };
  const fx = { burst: () => calls.burst++, ring: () => calls.ring++, trail: () => calls.trail++ };
  const k = newKart();
  drive(k, fakeTrack(), 2, { throttle: 1 }, { fx });
  drive(k, fakeTrack(), 1.5, { throttle: 1, steer: 1, drift: true }, { fx });
  drive(k, fakeTrack(), DT, { throttle: 1, steer: 0, drift: false }, { fx });
  drive(k, fakeTrack({ onRoad: false }), 0.5, { throttle: 1 }, { fx });
  assert.ok(calls.burst > 0 && calls.ring > 0 && calls.trail > 0, JSON.stringify(calls));
  const partial = { burst: () => {} };                         // missing methods must not throw
  drive(newKart(), fakeTrack({ pad: true }), 1, { throttle: 1 }, { fx: partial });
});

// ------------------------------------------------------------------ track independence
test('stepKart needs only track.sample/surfaceY — no lap walk over a real track is required', () => {
  const base = straightTrack(15);
  const used = new Set();
  const tr = new Proxy(base, { get(t, p) { used.add(p); if (p === 'sample' || p === 'surfaceY') return t[p];
    throw new Error(`stepKart touched track.${String(p)}`); } });
  const k = newKart();
  for (let i = 0; i < 10 / DT; i++) {
    k.input.throttle = 1; k.input.steer = i % 400 < 200 ? 1 : -1; k.input.drift = i % 300 < 150;
    stepKart(k, tr, DT, {});
  }
  assert.deepEqual([...used].sort(), ['sample', 'surfaceY']);
});

test('a simple autopilot laps a fake ring road without ever leaving it', () => {
  const tr = ringTrack(80, 9);
  const k = newKart();
  k.pos.x = 80; k.pos.z = 0; k.heading = Math.PI / 2;             // tangent at angle 0 is (0,1)
  let angle = 0, prevA = 0;
  for (let i = 0; i < 40 / DT && angle < Math.PI * 2; i++) {
    const s = tr.sample(k.pos.x, k.pos.z);
    const target = Math.atan2(s.tz, s.tx) + s.side * 0.08;        // side>0 = left = outside; right (+heading) = inward
    const err = Math.atan2(Math.sin(target - k.heading), Math.cos(target - k.heading));
    k.input.throttle = 1; k.input.steer = Math.max(-1, Math.min(1, err * 3));
    stepKart(k, tr, DT, {});
    const a = Math.atan2(k.pos.z, k.pos.x);
    angle += Math.atan2(Math.sin(a - prevA), Math.cos(a - prevA)); prevA = a;
    const s2 = tr.sample(k.pos.x, k.pos.z);
    assert.ok(Math.abs(s2.side) <= s2.half - KART.radius + 1e-9);
  }
  assert.ok(angle >= Math.PI * 2, `lapped ${angle}`);
});

// ------------------------------------------------------------------ input
test('createControllers: press/release -> intent, use is an edge', () => {
  const [p1, p2, cpu] = createControllers(3, [{ human: true, keys: 'wasd' }, { human: true, keys: 'arrows' }, { human: false }]);
  assert.equal(p1.keys, 'wasd'); assert.deepEqual(p1.map, KEYMAP.wasd);
  assert.equal(p2.keys, 'arrows'); assert.equal(cpu.human, false);
  assert.deepEqual(p1.intent(), { throttle: 0, steer: 0, drift: false, use: false });
  p1.press('up'); p1.press('right'); p1.press('drift'); p1.press('use');
  assert.deepEqual(p1.intent(), { throttle: 1, steer: 1, drift: true, use: true });
  assert.equal(p1.intent().use, false, 'use fires once per press');
  p1.press('use');
  assert.equal(p1.intent().use, false, 'holding use does not re-fire');
  p1.release('use'); p1.press('use');
  assert.equal(p1.intent().use, true);
  p1.press('down'); p1.press('left');
  assert.deepEqual(p1.intent(), { throttle: 0, steer: 0, drift: true, use: false });
  p1.release('up'); p1.release('right');
  assert.deepEqual(p1.intent(), { throttle: -1, steer: -1, drift: true, use: false });
});

test('attach/detach wire keyboard events per keymap without touching the other player', () => {
  const listeners = {};
  const target = {
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter((g) => g !== f); },
  };
  const fire = (type, code, extra = {}) => { let prevented = 0;
    for (const f of listeners[type] || []) f({ code, preventDefault: () => prevented++, ...extra }); return prevented; };
  const [p1, p2] = createControllers(2, [{ human: true, keys: 'wasd' }, { human: true, keys: 'arrows' }]);
  p1.attach(target); p2.attach(target);
  assert.ok(fire('keydown', 'KeyW') > 0);
  fire('keydown', 'ArrowLeft'); fire('keydown', 'Slash');
  assert.equal(p1.intent().throttle, 1); assert.equal(p2.intent().throttle, 0);
  const i2 = p2.intent();
  assert.equal(i2.steer, -1);
  fire('keydown', 'Space'); fire('keydown', 'Space', { repeat: true });
  assert.equal(p1.intent().use, true); assert.equal(p1.intent().use, false);
  fire('keyup', 'KeyW');
  assert.equal(p1.intent().throttle, 0);
  fire('keydown', 'KeyD'); listeners.blur.forEach((f) => f());
  assert.equal(p1.intent().steer, 0, 'blur releases keys');
  p1.detach();
  fire('keydown', 'KeyW');
  assert.equal(p1.intent().throttle, 0, 'detached');
  assert.equal(fire('keydown', 'KeyQ'), 0, 'unmapped keys are not swallowed');
  // attach() without a window in node is a harmless no-op
  createControllers(1, [{ human: true, keys: 'wasd' }])[0].attach();
});

// ------------------------------------------------------------------ anti-gravity banks (§7)
// Straight road along +x (side = -z) whose whole length is an AG range with a real half-pipe height.
function agTrack(half = 10, amp = 2.6, ag = true) {
  const t = straightTrack(half);
  const bank = (z) => (ag ? amp * Math.min(1, Math.abs(z) / half) ** 2 : 0);
  return { ...t, sample: (x, z) => ({ ...t.sample(x, z), ag, y: bank(z) }), surfaceY: (x, z) => bank(z) };
}

test('AG: steering hard into the bank climbs it, keeps speed (no wall hit), then returns inward', () => {
  const half = 10, amp = 2.6, tr = agTrack(half, amp);
  const k = newKart();
  drive(k, tr, 3, { throttle: 1 });
  const v0 = k.speed;
  let yMax = 0, sideMax = 0;
  for (let i = 0; i < 1.5 / DT; i++) {
    k.input.throttle = 1; k.input.steer = -1; stepKart(k, tr, DT, {});
    const s = tr.sample(k.pos.x, k.pos.z);
    yMax = Math.max(yMax, k.pos.y); sideMax = Math.max(sideMax, Math.abs(s.side));
    assert.equal(k.wallHit, 0, 'no wall hit inside AG');
    assert.equal(k.offRoad, false, 'no off-road penalty inside AG');
    assert.ok(Math.abs(s.side) <= half + 1.0 + 1e-9, `side ${s.side}`);
  }
  assert.ok(sideMax > half, `rode past the road edge (${sideMax})`);
  assert.ok(yMax > amp * 0.9, `climbed the bank (y ${yMax})`);
  assert.ok(k.speed >= v0 * 0.9, `kept speed ${k.speed} vs ${v0}`);
  assert.equal(k.fx.ag, 1);
  let sideMin = Infinity;
  for (let i = 0; i < 3 / DT; i++) {
    k.input.throttle = 1; k.input.steer = 0; stepKart(k, tr, DT, {});
    sideMin = Math.min(sideMin, Math.abs(tr.sample(k.pos.x, k.pos.z).side));
  }
  assert.ok(sideMin < half * 0.6, `returned inward without steering (min |side| ${sideMin})`);
  assert.ok(finite(k));
});

test('AG off: the same hard steer still hits the wall and cuts speed (old behaviour intact)', () => {
  const half = 10, tr = agTrack(half, 2.6, false);
  const k = newKart();
  drive(k, tr, 3, { throttle: 1 });
  const v0 = k.speed;
  let hit = false, vMin = Infinity;
  for (let i = 0; i < 1.5 / DT; i++) {
    k.input.throttle = 1; k.input.steer = -1; stepKart(k, tr, DT, {});
    if (k.wallHit > 0) hit = true;
    vMin = Math.min(vMin, k.speed);
    assert.ok(Math.abs(tr.sample(k.pos.x, k.pos.z).side) <= half - KART.radius + 1e-9);
  }
  assert.ok(hit, 'wall hit');
  assert.ok(vMin < v0 * KART.wallSpeedLoss + 0.5, `speed cut ${vMin} vs ${v0}`);
  assert.equal(k.fx.ag, 0);
});

test('AG: inward assist grows with speed², fx.ag decays to 0 over 0.5 s after leaving', () => {
  const half = 10, tr = agTrack(half);
  const pull = (v, z = -half * 0.95) => {
    const k = newKart();
    k.pos.z = z; k.speed = v; k.vel.x = v;                       // on the left bank, heading along
    stepKart(k, tr, DT, {});
    return k.heading * k.speed / DT;                             // lateral accel = yaw rate * v, + = toward centre
  };
  const p10 = pull(10), p20 = pull(20);
  assert.ok(p10 > 0 && p20 > 0, `inward ${p10} ${p20}`);
  assert.ok(Math.abs(p20 / p10 - 4) < 0.6, `∝ speed² (ratio ${p20 / p10})`);
  assert.equal(pull(10, -half * 0.3), 0, 'no assist low on the bank');
  const k = newKart();
  k.pos.z = -half * 0.3; k.speed = 10; k.vel.x = 10;
  stepKart(k, tr, DT, {});
  assert.equal(k.fx.ag, 1);
  const flat = agTrack(half, 2.6, false);
  drive(k, flat, 0.25, { throttle: 1 });
  assert.ok(k.fx.ag > 0.4 && k.fx.ag < 0.6, `half-decayed ${k.fx.ag}`);
  drive(k, flat, 0.3, { throttle: 1 });
  assert.equal(k.fx.ag, 0);
});

// ------------------------------------------------------------------ magnet (Re-Volt)
test('MAGNET auto-steers a misaligned kart back onto the centre line', () => {
  const k = newKart(), tr = straightTrack();
  drive(k, tr, 2, { throttle: 1 });
  k.heading = 0.6;                                  // knock it off line
  k.magnetT = 5;
  drive(k, tr, 1.0, { throttle: 1 });               // steer input: none
  const err = Math.abs(((k.heading + Math.PI) % (2 * Math.PI)) - Math.PI);   // vs tangent atan2(0,1)=0
  assert.ok(err < 0.05, `magnet left heading error ${err.toFixed(3)} rad`);
  assert.ok(k.magnetT < 5 - 0.9, 'magnet timer must tick down');
});

test('kart.vmul scales top speed (the AI straight-line lever)', async () => {
  const { maxEffOf } = await import('../src/core/kart.js');
  const k = newKart();
  const base = maxEffOf(k);
  k.vmul = 1.3;
  assert.ok(maxEffOf(k) > base * 1.29, 'vmul must raise the speed ceiling');
});
