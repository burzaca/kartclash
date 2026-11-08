// tests/test_models.test.js — pure helpers of the v3 GLB kart + AG track look (no asset loading).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { KART_LEN, repaintFor, fitTransform, seatTransform, flameLook, FLAME_COLORS, buildKartModel } from '../src/render/kartModel.js';
import { agWeights, buildTrackScene } from '../src/render/trackMesh.js';
import { buildTrack } from '../src/core/track.js';
import { TRACKS, PLAYERS } from '../src/config.js';

test('repaint by material name: paint -> colour, steel -> trim, iron/rubber keep parsed', () => {
  const spec = PLAYERS[0];
  assert.equal(repaintFor('Green paint', spec), spec.color);
  assert.equal(repaintFor('Steel', spec), spec.trim);
  assert.equal(repaintFor('Dark iron', spec), null);
  assert.equal(repaintFor('Rubber', spec), null);
});

test('fit: longest horizontal side -> KART_LEN, centred on x/z, lowest point on y=0', () => {
  // pixor.glb's measured box: 1.302 x 0.662 x 1.85, z off-centre
  const f = fitTransform({ x: -0.651, y: 0, z: -0.85 }, { x: 0.651, y: 0.662, z: 1 });
  assert.ok(Math.abs(f.scale - KART_LEN / 1.85) < 1e-12);
  assert.ok(Math.abs(f.offset.z + 0.075 * f.scale) < 1e-12 && Math.abs(f.offset.x) < 1e-12);
  // wider than long, floating at y=2: x drives the scale, lifted to the ground
  const g = fitTransform({ x: 0, y: 2, z: -1 }, { x: 4, y: 3, z: 1 }, 2);
  assert.equal(g.scale, 0.5);
  assert.deepEqual([g.offset.x, g.offset.y, g.offset.z + 0], [-1, -1, 0]);   // +0 folds -0
});

test('seat: driver scaled to height, pelvis lands exactly on the seat point', () => {
  const t = seatTransform(-1, 3, { x: 0.2, y: 0.5, z: 1 }, { x: 0, y: 0.7, z: -0.3 }, 1.2);
  assert.ok(Math.abs(t.scale - 0.3) < 1e-12);
  for (const k of ['x', 'y', 'z']) {
    const pel = { x: 0.2, y: 0.5, z: 1 }[k] * t.scale + t.position[k];
    assert.ok(Math.abs(pel - { x: 0, y: 0.7, z: -0.3 }[k]) < 1e-12, k);
  }
});

test('flame look: tier colour + length while drifting, full length while boosting, off otherwise', () => {
  const k = (on, tier, boost) => ({ drift: { on, tier }, boost: { time: boost } });
  assert.equal(flameLook(k(false, -1, 0)).on, false);
  assert.equal(flameLook(k(true, -1, 0)).on, false);           // drifting but no charge yet
  for (const t of [0, 1, 2]) {
    const l = flameLook(k(true, t, 0));
    assert.equal(l.tier, t); assert.ok(Math.abs(l.len - (0.4 + t * 0.5)) < 1e-9);
  }
  assert.deepEqual(flameLook(k(false, -1, 0.8), 2), { on: true, len: 1.4, tier: 2 });
  assert.equal(flameLook(k(false, -1, 0.8)).tier, 1);          // mushroom boost defaults orange
  assert.deepEqual(FLAME_COLORS, [0x35a7ff, 0xff9a1f, 0xff3bd4]);
});

test('lathe fallback still builds with flames when the kart GLB is not loaded', () => {
  const g = buildKartModel(THREE, PLAYERS[0], 0);
  assert.equal(g.userData.parts.flame.length, 2);
  assert.equal(g.userData.parts.wheels.length, 4);
  assert.ok(!g.userData.parts.model);
});

test('agWeights: 0 outside, 1 mid-range, ramped and wrap-aware, tolerates no ranges', () => {
  const n = 100, cum = Array.from({ length: n }, (_, i) => i * 2.5);
  const fake = (agRanges) => ({ pl: { count: n }, cum, loop: n * 2.5, agRanges });
  assert.ok(agWeights(fake(undefined)).every((w) => w === 0));
  const W = agWeights(fake([{ i0: 90, i1: 30, amp: 2 }]));     // wraps past index 0
  assert.equal(W[50], 0); assert.equal(W[89], 0);
  assert.equal(W[90], 0); assert.equal(W[30], 0);              // ramps start/end at 0 -> C0 with the flat road
  assert.ok(W[10] > 0.999 && W[0] > 0 && W[0] < 1);       // idx 10 is 50 m from both ends; idx 0 still ramping
  for (let i = 91; i < 96; i++) assert.ok(W[i] >= W[i - 1]);   // rising ramp
});

test('AG track mesh: banked ribbon follows surfaceY, neon parts exist, both tracks', () => {
  for (const def of TRACKS) {
    const track = buildTrack(def);
    const { meshes } = buildTrackScene(THREE, track, def.theme);
    if (!(track.agRanges || []).length) continue;               // core not landed: nothing to check
    const names = meshes.ag.children.map((m) => m.name);
    for (const nm of ['ag-underglow', 'ag-rails', 'ag-gantry', 'ag-sign']) assert.ok(names.includes(nm), `${def.id}: ${nm}`);
    const p = meshes.road.geometry.attributes.position;
    const W = agWeights(track), COLS = p.count / (track.pl.count + 1);
    let checked = 0, rise = 0;
    for (let i = 0; i < track.pl.count; i++) {
      if (W[i] < 0.99) continue;
      for (const k of [0, COLS - 1]) {                          // outer edge vertices
        const v = i * COLS + k, x = p.getX(v), y = p.getY(v), z = p.getZ(v);
        assert.ok(Math.abs(y - track.surfaceY(x, z)) < 0.05, `${def.id} idx ${i}: ribbon ${y} vs surface ${track.surfaceY(x, z)}`);
        rise = Math.max(rise, y - track.elevAtIdx(i));
        checked++;
      }
    }
    assert.ok(checked > 10, `${def.id}: AG rows checked ${checked}`);
    assert.ok(rise > 1.5, `${def.id}: bank must lift the edge, got ${rise.toFixed(2)} m`);
    for (const m of meshes.ag.children) {
      const a = m.geometry.attributes.position.array;
      assert.ok(a.every(Number.isFinite), `${def.id}: ${m.name} has non-finite positions`);
    }
  }
});
