// tests/test_models.test.js — pure helpers of the v2 kart bodies + AG track look (no asset loading).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { pickBodyMaterials, flameLook, FLAME_COLORS, buildKartModel } from '../src/render/kartModel.js';
import { agWeights, buildTrackScene } from '../src/render/trackMesh.js';
import { buildTrack } from '../src/core/track.js';
import { TRACKS, PLAYERS } from '../src/config.js';

// Kd values copied from vendor/assets/cars/*.mtl
const SHARED = { Black: [0.011, 0.011, 0.011], Grey: [0.161, 0.161, 0.161], Windows: [0.028, 0.028, 0.028],
  Headlights: [0.639, 0.301, 0.102], TailLights: [0.639, 0.074, 0.059] };

test('paint pick: saturated body colour, white cars, two-tone, light-named paint', () => {
  assert.deepEqual(Object.keys(pickBodyMaterials({ ...SHARED, Blue: [0.278, 0.432, 0.64] })), ['Blue']);
  assert.deepEqual(Object.keys(pickBodyMaterials({ ...SHARED, Yellow: [0.64, 0.465, 0.045] })), ['Yellow']);
  // police: white body, BlueLights/WhiteLights are lamps, not paint
  assert.deepEqual(Object.keys(pickBodyMaterials({ ...SHARED, White: [0.549, 0.549, 0.549],
    BlueLights: [0.042, 0.158, 0.64], WhiteLights: [0.64, 0.64, 0.64] })), ['White']);
  // LightBlue is paint (name contains "Light" but does not end in "lights"); the white trim is not
  assert.deepEqual(Object.keys(pickBodyMaterials({ ...SHARED, LightBlue: [0.459, 0.548, 0.64], 'Material.007': [0.64, 0.64, 0.64] })), ['LightBlue']);
  // two-tone orange: both repainted, the dark panel keeps its relative shade
  const two = pickBodyMaterials({ ...SHARED, Orange: [0.639, 0.266, 0.086], DarkOrange: [0.559, 0.233, 0.076] });
  assert.equal(two.Orange, 1);
  assert.ok(two.DarkOrange > 0.8 && two.DarkOrange < 0.95);
  assert.deepEqual(pickBodyMaterials(SHARED), {});
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

test('lathe fallback still builds with flames when no car models are loaded', () => {
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
