/* main.js — KART CLASH boot, fixed-step loop, camera rig, split-screen orchestration. (PM-owned) */
import * as THREE from 'three';

import { GAME, RACE, CAM, KART, PLAYERS, AI_DRIVERS, KEYMAP, GLOBAL_KEYS, TRACKS, ITEM, ITEM_NAME, KEYMAP_LABEL, RENDER } from './config.js';
import { clamp, damp, lerp, mulberry32, hashSeed } from './foundation.js';
import { buildTrack } from './core/track.js';
import { createControllers } from './core/input.js';
import { createKart, stepKart, resolveKartCollisions, resetKart } from './core/kart.js';
import { createItemSystem } from './core/items.js';
import { createRace, standings, rank, perfectStart } from './core/race.js';
import { createAI, stepAI } from './core/ai.js';
import { createStage } from './render/stage.js';
import { createCameraRig } from './render/cameraRig.js';
import { buildTrackScene } from './render/trackMesh.js';
import { buildKartModel, updateKartModel, buildItemProps, setHeldItem } from './render/kartModel.js';
import { createFX } from './render/fx.js';
import { createHUD } from './ui/hud.js';
import { createMenu } from './ui/menu.js';

window.__bootErr = null;

const qs = new URLSearchParams(location.search);

// URL options are read once, at module scope, so any function can use them.
const trackIdx = Math.max(0, TRACKS.findIndex((t) => t.id === qs.get('track')));
const wantSolo = qs.get('p') === '1';
const allAI = qs.get('test') === '1';
const shotName = qs.get('shot') || null;
const RENDER_SCALE = clamp(parseFloat(qs.get('scale') || '1') || 1, 0.3, 1);   // lower = faster on weak GPUs
const NO_SHADOW = qs.get('noshadow') === '1';
const LAPS_OVERRIDE = qs.get('laps') ? parseInt(qs.get('laps'), 10) : null;
const DEBUG_HUD = qs.get('debug') === '1';   // raw phase/clock readout for the test harness only

function boot() {
  const canvas = document.getElementById('game');
  const uiRoot = document.getElementById('ui');
  const stage = createStage(THREE, canvas, { keepBacking: allAI || !!shotName });
  if (NO_SHADOW) stage.setShadows(false);
  const { renderer, scene } = stage;

  // ---------- world selection ----------
  let track, raceScene, karts, controllers, items, fx, props, hud, menu, race;
  let models = [], heldItems = [], effectMeshes = new Map(), boxMeshes = [];
  let humanCount = wantSolo ? 1 : 2;
  let paused = false, started = false;
  const rig = createCameraRig(THREE);
  const cams = rig.cams;                    // the rig owns these; the array identity stays valid

  // Camera distance is the player's choice, kept between visits.
  const CAM_PREF_KEY = '***';
  const storedCam = (() => { try { return localStorage.getItem(CAM_PREF_KEY); } catch { return null; } })();
  if (qs.get('cam')) rig.setPreset(qs.get('cam'));
  else if (storedCam) rig.setPreset(storedCam);

  function buildWorld() {
    // tear down
    if (raceScene && raceScene.group) scene.remove(raceScene.group);
    for (const m of models) scene.remove(m);
    for (const m of boxMeshes) scene.remove(m);
    for (const [, m] of effectMeshes) scene.remove(m);
    models = []; boxMeshes = []; effectMeshes = new Map();
    if (hud) hud.dispose();
    if (fx) fx.dispose();

    track = buildTrack(TRACKS[trackIdx]);
    if (LAPS_OVERRIDE) track.def.laps = LAPS_OVERRIDE;
    raceScene = buildTrackScene(THREE, track, track.def.theme);
    scene.add(raceScene.group);

    fx = createFX(THREE, scene);
    props = buildItemProps(THREE);
    items = createItemSystem(track, mulberry32(track.def.seed ^ 0x51ed));

    // ---------- racers: humans + AI field ----------
    karts = [];
    const specs = [];
    for (let i = 0; i < humanCount; i++) specs.push({ spec: PLAYERS[i], human: true });
    for (let i = 0; i < RACE.aiField; i++) specs.push({ spec: AI_DRIVERS[i % AI_DRIVERS.length], human: false });
    if (allAI) for (const s of specs) s.human = false;

    const aiRng = mulberry32(track.def.seed ^ 0x9e37);
    for (let i = 0; i < specs.length; i++) {
      const { spec, human } = specs[i];
      const k = createKart(i, spec, human);
      k.ai = human ? null : createAI(spec, aiRng);
      k.plIdx = track.startIdx;
      karts.push(k);
      const g = buildKartModel(THREE, spec);
      scene.add(g); models.push(g); heldItems.push(0);
    }

    // item boxes as world props
    for (const b of items.boxes) {
      const m = props.itemBox.clone(true);
      m.position.set(b.x, b.y, b.z);
      scene.add(m); boxMeshes.push(m);
    }

    controllers = [];
    for (let i = 0; i < karts.length; i++) {
      if (!karts[i].human) continue;
      const c = createControllers(1, [{ human: true, keys: karts[i].spec.keys }])[0];
      c.attach();
      controllers[karts[i].id] = c;
    }

    race = createRace(track, karts);
    race.totalLaps = track.def.laps;

    hud = createHUD(uiRoot, karts.map((k) => ({ id: k.id, name: k.name, spec: k.spec, human: k.human })), { players: humanCount, debug: DEBUG_HUD });
    hud.setTrack(track.minimap);

    // one chase camera per human (in the all-AI smoke run, per kart)
    rig.reset();
    let camSlots = humanCount;
    for (const k of karts) {
      if (camSlots <= 0) break;
      if (!k.human && !allAI) continue;    // in the all-AI smoke run the cameras spectate the field
      camSlots--;
      rig.addCamera();
    }
  }

  // ---------- menus ----------
  function menuInfo() {
    return {
      title: GAME.title, subtitle: TRACKS[trackIdx].name, build: GAME.build,
      tracks: TRACKS.map((t, i) => ({ name: t.name, selected: i === trackIdx })),
      players: PLAYERS.slice(0, humanCount).map((p) => ({ name: p.name, keys: p.keys, color: p.color })),
      camera: rig.presetName(),
    };
  }
  function toTitle() {
    // the pause menu offers "Quit to Title"; it had no handler, so the option did nothing
    started = false; paused = false;
    hud.hideResults();
    race.start();
    buildWorld();
    menu.showTitle(menuInfo());
  }
  function startRace() {
    started = true; paused = false;
    menu.hide();
    race.start();
    hud.hideResults();
  }
  function buildStandingsView() {
    return standings(race).map((r) => ({
      name: r.name, color: r.spec.color, isPlayer: r.isPlayer,
      timeOrGap: r.finished ? fmtTime(r.time) : (r.gap > 0.05 ? `+${r.gap.toFixed(2)}` : '---'),
      bestLap: isFinite(r.bestLap) ? fmtTime(r.bestLap) : '--:--.-',
    }));
  }
  const fmtTime = (s) => (!isFinite(s) ? '--:--.-' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s * 10) % 10)}`);

  // ---------- loop ----------
  let last = performance.now(), acc = 0, fps = 60, frames = 0, fpsT = 0;
  window.__stats = { fps: 0, phase: 'title' };

  // One RNG for the whole session. It used to be created INSIDE ctxOf() as mulberry32(1), so
  // every physics step restarted the sequence at the same seed and every item box handed out the
  // same item for a given running position — which is exactly what the player reported
  // ("I keep getting the same pickup"). Pass ?seed=N to reproduce a session.
  const sessionRng = mulberry32(qs.get('seed') ? Number(qs.get('seed')) : ((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0));
  const taughtItemKey = new Set();     // humans who have been shown how to use an item, once
  const toldHolding = new Set();

  // the player's own key, spelled out — "press SPACE", not "press the use key"
  function useKeyLabel(k) {
    const km = KEYMAP_LABEL[k && k.spec && k.spec.keys] || KEYMAP_LABEL.arrows;
    return km.use;
  }

  function ctxOf() {
    return {
      karts, track, items, fx, rng: sessionRng, time: race ? race.clock : 0,
      onBlocked: (k) => {
        if (!k.human) return;
        const pane = k.viewport ? k.viewport.i : 0;
        hud.pulseItem(pane);
        if (!toldHolding.has(k.id)) {
          toldHolding.add(k.id);
          hud.banner('ITEM ALREADY IN HAND', `use it first: press ${useKeyLabel(k)}`, 2000, pane);
        }
      },
    };
  }

  function fixedStep(dt) {
    const ctx = ctxOf();
    const go = race.phase === 'racing';
    for (const k of karts) {
      if (k.human && controllers[k.id]) {
        const it = controllers[k.id].intent();
        k.input.throttle = it.throttle; k.input.steer = it.steer; k.input.drift = it.drift; k.input.use = it.use;
      } else if (k.ai) {
        stepAI(k, k.ai, track, ctx, dt);
      }
      if (!go) { k.input.use = false; k.input.drift = false; k.input.steer = 0; continue; }
      if (k.human || (k.ai && started)) perfectStart(race, k);
      stepKart(k, track, dt, ctx);
    }
    resolveKartCollisions(karts);
    items.update(dt, ctx);
    for (const k of karts) {
      if (k.input.use) { items.use(k, ctx); k.input.use = false; }
      if (!k.finished) {
        const got = items.collect(k, ctx);
        // the first item a human picks up teaches them what to do with it, in their own keys
        if (got && k.human && !taughtItemKey.has(k.id)) {
          taughtItemKey.add(k.id);
          hud.banner(ITEM_NAME[got] || 'ITEM ACQUIRED', `press ${useKeyLabel(k)} to use it`, 2400, k.viewport ? k.viewport.i : 0);
        }
      }
    }
    items.applyHits(ctx);
    const wasPhase = race.phase;
    race.step(dt, ctx);
    if (wasPhase === 'countdown' && race.phase === 'racing') {
      hud.banner(countdownText() === 'GO' ? 'GO' : '', '', 700);
      for (let i = 0; i < karts.length; i++) if (karts[i].human && controllers[karts[i].id]) controllers[karts[i].id].intent();
    }
    if (race.phase === 'finished' && !race._shown) {
      race._shown = true;
      hud.results(buildStandingsView());
    }
  }

  function countdownText() {
    if (!race || race.phase === 'title') return null;
    if (race.phase === 'racing') return race.clock < 0.8 ? 'GO' : null;
    const n = Math.ceil(race.countdown - 0.6);
    return n >= 1 ? String(Math.min(3, n)) : 'GO';
  }

  // ---------- camera rig (math lives in render/cameraRig.js, which tools/probe-camera.js drives) ----------
  function updateCams(dt, viewports) {
    rig.update(dt, karts, track, viewports.map((v) => v.kartId ?? 0), viewports);
  }

  function fixedShotCamera() { return rig.fixedShot(karts[0], shotName); }

  // ---------- render ----------
  // RENDER_SCALE renders the framebuffer at a fraction of the window (lower = faster on weak
  // GPUs, e.g. a laptop on battery). The HUD stays at native CSS pixels either way.
  function layout() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    const bw = Math.max(320, Math.round(w * RENDER_SCALE));
    const bh = Math.max(200, Math.round(h * RENDER_SCALE));
    if (bw !== stage._w || bh !== stage._h) stage.resize(bw, bh, RENDER_SCALE < 1 ? 1 : 2);
    return { w, h, bw, bh };
  }

  function computeViewports(w, h) {
    const vps = [];
    if (cams.length <= 1) {
      vps.push({ i: 0, x: 0, y: 0, w, h, kartId: karts.find((k) => k.human)?.id ?? 0 });
    } else {
      const hh = Math.floor(h / 2);
      vps.push({ i: 0, x: 0, y: 0, w, h: hh, kartId: karts[0].id });
      vps.push({ i: 1, x: 0, y: hh, w, h: h - hh, kartId: karts[1].id });
    }
    return vps;
  }

  function frame(now) {
    // window.__pumpOnly = harness mode (headless renderers without a compositor never fire rAF)
    if (!window.__pumpOnly) requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    frames++; fpsT += dt; if (fpsT > 1) { fps = frames / fpsT; frames = 0; fpsT = 0; window.__stats.fps = Math.round(fps); }

    if (started && !paused) {
      acc += dt;
      let guard = 0;
      while (acc >= GAME.fixedStep && guard < GAME.maxSteps) { fixedStep(GAME.fixedStep); acc -= GAME.fixedStep; guard++; }
      if (guard >= GAME.maxSteps) acc = 0;
    }

    const { w, h, bw, bh } = layout();
    const vps = computeViewports(w, h);                                  // CSS space: the HUD
    const scaleX = bw / w, scaleY = bh / h;
    const bvs = vps.map((v) => ({                                          // framebuffer space
      ...v, x: Math.round(v.x * scaleX), y: Math.round(v.y * scaleY),
      w: Math.round(v.w * scaleX), h: Math.round(v.h * scaleY),
    }));

    // visuals
    for (let i = 0; i < karts.length; i++) updateKartModel(models[i], karts[i], dt);
    for (const k of karts) {
      if (heldItems[k.id] !== (k.item || 0) * 1000 + (k.count || 0)) {
        heldItems[k.id] = (k.item || 0) * 1000 + (k.count || 0);
        setHeldItem(THREE, models[k.id], k.item, k.count);
      }
    }
    for (let i = 0; i < items.boxes.length; i++) {
      const b = items.boxes[i], m = boxMeshes[i];
      if (!m) continue;
      m.visible = !!b.active;
      if (m.visible) { m.rotation.y += dt * 1.6; m.position.y = b.y + Math.sin(now / 300 + i) * 0.12; }
    }
    // live effect meshes (keyed by object identity — items.js owns the effect list)
    const live = new Set();
    for (const e of items.effects) if (e.active) live.add(e);
    for (const e of live) {
      let m = effectMeshes.get(e);
      if (!m) { m = props.effectMesh(e); effectMeshes.set(e, m); scene.add(m); }
      m.position.set(e.pos.x, e.pos.y, e.pos.z);
      m.rotation.y += dt * 3;
      if (e.kind === 'shell') m.rotation.z += dt * (e.spin || 6);
    }
    for (const [e, m] of effectMeshes) if (!live.has(e)) { scene.remove(m); effectMeshes.delete(e); }
    fx.update(dt);
    stage.followLight(karts[0].pos.x, karts[0].pos.z, karts[0].pos.y);

    // cameras + scissored renders
    if (shotName) {
      const cam = fixedShotCamera(0);
      stage.clear();
      stage.renderView(cam, 0, 0, bw, bh);
    } else {
      updateCams(dt, vps);
      stage.clear();
      for (let i = 0; i < bvs.length; i++) {
        const vp = bvs[i];
        const cam = rig.cams[i];
        if (!cam) continue;
        // three.js viewport origin is bottom-left; our viewports are measured from the top
        stage.renderView(cam, vp.x, bh - (vp.y + vp.h), vp.w, vp.h);
      }
    }

    // HUD
    const rows = standings(race);
    for (const r of rows) {
      const vp = vps.find((v) => v.kartId === r.id);
      r.viewport = vp || { x: 0, y: 0, w: 0, h: 0 };
    }
    hud.setViewport(0, vps[0]); if (vps[1]) hud.setViewport(1, vps[1]);
    hud.update({
      phase: race.phase, time: race.clock, laps: race.totalLaps, karts: rows,
      countdownText: countdownText(),
    });
    window.__stats.phase = race.phase;
    window.__stats.race = race;
  }

  // ---------- input plumbing ----------
  window.addEventListener('keydown', (e) => {
    // after the flag, Esc/Enter goes back to the title screen (it used to do nothing at all)
    if (started && race.phase === 'finished' && (e.code === 'Escape' || e.code === 'Enter')) { toTitle(); return; }
    if (GLOBAL_KEYS.pause.includes(e.code)) { paused = !paused; if (paused) menu.showPause(menuInfo()); else menu.hidePause(); return; }
    if (GLOBAL_KEYS.restart.includes(e.code)) { if (started) { race.start(); hud.hideResults(); } return; }
    if (started && race.phase === 'finished' && e.code === 'Enter') { race.start(); hud.hideResults(); return; }
    if (!started && e.code === 'Enter') { startRace(); return; }
    if (e.code === 'KeyC') {
      const name = rig.nextPreset();
      try { localStorage.setItem(CAM_PREF_KEY, name); } catch { /* private mode */ }
      hud.banner(`CAMERA: ${name.toUpperCase()}`, rig.presetLabel(), 1500);
      return;
    }
    if (e.code === 'Tab') { e.preventDefault(); trackIdx = (trackIdx + 1) % TRACKS.length; if (!started) { buildWorld(); menu.showTitle(menuInfo()); } }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('resize', () => layout());

  buildWorld();
  menu = createMenu(uiRoot, {});
  menu.onAction((a) => {
    if (a === 'start') { humanCount = 2; buildWorld(); startRace(); }
    else if (a === 'p1only') { humanCount = 1; buildWorld(); startRace(); }
    else if (a === 'restart') { race.start(); hud.hideResults(); }
    else if (a === 'resume') { paused = false; menu.hidePause(); }
    else if (a === 'quit') { toTitle(); }
    else if (a === 'switch' || a === 'next') { trackIdx = (trackIdx + 1) % TRACKS.length; buildWorld(); menu.showTitle(menuInfo()); }
  });
  menu.showTitle(menuInfo());
  // the corner stamp exists so a player and I can agree on which build they are looking at
  {
    const brand = document.getElementById('brand');
    if (brand) brand.textContent = `${GAME.title} · three.js r${THREE.REVISION} · build ${GAME.build}`;
  }
  if (allAI) { startRace(); menu.hide(); }   // hands-off smoke run for the browser harness
  requestAnimationFrame(frame);
  let pumpNow = performance.now();
  window.__game = {
    get race() { return race; }, get karts() { return karts; }, get track() { return track; },
    get cams() { return cams; }, get stage() { return stage; }, get fx() { return fx; },
    get controllers() { return controllers; },
    startRace, buildWorld,
    // deterministic frame pump for headless verification (16.7 ms per step by default)
    step: (ms = 16.7, times = 1) => {
      window.__pumpOnly = true;
      for (let i = 0; i < times; i++) { pumpNow += ms; frame(pumpNow); }
      return { phase: race.phase, clock: +race.clock.toFixed(2) };
    },
  };
}

try { boot(); } catch (e) {
  window.__bootErr = (e && e.stack) || String(e);
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;inset:auto 1rem 1rem 1rem;color:#fff;background:#900;padding:1rem;z-index:9999;font:12px monospace';
  d.textContent = 'BOOT ERROR\n' + window.__bootErr;
  document.body.appendChild(d);
}
