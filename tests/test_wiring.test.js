// tests/test_wiring.test.js — the two bugs the player reported that live in the SEAMS between
// modules (not inside one): the item RNG being restarted every physics step, and the camera
// presets the game now offers instead of guessing at a distance for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCameraRig } from '../src/render/cameraRig.js';
import { CAM } from '../src/config.js';

// 1) "I keep getting the same pickup."
// main.js used to build the item RNG as mulberry32(1) INSIDE ctxOf(), which is called once per
// physics step — so every step restarted the sequence and every box handed out the same item for
// a given running position.
test('the item RNG is one stream for the session, not a fresh seed per physics step', () => {
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.ok(!/rng:\s*mulberry32\(/.test(src), 'ctxOf() creates a fresh seeded RNG — every box will give the same item');
  assert.match(src, /rng:\s*sessionRng/, 'the loop must pass one session RNG into the item system');
});

// 2) The chase distance is the player's choice now. Every advertised preset must exist, be
//    selectable, be measurably different, and an unknown name must fall back rather than crash.
test('camera presets exist, change the chase distance, and fall back safely', async () => {
  const THREE = await import('../vendor/three.module.js');
  const rig = createCameraRig(THREE);
  assert.equal(rig.presetName(), 'normal', 'the default preset is normal');

  for (const name of CAM.presetOrder) {
    assert.ok(CAM.presets[name], `the advertised preset ${name} is not defined`);
    assert.equal(rig.setPreset(name), name, `setPreset(${name}) did not take`);
  }
  assert.equal(rig.setPreset('not-a-preset'), 'normal', 'an unknown preset must fall back to normal');

  // the presets must actually be different distances, or the control does nothing
  const backs = CAM.presetOrder.map((n) => CAM.presets[n].back);
  assert.ok(new Set(backs).size === backs.length, 'two camera presets have the same chase distance');
  assert.ok(Math.max(...backs) - Math.min(...backs) >= 3, 'the camera presets are too close together to feel different');

  // cycling goes through all of them and wraps
  const rig2 = createCameraRig(THREE);
  const seen = [rig2.presetName()];
  for (let i = 0; i < CAM.presetOrder.length; i++) seen.push(rig2.nextPreset());
  for (const name of CAM.presetOrder) assert.ok(seen.includes(name), `cycling never reached ${name}`);
});
