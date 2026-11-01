#!/usr/bin/env node
/* probe-camera.js — verifies the split-screen chase camera frames the action. (PM-owned)
 *
 * Why: a racing game whose camera points at empty sky, buries itself in the tarmac, or puts the
 * player's kart 2 px tall is broken, and in this environment I cannot see pixels. Everything that
 * makes a chase camera correct IS computable: project the player kart's real bounding box and a
 * road point ahead of it into the camera's NDC space and check where they land.
 *
 * Run: node tools/probe-camera.js [--track=gold] [--secs=25]
 */
import * as THREE from '../vendor/three.module.js';  // vendored: the tools run with no node_modules
import { CAM, KART, PLAYERS, AI_DRIVERS, RACE, TRACKS } from '../src/config.js';
import { mulberry32 } from '../src/foundation.js';
import { buildTrack } from '../src/core/track.js';
import { createKart, stepKart, resolveKartCollisions } from '../src/core/kart.js';
import { createItemSystem } from '../src/core/items.js';
import { createRace, standings } from '../src/core/race.js';
import { createAI, stepAI } from '../src/core/ai.js';
import { createCameraRig } from '../src/render/cameraRig.js';
import { buildKartModel, updateKartModel } from '../src/render/kartModel.js';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const f = argv.find((a) => a.startsWith(`--${name}=`));
  return f ? f.split('=')[1] : def;
};

// A verification gate has to be reproducible, and the rig's impact shake uses Math.random().
// Swap in a seeded stream so two runs of this probe agree; the sim's own RNG is already seeded.
const seeded = mulberry32(0xC0FFEE);
Math.random = () => seeded();

const trackId = arg('track', null);
const SECS = parseFloat(arg('secs', '25'));
const STEP = 1 / 60;

let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);

function buildField(track) {
  const specs = [{ spec: PLAYERS[0], human: true }, { spec: PLAYERS[1], human: true }];
  for (let i = 0; i < RACE.aiField; i++) specs.push({ spec: AI_DRIVERS[i % AI_DRIVERS.length], human: false });
  const rng = mulberry32(track.def.seed ^ 0x9e37);
  const karts = specs.map(({ spec, human }, i) => {
    const k = createKart(i, spec, human);
    k.ai = human ? null : createAI(spec, rng);
    k.plIdx = track.startIdx;
    return k;
  });
  return karts;
}

// Project a world point; returns null when it is behind the camera.
function ndc(cam, x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(cam);
  if (Number.isNaN(v.x)) return null;
  return v;
}

function runTrack(def) {
  console.log(`\n=== ${def.name} (${def.id}) — split-screen framing ===`);
  const track = buildTrack(def);
  const karts = buildField(track);
  const items = createItemSystem(track, mulberry32(track.def.seed ^ 0x51ed));
  const race = createRace(track, karts);
  race.totalLaps = def.laps;

  const rig = createCameraRig(THREE);
  rig.addCamera(); rig.addCamera();          // player 1 (top half), player 2 (bottom half)

  // Two half-height viewports, as the game lays them out at 16:9.
  const VW = 1920, VH = 1080, half = Math.floor(VH / 2);
  const vps = [
    { i: 0, x: 0, y: 0, w: VW, h: half, kartId: karts[0].id },
    { i: 1, x: 0, y: half, w: VW, h: half, kartId: karts[1].id },
  ];

  race.start();
  race.countdown = 0.01;

  // Visible geometry for the kart: use the real model so its true size drives the check.
  const models = karts.map((k) => {
    const g = buildKartModel(THREE, k.spec);
    g.updateMatrixWorld(true);
    return g;
  });

  let frames = 0, worstSize = Infinity, bestSize = 0, offScreen = 0, buried = 0, roadMiss = 0;
  const samples = [];
  const noFX = { burst() {}, trail() {}, ring() {}, confetti() {} };
  const rng = mulberry32(1234);
  const ctx = { karts, track, items, fx: noFX, rng, time: 0 };

  for (let t = 0; t < SECS; t += STEP, frames++) {
    ctx.time = t;
    // simulate (the same order the live loop uses)
    for (const k of karts) {
      if (k.ai) stepAI(k, k.ai, track, ctx, STEP);
      else { k.input.throttle = 1; k.input.steer = 0; }
      stepKart(k, track, STEP, ctx);
    }
    resolveKartCollisions(karts);
    // pose the real models, exactly as the render loop does — the framing check measures their
    // actual world-space bounding boxes, not an approximation
    for (const k of karts) updateKartModel(models[k.id], k, STEP);
    items.update(STEP, ctx);
    for (const k of karts) if (k.input.use) { items.use(k, ctx); k.input.use = false; }
    for (const k of karts) if (!k.finished) items.collect(k, ctx);
    items.applyHits(ctx);
    race.step(STEP, ctx);

    // advance the camera rig exactly as the render loop does
    rig.update(STEP, karts, track, vps.map((v) => v.kartId), vps);

    if (race.phase !== 'racing' || race.clock < 2 || Math.floor(race.clock) === Math.floor(race.clock - STEP)) continue;

    for (let i = 0; i < vps.length; i++) {
      const cam = rig.cams[i], k = karts.find((c) => c.id === vps[i].kartId);
      const mdl = models[k.id];
      // no renderer here, so the camera's world matrix must be refreshed by hand before projecting
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);

      // the camera must never sink into the track
      const camGround = track.surfaceY(cam.position.x, cam.position.z);
      if (cam.position.y - camGround < 0.5) buried++;

      // the player's kart must be on screen and at a readable size
      mdl.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mdl);
      const corners = [];
      for (const cx of [box.min.x, box.max.x]) for (const cy of [box.min.y, box.max.y]) for (const cz of [box.min.z, box.max.z]) {
        const p = ndc(cam, cx, cy, cz);
        if (p && p.z < 1) corners.push(p);
      }
      if (!corners.length) { offScreen++; samples.push({ t: +race.clock.toFixed(1), why: 'kart behind camera' }); continue; }
      const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
      const inX = Math.max(...xs) < 0.92 && Math.min(...xs) > -0.92;
      const inY = Math.max(...ys) < 0.95 && Math.min(...ys) > -0.95;
      if (!inX || !inY) offScreen++;

      // apparent height as a fraction of the viewport (NDC spans 2 units vertically).
      // A chase camera that renders the player's kart under ~14% of its half-pane is too far back
      // — that was the "with speed the kart gets too far away" report.
      const h = (Math.max(...ys) - Math.min(...ys)) / 2;
      const dist = cam.position.distanceTo(mdl.position);
      if (h < 0.14) samples.push({ t: +race.clock.toFixed(1), why: `kart only ${(h * 100).toFixed(1)}% of frame height (cam ${dist.toFixed(1)} m away, kart ${k.speed.toFixed(1)} m/s)` });
      if (h > 0.34) samples.push({ t: +race.clock.toFixed(1), why: `kart fills ${(h * 100).toFixed(1)}% of the frame — camera too close` });
      worstSize = Math.min(worstSize, h); bestSize = Math.max(bestSize, h);

      // the road ahead must be in frame — a chase cam that only shows sky is useless
      const sAhead = k.progress * track.pl.total + 25;
      const ahead = track.pointAt(sAhead, 0);
      if (ahead) {
        const p = ndc(cam, ahead.x, track.surfaceY(ahead.x, ahead.z), ahead.z);
        if (!p || p.z > 1 || Math.abs(p.x) > 1 || p.y > 0.98) roadMiss++;
      }
    }
  }

  const finishers = standings(race).filter((r) => r.finished).length;
  console.log(`  sim: ${frames} frames, race clock ${race.clock.toFixed(1)}s, phase ${race.phase}, finishers ${finishers}`);
  console.log(`  kart on-screen failures: ${offScreen}, road-ahead misses: ${roadMiss}, camera-below-surface: ${buried}`);
  console.log(`  kart apparent height: min ${(worstSize * 100).toFixed(1)}%, max ${(bestSize * 100).toFixed(1)}% of viewport height`);
  for (const s of samples.slice(0, 5)) console.log(`  note t=${s.t}s: ${s.why}`);

  if (offScreen > 0) fail(`${offScreen} frames where the player kart left the frame`);
  else ok('player kart stays inside every viewport');
  if (roadMiss > Math.floor(SECS / 2)) fail(`${roadMiss} frames where the road ahead was not in frame`);
  else ok('road ahead visible');
  if (buried > 0) fail(`${buried} frames with the camera under the track surface`);
  else ok('camera stays above the surface');
  if (worstSize * 100 < 14) fail(`player kart drops to ${(worstSize * 100).toFixed(1)}% of the viewport height — camera too far back at speed`);
  else if (bestSize * 100 > 34) fail(`player kart reaches ${(bestSize * 100).toFixed(1)}% of the viewport — camera too close`);
  else ok(`kart reads ${(worstSize * 100).toFixed(0)}-${(bestSize * 100).toFixed(0)}% of its viewport`);
}

const defs = trackId ? TRACKS.filter((t) => t.id === trackId) : TRACKS;
for (const d of defs) runTrack(d);
console.log(failures ? `\nCAMERA PROBE: ${failures} problem(s)` : '\nCAMERA PROBE: all checks passed');
process.exit(failures ? 1 : 0);
