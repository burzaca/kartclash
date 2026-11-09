// race.js — race rules: countdown, lap counting, ranking, finish, recovery. (PM-owned)
// Pure: no DOM, no THREE.
import { GAME, RACE, KART, ITEM } from '../config.js';
import { clamp, damp, idxDelta } from '../foundation.js';

// Private per-kart race bookkeeping (not part of the public kart shape).
const book = new WeakMap();
const padCool = new WeakMap();

function resetBook(k, track) {
  const pl = track.pl;
  const s = track.sample(k.pos.x, k.pos.z, k.plIdx);
  k.plIdx = s.idx;
  k.lap = 0;
  k.progress = s.frac;
  k.lastFrac = k.progress;
  k.raceTime = 0; k.lapStart = 0; k.lapTimes = []; k.bestLap = Infinity;
  k.finished = false; k.finishTime = 0;
  k.place = 1;
  k.offRoad = false; k.onPad = false;
  k.spin = 0; k.star = 0; k.shrunk = 0; k.invisible = 0;
  k.boost.time = 0; k.boost.mul = 1;
  k.item = ITEM.NONE; k.count = 0;
  k.drift.on = false; k.drift.time = 0; k.drift.tier = -1; k.drift.dir = 0;
  k.air.y = 0; k.air.vy = 0; k.air.onGround = true;
  k.speed = 0; k.vel.x = 0; k.vel.z = 0;
  k.wallHit = 9; k.hitFlash = 0; k.fx.shake = 0; k.fx.boost = 0; k.fx.spark = -1;
  k.lean = 0; k.wheelSpin = 0; k.steerVis = 0;
  book.set(k, {
    sawMid: false,           // grid slots are AFTER the line (frac ~0.09), so a real lap always passes the mid marker before the first crossing. It used to start TRUE, which let a kart bumped backwards over the seam at the start bank a free lap (a "2/3" badge at 14 s into the race, 2026-11-09).
    offRoadT: 0, stuckT: 0, wrongWayT: 0, lastIdx: k.plIdx, travelled: 0,
    perfectWindow: 0,
  });
}

export function createRace(track, karts) {
  const pl = track.pl;
  const race = {
    track, karts,
    phase: 'title',           // title | countdown | racing | finished
    clock: 0,                 // wall clock since race start (racing only)
    countdown: 0,
    finishOrder: [],
    totalLaps: (track.def && track.def.laps) || GAME.laps,
    started: false,
    startedAt: 0,
    winner: null,

    start() {
      race.clock = 0;
      race.countdown = 3.6;   // 3..2..1..GO
      race.finishOrder = [];
      race.winner = null;
      race.phase = 'countdown';
      race.started = true;
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const slot = track.gridSlot(i, karts.length);
        k.pos.x = slot.x; k.pos.z = slot.z; k.pos.y = track.surfaceY(slot.x, slot.z);
        k.heading = slot.heading;
        resetBook(k, track);
      }
    },

    // ---- bookkeeping, called LAST each fixed step (after physics + items) ----
    step(dt, ctx) {
      if (race.phase === 'countdown') {
        race.countdown -= dt;
        if (race.countdown <= 0) { race.phase = 'racing'; goBoost(race, karts); }
        return;
      }
      if (race.phase !== 'racing') return;
      race.clock += dt;

      for (const k of karts) {
        if (k.finished) continue;   // a finish time is fixed at the moment of crossing
        const b = book.get(k) || (resetBook(k, track), book.get(k));
        k.raceTime += dt;

        // --- where are we on the lap ---
        const s = track.sample(k.pos.x, k.pos.z, k.plIdx);
        const frac = s.frac;   // start-relative — must match the painted line, see track.sample
        k.onPad = s.pad;
        k.offRoad = !s.onRoad;

        // travelled distance (for ranking when laps are equal)
        const d = idxDelta(pl, k.plIdx, s.idx);
        if (d > 0) b.travelled += d; else if (d < 0) b.travelled = Math.max(0, b.travelled + d);
        k.plIdx = s.idx;
        k.progress = frac;

        // wrong way / stuck / off-road
        const fwdDot = k.vel.x * s.tx + k.vel.z * s.tz;
        if (s.onRoad && fwdDot < -2.0 && k.speed > 2) b.wrongWayT += dt; else b.wrongWayT = Math.max(0, b.wrongWayT - dt * 2);
        if (!s.onRoad) {
          b.offRoadT += dt;
          if (Math.abs(k.speed) < 1.5) b.stuckT += dt; else b.stuckT = 0;
        } else { b.offRoadT = 0; b.stuckT = 0; }
        if (b.stuckT > 2.2 || b.offRoadT > GAME.respawnStuckTime || b.wrongWayT > 3.5) {
          b.stuckT = 0; b.offRoadT = 0; b.wrongWayT = 0;
          // put them back on the racing line just ahead of where they went wrong
          let back = s.idx;
          k.pos.x = pl.pts[back].x; k.pos.z = pl.pts[back].z;
          k.pos.y = track.surfaceY(k.pos.x, k.pos.z);
          k.heading = Math.atan2(s.tz, s.tx);
          k.speed = 0; k.vel.x = 0; k.vel.z = 0;
          if (ctx && ctx.fx) ctx.fx.ring(k.pos.x, k.pos.y + 0.4, k.pos.z, { color: 0xffffff, r0: 0.5, r1: 3.4, life: 0.5 });
        }

        // --- boost pads: physics applies the boost (kart.js owns the feel); race only reports it ---
        let cool = (padCool.get(k) || 0) - dt;
        if (s.pad && cool <= 0) {
          cool = 1.2;
          if (ctx && ctx.fx) ctx.fx.burst(k.pos.x, k.pos.y + 0.3, k.pos.z, { color: 0xffe066, count: 14, speed: 8, life: 0.45, size: 0.3, gravity: -2 });
        }
        padCool.set(k, cool);

        // --- mid-lap marker (anti-reversal cheat) ---
        if (frac > 0.42 && frac < 0.58) b.sawMid = true;

        // --- crossing the start/finish line ---
        const prev = k.lastFrac;
        if (prev > 0.75 && frac < 0.25 && b.sawMid) {
          b.sawMid = false;
          k.lap += 1;
          const lapTime = k.raceTime - k.lapStart;
          k.lapStart = k.raceTime;
          k.lapTimes.push(lapTime);
          if (lapTime < k.bestLap) k.bestLap = lapTime;
          if (k.lap >= race.totalLaps) {
            k.finished = true;
            k.finishTime = k.raceTime;
            race.finishOrder.push(k);
            if (!race.winner) race.winner = k;
            if (race.finishOrder.length >= karts.filter((c) => c.human || true).length) race.phase = 'finished';
          } else if (ctx && ctx.fx) {
            ctx.fx.confetti(k.pos.x, k.pos.y + 1.6, k.pos.z, 30);
          }
        }
        k.lastFrac = frac;
      }

      rank(race);

      // The race is over a fixed time after the FIRST finisher, whoever that is. It used to
      // require every human to have finished first (grace = humansDone && …) — one lost human
      // and the race literally never ended ("the race does not finish after the 3 laps…
      // the AI all bunched in one spot going round and round", 2026-11-09). Anyone still out
      // there is projected across the line so the standings keep real times.
      const allDone = karts.every((k) => k.finished);
      const firstFinish = karts.reduce((m, k) => Math.min(m, k.finishTime || Infinity), Infinity);
      const grace = Number.isFinite(firstFinish) && race.clock - firstFinish > 60;
      if (race.phase === 'racing' && (allDone || grace)) {
        for (const k of karts) {
          if (k.finished) continue;
          const remain = (race.totalLaps - k.lap) * track.pl.total + (1 - k.progress) * track.pl.total;
          k.finished = true;
          k.finishTime = race.clock + remain / Math.max(10, Math.abs(k.speed));
          race.finishOrder.push(k);
        }
        race.phase = 'finished';
      }
    },
  };
  for (const k of karts) book.set(k, null);
  return race;
}

function setBoost(k, mul, time) {
  if (time > k.boost.time || mul > k.boost.mul) { k.boost.mul = Math.max(k.boost.mul, mul); }
  k.boost.time = Math.max(k.boost.time, time);
}

// A standing start bonus if you press throttle just as GO fires — the perfect start.
function goBoost(race, karts) {
  for (const k of karts) {
    const b = book.get(k);
    if (b) b.perfectWindow = RACE.countdownGoTime;
  }
}

// Order by (finished first, then lap, then lap progress, then distance travelled).
export function rank(race) {
  const pl = race.track.pl;
  const list = race.karts.slice();
  const score = (k) => {
    if (k.finished) return 1e9 - k.finishTime;
    return k.lap * 1e5 + k.progress * 9.9e4 + Math.min(9e4, 0);
  };
  list.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.lap !== b.lap) return b.lap - a.lap;
    if (Math.abs(a.progress - b.progress) > 1e-4) return b.progress - a.progress;
    const aa = (book.get(a) || {}).travelled || 0, bb = (book.get(b) || {}).travelled || 0;
    return bb - aa;
  });
  list.forEach((k, i) => { k.place = i + 1; });
  return list;
}

export function standings(race) {
  const list = rank(race);
  const leader = list.find((k) => k.finished) || list[0];
  return list.map((k) => {
    let gap = 0;
    if (k.finished && leader && leader !== k) gap = k.finishTime - leader.finishTime;
    else if (!k.finished && leader) {
      const pl = race.track.pl;
      const dl = k.lap - leader.lap, dp = k.progress - leader.progress;
      gap = (dl * pl.total + dp * pl.total) / Math.max(8, leader.speed || 8);
    }
    return {
      id: k.id, name: k.name, spec: k.spec, place: k.place,
      // completed laps, per the HUD contract (hud.update adds the +1 for the "lap you are on"
      // display). It used to pre-add it here, so the badge showed the current lap +2: a fresh
      // kart read 2/3 and any lap made it stick at 3/3 forever ("laps always say 3/3", 2026-11-09).
      lap: k.lap, laps: race.totalLaps,
      finished: k.finished, time: k.finishTime, gap, bestLap: k.bestLap, lapTimes: k.lapTimes,
      speed: k.speed, item: k.item, count: k.count, star: k.star, invisible: k.invisible,
      shrunk: k.shrunk, spin: k.spin, offRoad: k.offRoad, boost: k.boost.time, isPlayer: k.human,
      progress: k.progress, heading: k.heading, pos: k.pos,
    };
  });
}

// Is the perfect-start window still open and did they just press throttle?
export function perfectStart(race, k) {
  const b = book.get(k);
  if (!b || b.perfectWindow <= 0) return false;
  if (Math.abs(k.input.throttle) < 0.5) return false;
  b.perfectWindow = 0;
  setBoost(k, RACE.perfectBoost, RACE.perfectBoostTime);
  return true;
}
