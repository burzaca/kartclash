/* main.js — KART CLASH boot, fixed-step loop, camera rig, split-screen orchestration. (PM-owned) */
import * as THREE from 'three';

import { GAME, RACE, CAM, KART, PLAYERS, AI_DRIVERS, KEYMAP, GLOBAL_KEYS, TRACKS, ITEM, ITEM_NAME, KEYMAP_LABEL, RENDER } from './config.js';
import { clamp, damp, lerp, mulberry32, hashSeed } from './foundation.js';
import { buildTrack } from './core/track.js';
import { createControllers, loadBindings } from './core/input.js';
import { packSnap, createReceiver, applySnap, packInput, applyInput } from './core/net.js';
import { createKart, stepKart, resolveKartCollisions, resetKart } from './core/kart.js';
import { createItemSystem } from './core/items.js';
import { createRace, standings, rank, perfectStart } from './core/race.js';
import { createAI, stepAI } from './core/ai.js';
import { createStage } from './render/stage.js';
import { createCameraRig } from './render/cameraRig.js';
import { buildTrackScene } from './render/trackMesh.js';
import { buildKartModel, updateKartModel, buildItemProps, loadKartModels, modelSource } from './render/kartModel.js';
import { createFX } from './render/fx.js';
import { createHUD } from './ui/hud.js';
import { createMenu } from './ui/menu.js';

window.__bootErr = null;

const qs = new URLSearchParams(location.search);

// URL options are read once, at module scope, so any function can use them.
let trackIdx = Math.max(0, TRACKS.findIndex((t) => t.id === qs.get('track')));
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
  // preload real kart bodies; buildKartModel falls back to procedural until/if this fails.
  // If a race starts before the fetch finishes (slow CDN), swap the fallback karts in-place
  // once the models are ready, so the look never stays wrong.
  loadKartModels(THREE).then(() => swapToModelKarts()).catch((e) => console.error('kart model load failed — procedural karts in use', e));
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
  // Per-player: stored as { "0": "close", "1": "far" }; a bare string is the old single-player format.
  const storedCams = (() => {
    try { const raw = JSON.parse(localStorage.getItem(CAM_PREF_KEY) || 'null');
      return typeof raw === 'string' ? { 0: raw } : (raw || {}); } catch { return {}; }
  })();
  if (qs.get('cam')) rig.setPreset(qs.get('cam'));
  loadBindings();   // player-set keys from localStorage (title > Configure Keys)

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
    const humanNames = net.mode === 'host' ? ['YOU', net.guestName || 'RIVAL'] : (net.hostNames || null);
    for (let i = 0; i < humanCount; i++) {
      const spec = { ...PLAYERS[i % PLAYERS.length] };
      if (humanNames && humanNames[i]) spec.name = humanNames[i];
      // online: on YOUR machine you are player 1 with YOUR keys - the second seat's local
      // bindings were the complaint ("why does the other player use keys like one keyboard")
      if (net.mode !== 'solo') spec.keys = PLAYERS[0].keys;
      specs.push({ spec, human: true });
    }
    // rooms own their bot count (the user asked for a bots-off option); solo keeps the full field
    const nBots = net.mode === 'solo' ? RACE.aiField : net.bots;
    for (let i = 0; i < nBots; i++) specs.push({ spec: AI_DRIVERS[i % AI_DRIVERS.length], human: false });
    if (allAI) for (const s of specs) s.human = false;

    const aiRng = mulberry32(track.def.seed ^ 0x9e37);
    for (let i = 0; i < specs.length; i++) {
      const { spec, human } = specs[i];
      const k = createKart(i, spec, human);
      k.ai = human ? null : createAI(spec, aiRng);
      // guest mirrors: every kart except mine is host-owned; host marks its guest kart remote
      k.remote = false;
      if (human && net.mode === 'client' && i !== net.myIdx) k.remote = true;
      if (human && net.mode === 'host' && i > 0) k.remote = true;
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
      if (!karts[i].human || karts[i].remote) continue;
      const c = createControllers(1, [{ human: true, keys: karts[i].spec.keys }])[0];
      c.attach();
      controllers[karts[i].id] = c;
    }

    // a REMOTE human (the online guest) needs no camera and no HUD pane on MY screen:
    // they race inside my world, on their own screen (player report 2026-11-09 - split
    // screen made no sense online). Local input count is what owns viewports.
    const nLocal = Math.max(1, karts.filter((k) => k.human && !k.remote).length);

    race = createRace(track, karts);
    race.totalLaps = track.def.laps;

    hud = createHUD(uiRoot, karts.map((k) => ({ id: k.id, name: k.name, spec: k.spec, human: k.human })), { players: nLocal, debug: DEBUG_HUD });
    hud.setTrack(track.minimap);

    // one chase camera per human (in the all-AI smoke run, per kart)
    rig.reset();
    let camSlots = nLocal;
    for (const k of karts) {
      if (camSlots <= 0) break;
      if ((!k.human || k.remote) && !allAI) continue;   // in the all-AI smoke run the cameras spectate the field
      camSlots--;
      const camIdxNew = rig.cams.length; rig.addCamera();
      if (storedCams[String(camIdxNew)]) rig.setPresetFor(camIdxNew, storedCams[String(camIdxNew)]);
    }
  }

  // ---------- menus ----------
  function menuInfo() {
    return {
      title: GAME.title, subtitle: TRACKS[trackIdx].name, build: GAME.build,
      tracks: TRACKS.map((t, i) => ({ name: t.name, selected: i === trackIdx })),
      players: PLAYERS.slice(0, humanCount).map((p) => ({ name: p.name, keys: p.keys, color: p.color })),
      camera: rig.presetName(),
      room: {
        mode: net.mode, code: net.code, note: net.note, guest: net.guestName,
        bots: net.mode === 'solo' ? RACE.aiField : net.bots,
        racers: net.mode === 'host' ? 1 + (net.conn ? 1 : 0) + net.bots : 0,
      },
    };
  }
  function toTitle() {
    // the pause menu offers "Quit to Title"; it had no handler, so the option did nothing
    started = false; paused = false;
    hud.setHidden(true);            // the title is the menu, not a frozen race readout (2026-11-09)
    buildWorld();                   // fresh track + karts FIRST…
    hud.setHidden(true);            // …buildWorld made a new HUD; it stays hidden until a race
    race.start();                   // …then grid-place the NEW karts: the title shows the start
    hud.hideResults();              // grid, not a field at world origin ("green land", 2026-11-09)
    menu.showTitle(menuInfo());
  }

  // ---------- ROOMS: host-authoritative online multiplayer (2026-11-09) ----------
  // The room code IS the invite pass — the host's PeerJS id is 'kc-<code>', so only someone who
  // was given the code can dial in. The host runs the real simulation; guests send quantized
  // inputs and mirror interpolated snapshots (net.js). v1 field: host + 1 guest + optional bots —
  // the split-screen HUD has exactly two camera slots (4-way split = future work).
  const net = { mode: 'solo', peer: null, code: '', conn: null, note: '', bots: RACE.aiField, guestName: '', hostNames: null };
  const recv = createReceiver();
  let netInput = null;   // host side: latest guest input by kart id
  let snapAcc = 0;
  const newRoomCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23345678'.split(''); let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; return c; };
  const sendRoom = (m) => { if (net.conn && net.conn.open) { try { net.conn.send(m); } catch { /* dropped */ } } };
  window.__net = net; net.sendRoom = sendRoom;   // observability hook: inspect + poke rooms from the console

  function startRace() {
    started = true; paused = false;
    hud.setHidden(false);
    menu.hide();
    race.start();
    hud.hideResults();
  }
  // ---- room controls (host authoritative; the 4-letter code is the invite pass) ----
  const cfgMsg = () => ({ t: 'cfg', trackIdx, humans: net.conn ? 2 : 1, bots: net.bots,
    names: ['YOU', net.guestName || 'RIVAL'], me: 1 });
  function peerLib() {
    if (!window.Peer) { net.note = 'the room library failed to load - check your connection'; return null; }
    return window.Peer;
  }
  function hostRoom() {
    const Peer = peerLib(); if (!Peer) { menu.showTitle(menuInfo()); return; }
    net.code = newRoomCode(); net.mode = 'host'; net.note = '';
    net.peer = new Peer('kc-' + net.code.toLowerCase());
    net.peer.on('open', () => { net.note = ''; menu.showTitle(menuInfo()); });
    net.peer.on('error', (e) => {
      net.note = 'room offline (' + (e && e.type || 'network') + ') - try again';
      net.mode = 'solo'; net.peer = null; menu.showTitle(menuInfo());
    });
    // one guest in v1: the split-screen HUD has exactly two camera slots (4-way split = later)
    net.peer.on('connection', (c) => {
      if (net.conn) { c.close(); return; }
      net.conn = c;
      c.on('data', (m) => {
        if (m.t === 'hello') {
          net.guestName = String(m.name || 'RIVAL').slice(0, 12);
          if (started) sendRoom(cfgMsg());          // joining mid-race: hand them the live world
          menu.showTitle(menuInfo());
        } else if (m.t === 'i') { (netInput || (netInput = {}))[1] = m; }
        else if (m.t === 'p') { setPausedLocal(m.v); sendRoom({ t: 'p', v: m.v }); }   // echo: it is a room-wide pause
        else if (m.t === 'r') doRestart();
      });
      c.on('close', () => {
        net.conn = null; netInput = null; net.guestName = '';
        if (started) { toTitle(); } else { buildWorld(); }
        menu.showTitle(menuInfo());
      });
      menu.showTitle(menuInfo());
    });
    menu.showTitle(menuInfo());
  }
  function joinRoom() {
    const Peer = peerLib(); if (!Peer) { menu.showTitle(menuInfo()); return; }
    const inp = uiRoot.querySelector('.kc-code-input');
    const code = String((inp && inp.value) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { net.note = 'enter the 4-letter room code first'; menu.showTitle(menuInfo()); return; }
    net.code = code; net.mode = 'client'; net.note = 'dialling ' + code + '...';
    net.peer = new Peer();
    net.peer.on('error', (e) => {
      net.note = 'cannot reach room ' + code + ' (' + (e && e.type || 'offline') + ')';
      net.mode = 'solo'; net.peer = null; menu.showTitle(menuInfo());
    });
    net.peer.on('open', () => {
      const c = net.peer.connect('kc-' + code.toLowerCase());
      net.conn = c;
      c.on('open', () => { c.send({ t: 'hello', name: 'RIVAL' }); net.note = 'waiting for the host to start...'; menu.showTitle(menuInfo()); });
      c.on('data', (m) => {
        if (m.t === 'cfg') startClientRace(m);
        else if (m.t === 's') recv.feed(m, performance.now() / 1000);
        else if (m.t === 'p') setPausedLocal(m.v);
        else if (m.t === 'r') { race.start(); hud.hideResults(); }
      });
      c.on('close', () => {
        net.conn = null;
        if (started) toTitle();
        net.mode = 'solo'; net.note = 'the host left'; menu.showTitle(menuInfo());
      });
    });
    menu.showTitle(menuInfo());
  }
  function startClientRace(cfg) {
    net.myIdx = cfg.me; net.hostNames = cfg.names; net.bots = cfg.bots;
    trackIdx = cfg.trackIdx; humanCount = Math.max(1, cfg.humans);
    buildWorld();
    started = true; paused = false; hud.setHidden(false); menu.hide();
    race.start();
  }
  function leaveRoom() {
    if (net.conn) { try { net.conn.close(); } catch { /* already gone */ } }
    if (net.peer) { try { net.peer.destroy(); } catch { /* already gone */ } }
    net.conn = null; net.peer = null; net.code = ''; net.guestName = ''; net.myIdx = -1; net.note = '';
    net.mode = 'solo'; netInput = null;
    if (started) toTitle(); else { buildWorld(); menu.showTitle(menuInfo()); }
  }

  // A guest runs no race logic: predict own kart, mirror the rest, send input (see net.js).
  function clientTick(dt, nowMs) {
    const own = karts[net.myIdx];
    if (!own) return;
    if (own.finished) {
      own.input.throttle = Math.abs(own.speed) > 0.4 ? -1 : 0;
      own.input.steer = 0; own.input.drift = false; own.input.use = false;
    } else if (controllers[own.id]) {
      const it = controllers[own.id].intent();
      own.input.throttle = it.throttle; own.input.steer = it.steer; own.input.drift = it.drift; own.input.use = it.use;
    }
    if (race.phase !== 'racing') { own.input.use = false; own.input.drift = false; }
    // ctxLite: the physics mirror only reads ctx.fx (verified 2026-11-09) — collisions, items
    // and scoring stay host-owned and arrive through the snapshot.
    if (race.phase === 'racing') stepKart(own, track, dt, { karts, track, items: null, fx, rng: sessionRng, time: race.clock });
    if (net.conn && net.conn.open) { try { net.conn.send(packInput(own)); } catch { /* dropped */ } }
    const snap = recv.at(nowMs / 1000);
    if (snap) { applySnap(karts, race, snap, own.id, 0.3); mirrorEffects(snap.raw.e); }
    if ((race.phase === 'finished' || own.finished) && !paused) {
      race._resT = (race._resT || 0) + dt;
      if (!race._shown || race._resT > 1) { race._shown = true; race._resT = 0; hud.results(buildStandingsView()); }
    }
  }

  // snapshot effects -> local effect objects. Object IDENTITY matters (the renderer keys its
  // effect meshes by object), so mirror into reused objects and mark unseen ones inactive.
  const clientFxMap = new Map();
  function mirrorEffects(list) {
    if (!list) return;
    const seen = new Set();
    for (const u of list) {
      const key = u.k + ':' + u.o + ':' + u.m;
      let e = clientFxMap.get(key);
      if (!e) {
        e = { kind: u.k, item: u.m, owner: u.o, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, z: 0 },
          heading: 0, radius: 0, life: 0, active: true, homing: null, spin: 6, idx: -1, wallHits: 0 };
        clientFxMap.set(key, e); items.effects.push(e);
      }
      e.pos.x = u.x * 0.01; e.pos.y = u.y * 0.01; e.pos.z = u.z * 0.01;
      e.radius = (u.r || 0) * 0.01; e.heading = (u.h || 0) * 0.001; e.life = u.l || 0;
      e.homing = u.hm ? { t: u.ht | 0, i: u.hi } : null;
      e.active = true; seen.add(e);
    }
    for (const e of items.effects) if (!seen.has(e)) e.active = false;
  }

  // Pause is one operation, not four flags: the HUD must go with it (its panels covered the
  // pause menu's buttons, player report 2026-11-09) and a frozen race needs no race data.
  function setPausedLocal(v) {
    paused = v;
    hud.setHidden(v);
    if (v) menu.showPause(menuInfo()); else menu.hidePause();
  }
  // A pause in a room pauses EVERYONE (player request 2026-11-09): the host is the clock,
  // so anyone's pause goes to the host, and the host applies it and tells the other side.
  function setPaused(v) {
    if (net.mode === 'host') { setPausedLocal(v); sendRoom({ t: 'p', v }); }
    else if (net.mode === 'client') sendRoom({ t: 'p', v });
    else setPausedLocal(v);
  }
  // Restart follows the same rule: one side asks, the host re-lights the field for both.
  function doRestart() {
    if (net.mode === 'client') { sendRoom({ t: 'r' }); return; }
    race.start(); hud.hideResults(); setPaused(false);
    if (net.mode === 'host') sendRoom({ t: 'r' });
  }

  // Replace any procedural fallback kart groups with the real GLB karts, keeping game state intact.
  function swapToModelKarts() {
    if (!karts) return;
    for (let i = 0; i < models.length && i < karts.length; i++) {
      if (models[i] && models[i].userData.parts && models[i].userData.parts.model === 'glb') continue;
      if (!models[i]) continue;
      scene.remove(models[i]);
      const g = buildKartModel(THREE, karts[i].spec, karts[i].id);
      scene.add(g); models[i] = g;
    }
    setStamp();   // honest model: after the async swap — a stamp frozen at boot always lied 'lathe' (2026-11-09)
  }
  function buildStandingsView() {
    return standings(race).map((r) => ({
      name: r.name, color: r.spec.color,
      isPlayer: net.mode === 'client' ? r.id === net.myIdx : (net.mode === 'host' ? r.id === 0 : r.isPlayer),
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

  // the player's own key, spelled out — "press SPACE", not "press the use key"
  function useKeyLabel(k) {
    const km = KEYMAP_LABEL[k && k.spec && k.spec.keys] || KEYMAP_LABEL.arrows;
    return km.use;
  }

  function ctxOf() {
    return {
      karts, track, items, fx, rng: sessionRng, time: race ? race.clock : 0,
      onBlocked: (k, b, why) => {
        if (!k.human) return;
        // icon flash only — the full-screen 'ITEM ALREADY IN HAND' banner covered half the
        // screen and the player asked for it gone (2026-11-09)
        hud.pulseItem(k.viewport ? k.viewport.i : 0);
      },
    };
  }

  function fixedStep(dt) {
    const ctx = ctxOf();
    const go = race.phase === 'racing';
    for (const k of karts) {
      if (k.human && k.finished) {
        // Player finished: park the kart instead of orbiting the map while waiting for the AI
        // to cross ("I just keep going around the map" — 2026-11-09). The scoreboard is up already.
        k.input.throttle = Math.abs(k.speed) > 0.4 ? -1 : 0;
        k.input.steer = 0; k.input.drift = false; k.input.use = false;
        continue;
      }
      if (k.human && k.remote) {
        const m = netInput && netInput[k.id];
        if (m) applyInput(k, m);
      } else if (k.human && controllers[k.id]) {
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
          hud.banner(ITEM_NAME[got] || 'ITEM ACQUIRED', `press ${useKeyLabel(k)} to use it`, 2400, k.viewport ? k.viewport.i : 0, true);
        }
      }
    }
    items.applyHits(ctx);
    const wasPhase = race.phase;
    race.step(dt, ctx);
    if (wasPhase === 'countdown' && race.phase === 'racing') {
      // GO is drawn by hud.update's countdown path (it owns 3-2-1-GO now); only the perfect-start
      // input read stays here.
      for (let i = 0; i < karts.length; i++) if (karts[i].human && controllers[karts[i].id]) controllers[karts[i].id].intent();
    }
    if (net.mode === 'host' && net.conn && net.conn.open) {
      snapAcc += dt;
      if (snapAcc >= 0.05) { snapAcc = 0; try { net.conn.send(packSnap(race, karts, items)); } catch { /* dropped */ } }
    }
    // Show the scoreboard when the PLAYER crosses, not when the last AI trickles in: the wait
    // made them circle a dead map for up to 60 s. It then live-refreshes once a second until
    // the race truly ends (finish times + projected gaps for stragglers). (2026-11-09)
    if ((race.phase === 'finished' || karts.some((k) => k.human && k.finished)) && !paused) {
      race._resT = (race._resT || 0) + dt;
      if (!race._shown || race._resT > 1) {
        race._shown = true; race._resT = 0;
        hud.results(buildStandingsView());
      }
    }
  }

  function countdownText() {
    if (!race || race.phase === 'title' || race.phase === 'finished') return null;   // 'finished' leaked a ghost GO over the results panel (2026-11-09)
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
      vps.push({ i: 0, x: 0, y: 0, w, h, kartId: (karts.find((k) => k.human && !k.remote) || karts.find((k) => k.human))?.id ?? 0 });
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

    if (started && !paused && net.mode === 'client') {
      clientTick(dt, now);
    } else if (started && !paused) {
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
    // a focused menu button owns its own Enter/arrows (the menu module handles activation)
    if (e.target && e.target.closest && e.target.closest('.kc-btn')) return;
    if (e.target && e.target.tagName === 'INPUT') return;   // typing a room code is not gameplay
    // after the flag, Esc/Enter goes back to the title screen (it used to do nothing at all)
    if (started && race.phase === 'finished' && (e.code === 'Escape' || e.code === 'Enter')) { toTitle(); return; }
    if (started && race.phase !== 'finished' && GLOBAL_KEYS.pause.includes(e.code)) { setPaused(!paused); return; }
    if (GLOBAL_KEYS.restart.includes(e.code)) { if (started) doRestart(); return; }   // R from a live race (pause stays paused: Resume resumes it)
    if (started && race.phase === 'finished' && e.code === 'Enter') { doRestart(); return; }
    if (!started && e.code === 'Enter') { startRace(); return; }
    const camFor = (CAM.camKeys || {})[e.code];
    if (camFor !== undefined) {
      if (camFor >= Math.max(1, humanCount)) { hud.banner('NOT IN THIS RACE', 'that player is not racing', 1200); return; }
      const name = rig.nextPresetFor(camFor);
      try { const all = JSON.parse(localStorage.getItem(CAM_PREF_KEY) || '{}'); all[String(camFor)] = name; localStorage.setItem(CAM_PREF_KEY, JSON.stringify(all)); } catch { /* private mode */ }
      hud.banner(`P${camFor + 1} CAMERA: ${name.toUpperCase()}`, rig.presetLabel(name), 1500);
      return;
    }
    if (e.code === 'Tab') { e.preventDefault(); trackIdx = (trackIdx + 1) % TRACKS.length; if (!started) { buildWorld(); menu.showTitle(menuInfo()); } }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('resize', () => layout());

  buildWorld();
  menu = createMenu(uiRoot, {});
  hud.setHidden(true);   // title screen = menu only (the HUD belongs to a live race)
  menu.onAction((a) => {
    if (a === 'start') { humanCount = 2; buildWorld(); startRace(); }
    else if (a === 'p1only') { humanCount = 1; buildWorld(); startRace(); }
    else if (a === 'restart') { if (started) doRestart(); }   // pause-menu Restart Race: one restart for the whole room
    else if (a === 'resume') { setPaused(false); }
    else if (a === 'quit') { if (net.mode !== 'solo') leaveRoom(); else toTitle(); }
    else if (a === 'switch' || a === 'next') { trackIdx = (trackIdx + 1) % TRACKS.length; if (net.mode === 'client') return; buildWorld(); race.start(); hud.setHidden(true); menu.showTitle(menuInfo()); }
    else if (a === 'keys') { if (!started) menu.showKeys(menuInfo()); }
    else if (a === 'keysback') { if (!started) menu.showTitle(menuInfo()); }
    else if (a === 'host') { if (net.mode === 'solo') hostRoom(); }
    else if (a === 'join') { if (net.mode === 'solo') joinRoom(); }
    else if (a === 'leave') { leaveRoom(); }
    else if (a === 'bots') {
      if (net.mode !== 'host') return;
      net.bots = net.bots ? 0 : RACE.aiField;
      // no buildWorld() here: rebuilding the whole world rebuilt the HUD too, which flashed
      // on every click and hid the label change (player report: "it just shows and hides the
      // HUD, never changes to OFF"). The field is built for real at roomstart anyway; the
      // Start button's racer count is the honest live feedback.
      menu.showTitle(menuInfo());
    }
    else if (a === 'roomstart') {
      if (net.mode !== 'host' || started) return;
      humanCount = net.conn ? 2 : 1;
      netInput = {};
      buildWorld();
      startRace();
      sendRoom(cfgMsg());
    }
  });
  menu.showTitle(menuInfo());
  // the corner stamp exists so a player and I can agree on which build they are looking at
  const setStamp = () => {
    const brand = document.getElementById('brand');
    if (brand) brand.textContent = `${GAME.title} · three.js r${THREE.REVISION} · build ${GAME.build} · model:${modelSource()}`;
  };
  setStamp();
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
