// net.js wire tests — codec round-trip, interpolation, input quantization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packSnap, unpackKart, createReceiver, blendKart, packInput, applyInput, applySnap, INTERP_DELAY } from '../src/core/net.js';

const fakeKart = (id) => ({
  id, pos: { x: 10.005 + id, y: 1.234, z: -20.678 }, heading: 1.234, speed: 25.5, vel: { x: 1.1, z: 2.2 },
  lap: 1, finished: false, finishTime: 0, item: 4, count: 2, boost: { time: 1.5, mul: 1.3 },
  spin: 0, star: 0.5, invisible: 0, shrunk: 0, lean: 0.2, plIdx: 7,
  drift: { on: true, dir: 1, time: 2, tier: 1 }, input: { throttle: 0.55, steer: -0.33, drift: true, use: false },
});
const fakeRace = { clock: 42.31, phase: 'racing', countdown: 0 };

test('packSnap/unpackKart round-trips every driven field within quantization', () => {
  const k = fakeKart(3);
  const snap = packSnap(fakeRace, [k], null);
  const u = unpackKart(snap.k[0]);
  assert.equal(u.i, 3);
  assert.ok(Math.abs(u.x - k.pos.x) < 0.011 && Math.abs(u.z - k.pos.z) < 0.011, 'cm quantization');
  assert.ok(Math.abs(u.h - k.heading) < 0.0011 && Math.abs(u.s - k.speed) < 0.011);
  assert.deepEqual({ lap: u.lap, it: u.it, ct: u.ct, ft: u.ft }, { lap: 1, it: 4, ct: 2, ft: 0 });
  assert.ok(Math.abs(u.bt - 1.5) < 0.011 && Math.abs(u.bm - 1.3) < 0.011);
  assert.equal(u.dt, 1); assert.equal(u.dr, 1); assert.equal(u.pi, 7);
  // wire stays numbers-only (JSON-safe for a DataConnection)
  assert.equal(JSON.parse(JSON.stringify(snap)).c, 42.31);
});

test('inputs quantize to 2 bytes of intent and drive the input exactly', () => {
  const k = fakeKart(0);
  const m = packInput(k);
  const dst = fakeKart(0); dst.input = { throttle: 0, steer: 0, drift: false, use: false };
  applyInput(dst, m);
  assert.ok(Math.abs(dst.input.throttle - 0.55) < 0.011 && Math.abs(dst.input.steer + 0.33) < 0.011);
  assert.equal(dst.input.drift, true);
  assert.ok(Math.abs(m.th) <= 100 && Math.abs(m.st) <= 100, 'quantized to <=100 (2 bytes)');
});

test('receiver interpolates between snapshots at INTERP_DELAY behind wall time', () => {
  const rec = createReceiver();
  const k0 = fakeKart(1);
  const s1 = packSnap(fakeRace, [k0], null);
  const k1 = fakeKart(1); k1.pos.x += 10; k1.pos.z += 10;
  const s2 = packSnap(fakeRace, [k1], null);
  rec.feed(s1, 1.0);
  rec.feed(s2, 1.2);
  const at = rec.at(1.1 + INTERP_DELAY);   // interp point lands midway between the two snaps
  assert.ok(at, 'no snapshot');
  assert.ok(Math.abs(at.ks[0].x - (s1.k[0].x + s2.k[0].x) / 2 / 100) < 0.05, 'mid-blend at t=0.5');
});

test('heading blends the short way across the ±π seam', () => {
  const A = { i: 0, h: Math.PI - 0.05, x: 0, y: 0, z: 0, s: 0, vx: 0, vz: 0, ft: 0, bt: 0, bm: 0, sp: 0, st: 0, iv: 0, sh: 0, ln: 0, lap: 0, fin: 0, it: 0, ct: 0, dt: 0, dr: -1, pi: 0 };
  const B = { ...A, h: -Math.PI + 0.05 };
  const m = blendKart(A, B, 0.5);
  assert.ok(Math.abs(Math.abs(m.h)) > 3.0, `should stay near ±π, got ${m.h}`);
});

test('applySnap mirrors the world; own kart is corrected softly, others hard', () => {
  const mk = (id) => Object.assign(fakeKart(id), { input: { throttle: 0, steer: 0, drift: false, use: false } });
  const karts = [mk(0), mk(1)];
  const race = { clock: 0, phase: 'countdown', countdown: 3, step() {} };
  const k = fakeKart(1); k.pos.x = 100;
  const snap = packSnap({ clock: 7.5, phase: 'racing', countdown: 0 }, [fakeKart(0), k], null);
  const rec = { ks: snap.k.map(unpackKart), raw: snap };
  karts[0].pos.x = 12;   // local prediction diverged 2 m past the host's truth
  applySnap(karts, race, rec, 0, 0.3);
  assert.equal(race.phase, 'racing'); assert.equal(race.clock, 7.5);
  assert.ok(Math.abs(karts[1].pos.x - 100) < 0.011, 'remote kart hard-syncs');
  assert.ok(karts[0].pos.x > 11.3 && karts[0].pos.x < 11.5, `own kart soft-corrects only 30%: ${karts[0].pos.x}`);
});

test('own-kart correction never hard-sets speed (hard sets vibrate the guest camera, 2026-11-09)', () => {
  const k = fakeKart(0);
  k.pos.x = 5; k.heading = 0.2; k.speed = 12; k.vel.x = 12; k.vel.z = 0;
  const karts = [k];
  const race = { clock: 0, phase: 'racing', countdown: 0, step() {} };
  const truth = fakeKart(0);
  truth.pos.x = 25; truth.heading = 0.9; truth.speed = 30; truth.vel.x = 30; truth.vel.z = 0;
  const snap = packSnap({ clock: 1, phase: 'racing', countdown: 0 }, [truth], null);
  const rec = createReceiver(); rec.feed(snap, 0);
  applySnap(karts, race, rec.at(0.13), 0, 0.3);
  assert.ok(k.speed > 12 && k.speed < 30, `own speed must blend, got ${k.speed}`);
  assert.ok(k.vel.x > 12 && k.vel.x < 30, `own velocity must blend, got ${k.vel.x}`);
});

test('inputs survive the wire unchanged at quantized precision (prediction identity)', () => {
  const k = fakeKart(0);
  k.input.throttle = 1; k.input.steer = -0.37421; k.input.drift = true; k.input.use = false;
  applyInput(k, packInput(k));
  const before = { ...k.input };
  applyInput(k, packInput(k));
  assert.deepEqual({ th: before.steer }, { th: k.input.steer }, 'quantized input must be a fixed point of the wire format');
});
