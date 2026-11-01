// tools/simulate.js — headless race: the engine must produce a sane race with no NaN, no stuck
// karts, and believable lap pacing. This is the instrument that keeps the game beatable.
// usage: node tools/simulate.js [--track=0] [--laps=3] [--json] [--strict]
import { TRACKS, RACE, KART, AI as AIK, PLAYERS, AI_DRIVERS } from '../src/config.js';
import { mulberry32 } from '../src/foundation.js';
import { buildTrack } from '../src/core/track.js';
import { createKart, stepKart, resolveKartCollisions, resetKart } from '../src/core/kart.js';
import { createItemSystem } from '../src/core/items.js';
import { createRace, standings, rank } from '../src/core/race.js';
import { createAI, stepAI } from '../src/core/ai.js';

const argv = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith('--')) continue;
  const k = a.slice(2).split('=')[0];
  const v = a.slice(2).includes('=') ? a.slice(2).split('=').slice(1).join('=') : true;
  argv[k] = v;
}

const noFX = { burst() {}, trail() {}, ring() {}, confetti() {} };

export function simulateRace(trackIdx, laps, seed = 4242) {
  const def = JSON.parse(JSON.stringify(TRACKS[trackIdx]));
  def.laps = laps;
  const track = buildTrack(def);
  const rng = mulberry32(seed);
  const specs = AI_DRIVERS.concat(PLAYERS).slice(0, RACE.aiField + 2);
  const karts = specs.map((spec, i) => {
    const k = createKart(i, spec, false);   // everyone AI-driven in the sim
    k.ai = createAI(spec, mulberry32(seed + i * 7919));
    return k;
  });
  const items = createItemSystem(track, mulberry32(seed ^ 0x51ed));
  const race = createRace(track, karts);
  race.totalLaps = laps;
  race.start();

  const dt = 1 / 120;
  const ctx = { karts, track, items, fx: noFX, rng, time: 0 };
  let steps = 0, bad = 0, offRoadFrames = 0, spins = 0, boosts = 0, wallHits = 0, itemsUsed = 0;
  const stats = karts.map(() => ({ laps: [], maxSpeed: 0, stuck: 0 }));
  const perLapMark = karts.map(() => 0);
  const wallFlag = karts.map(() => false);

  while (race.phase === 'countdown' || race.phase === 'racing') {
    if (steps > 120 * 60 * 12) { console.error('SIM: race never finished'); break; }
    for (const k of karts) {
      if (k.ai) stepAI(k, k.ai, track, ctx, dt);
      if (k.input.use) itemsUsed++;
      stepKart(k, track, dt, ctx);
      if (!Number.isFinite(k.pos.x) || !Number.isFinite(k.pos.z) || !Number.isFinite(k.speed)) bad++;
      if (k.offRoad) offRoadFrames++;
      if (k.wallHit < 0.02) wallHits++;
    }
    resolveKartCollisions(karts);
    items.update(dt, ctx);
    for (const k of karts) if (k.input.use) { items.use(k, ctx); k.input.use = false; }
    for (const k of karts) if (!k.finished) items.collect(k, ctx);
    items.applyHits(ctx);
    race.step(dt, ctx);
    karts.forEach((k, i) => {
      stats[i].maxSpeed = Math.max(stats[i].maxSpeed, Math.abs(k.speed));
      if (k.wallHit > 0 && !wallFlag[i]) { wallFlag[i] = true; wallHits++; }
      else if (k.wallHit <= 0) wallFlag[i] = false;
      if (k.lap > perLapMark[i]) { perLapMark[i] = k.lap; stats[i].laps.push(+(k.raceTime).toFixed(2)); }
    });
    steps++;
  }

  const rows = standings(race);
  return {
    track: def.name, length: +track.total.toFixed(1), laps,
    seconds: +race.clock.toFixed(1), steps, finished: rows.filter((r) => r.finished).length,
    problems: { nonFinite: bad, offRoadPct: +(100 * offRoadFrames / (steps * karts.length)).toFixed(1), wallHits, itemsUsed },
    leaders: rows.slice(0, 6).map((r) => ({
      name: r.name, place: r.place, time: +r.time.toFixed(2), best: isFinite(r.bestLap) ? +r.bestLap.toFixed(2) : null,
      lapTimes: r.lapTimes.map((t) => +t.toFixed(2)), maxSpeed: +stats[r.id].maxSpeed.toFixed(1),
    })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const trackIdx = argv.track ? Number(argv.track) : 0;
  const laps = argv.laps ? Number(argv.laps) : 2;
  const t0 = Date.now();
  const out = [];
  for (const ti of argv.all ? TRACKS.map((_, i) => i) : [trackIdx]) out.push(simulateRace(ti, laps));
  const ms = Date.now() - t0;
  console.log(JSON.stringify({ simMs: ms, runs: out }, null, argv.json ? 2 : 0));

  let fail = [];
  for (const r of out) {
    const lead = r.leaders[0];
    if (!lead || !lead.time) fail.push(`${r.track}: no finisher`);
    if (r.problems.nonFinite) fail.push(`${r.track}: ${r.problems.nonFinite} non-finite samples`);
    if (lead?.best && (lead.best < 20 || lead.best > 240)) fail.push(`${r.track}: best lap ${lead.best}s outside 20..240s band`);
    if (r.problems.offRoadPct > 55) fail.push(`${r.track}: ${r.problems.offRoadPct}% off-road frames`);
    for (const L of r.leaders) if (L.maxSpeed > KART.maxSpeed * 1.7) fail.push(`${r.track}: ${L.name} hit ${L.maxSpeed} m/s`);
  }
  if (fail.length) { console.error('PACING FAIL:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log('PACING OK — ' + out.map((r) => `${r.track}: winner ${r.leaders[0]?.time}s, best lap ${r.leaders[0]?.best}s, ${r.length}m`).join(' | '));
}
