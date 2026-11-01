// tools/probe-ai.js — one AI driver, instrumented. Not part of CI; this is the debugging lens.
import { TRACKS, KART, AI as AIK } from '../src/config.js';
import { mulberry32 } from '../src/foundation.js';
import { buildTrack } from '../src/core/track.js';
import { createKart, stepKart, resolveKartCollisions } from '../src/core/kart.js';
import { createItemSystem } from '../src/core/items.js';
import { createRace } from '../src/core/race.js';
import { createAI, stepAI } from '../src/core/ai.js';

const noFX = { burst() {}, trail() {}, ring() {}, confetti() {} };
const track = buildTrack({ ...TRACKS[0], laps: 2 });
const rng = mulberry32(1);
const k = createKart(0, { name: 'PROBE', color: 1, trim: 2, skin: 3, helmet: 4 }, false);
k.ai = createAI(k.spec || { name: 'PROBE' }, mulberry32(7));
const karts = [k];
const items = createItemSystem(track, mulberry32(3));
const race = createRace(track, karts);
race.start();
const ctx = { karts, track, items, fx: noFX, rng, time: 0 };

let log = [], wallEdges = 0, prevWall = 0, offFrames = 0, frames = 0, spinFrames = 0;
const dt = 1 / 120;
while (race.phase !== 'finished' && frames < 120 * 60 * 5) {
  stepAI(k, k.ai, track, ctx, dt);
  stepKart(k, track, dt, ctx);
  items.update(dt, ctx);
  if (k.input.use) { items.use(k, ctx); k.input.use = false; }
  items.collect(k, ctx);
  items.applyHits(ctx);
  race.step(dt, ctx);
  const s = track.sample(k.pos.x, k.pos.z, k.plIdx);
  if (k.wallHit > 0 && prevWall <= 0) wallEdges++;
  prevWall = k.wallHit;
  if (!s.onRoad) offFrames++;
  if (k.spin > 0) spinFrames++;
  if (frames % 60 === 0) {
    // curvature the AI sees, plus what it does about it
    let curv = 0;
    const pl = track.pl;
    for (const dist of [12, 26, 48, 90]) {
      const n = Math.round(dist / 2.5);
      const a = pl.tangents[k.plIdx], b = pl.tangents[((k.plIdx + n) % pl.count + pl.count) % pl.count];
      let ang = Math.abs(Math.atan2(b.z, b.x) - Math.atan2(a.z, a.x));
      if (ang > Math.PI) ang = 2 * Math.PI - ang;
      curv = Math.max(curv, ang / (n * 2.5));
    }
    log.push({
      t: +k.raceTime.toFixed(1), spd: +k.speed.toFixed(1), side: +s.side.toFixed(1), half: +s.half.toFixed(1),
      off: s.onRoad ? 0 : 1, curv: +curv.toFixed(4), steer: +k.input.steer.toFixed(2), thr: +k.input.throttle.toFixed(2),
      drift: k.input.drift ? 1 : 0, spin: +k.spin.toFixed(1), lapFrac: +(k.progress).toFixed(2), lap: k.lap,
    });
  }
  frames++;
}
console.log(`finishTime=${k.finishTime.toFixed(1)} laps=${(k.lapTimes || []).map((t) => t.toFixed(1))} wallEdges=${wallEdges} offPct=${(100 * offFrames / frames).toFixed(1)} spinPct=${(100 * spinFrames / frames).toFixed(1)} frames=${frames}`);
console.log('t    spd  side  half off curv    steer thr   drift spin lapFrac lap');
for (const r of log.slice(0, 120)) {
  console.log(`${String(r.t).padStart(5)} ${String(r.spd).padStart(5)} ${String(r.side).padStart(6)} ${String(r.half).padStart(5)} ${r.off}   ${String(r.curv).padStart(7)} ${String(r.steer).padStart(6)} ${String(r.thr).padStart(5)}  ${r.drift}   ${String(r.spin).padStart(4)} ${String(r.lapFrac).padStart(6)} ${r.lap}`);
}
