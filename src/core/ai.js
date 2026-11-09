// ai.js — CPU drivers: look-ahead racing-line steering, corner speed from curvature, drift chains,
// item usage, rubber banding. Pure: no DOM, no THREE. (PM-owned)
import { AI, KART, ITEM, ITEM_TRIPLE } from '../config.js';
import { clamp, damp, angleDiff, frameAt, advanceIdx, rngRange, rngPick } from '../foundation.js';

const SPACING_HINT = 2.5;

export function createAI(spec, rng) {
  return {
    spec,
    skill: AI.skillBase + rngRange(rng, -AI.skillBand, AI.skillBand),
    lineOffset: 0,            // preferred lateral offset on the road (racing line)
    lineT: rng() * 10,
    driftT: 0,                // >0 = holding a drift for this many seconds
    driftCool: 0,
    prevHeading: null,        // for yaw damping in the steering controller
    lastSteer: 0,             // slew limit on the steering input
    useT: rngRange(rng, 0.4, 2.0),
    panic: 0,
    rng,
  };
}

// curvature (rad per metre) of the worst corner within the given look distances
function curvatureAhead(track, idx) {
  const pl = track.pl;
  let worst = 0;
  for (const dist of [12, 26, 48, 90]) {
    const n = Math.round(dist / SPACING_HINT);
    const a = pl.tangents[idx], b = pl.tangents[advanceIdx(pl, idx, n)];
    const ang = Math.abs(angleDiff(Math.atan2(a.z, a.x), Math.atan2(b.z, b.x)));
    const arc = n * SPACING_HINT;
    worst = Math.max(worst, ang / arc);
  }
  return worst;
}

function nearestRival(kart, karts, maxDist) {
  let best = null, bestD = maxDist;
  for (const r of karts) {
    if (r === kart) continue;
    const d = Math.hypot(r.pos.x - kart.pos.x, r.pos.z - kart.pos.z);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

// returns an intent: { throttle, steer, drift, use }
export function stepAI(kart, ai, track, ctx, dt) {
  const pl = track.pl;
  const rng = ai.rng;
  const s = track.sample(kart.pos.x, kart.pos.z, kart.plIdx);
  const half = s.half;
  ai.lineT += dt;

  // ---- rubber band by position ----
  const n = ctx.karts.length;
  const t = n > 1 ? (kart.place - 1) / (n - 1) : 0;
  const rubber = AI.rubber.leaderBand + (AI.rubber.tailBand - AI.rubber.leaderBand) * t;

  // ---- corner speed: v = sqrt(a_lat * R), capped by skill and rubber band ----
  const curv = curvatureAhead(track, kart.plIdx);
  const radius = 1 / Math.max(curv, 1e-4);
  // cornering grip is NOT scaled by skill: the physical kart can only hold so much lateral
  // load, and a skill-scaled target made the fast field grind walls (probe: 36 wall hits a lap,
  // zero kart-vs-kart, 2026-11-09). skill buys straights (vMax) and items, corners stay physics-honest.
  const aLat = 27.0 * rubber;
  const vCorner = Math.sqrt(aLat * radius);
  const vMax = KART.maxSpeed * ai.skill * rubber;

  // ---- racing line: hug the inside of the upcoming corner ----
  let turnSign = 0;
  for (const dist of [18, 40, 70]) {
    const nn = Math.round(dist / SPACING_HINT);
    const a = pl.tangents[kart.plIdx], b = pl.tangents[advanceIdx(pl, kart.plIdx, nn)];
    const cross = a.x * b.z - a.z * b.x;   // sign of the turn
    if (Math.abs(angleDiff(Math.atan2(a.z, a.x), Math.atan2(b.z, b.x))) > 0.25) { turnSign = -Math.sign(cross); break; }
  }
  const targetLine = turnSign * Math.min(half * 0.38, 3.6);   // was 0.45/4.5: clipping the inner barrier cost ~40 speed hits a lap (2026-11-09)
  ai.lineOffset = damp(ai.lineOffset, targetLine, 0.9, dt);

  // ---- steer toward a look-ahead point that moves with speed ----
  // A fixed 14 m sight line is under 0.6 s at racing speed, which makes the steering loop
  // oscillate: full lock, across the whole road, into the far barrier. Scale it with speed
  // and damp the yaw rate, and bias the aim point away from a wall we are already close to.
  const spd = Math.abs(kart.speed);
  const look = clamp(AI.lookahead + spd * 1.15, 14, 60);
  const lookIdx = advanceIdx(pl, kart.plIdx, Math.round(look / SPACING_HINT));
  const f = frameAt(pl, lookIdx);
  const safe = Math.max(1.0, half - 3.2);
  let aimOffset = clamp(ai.lineOffset, -safe, safe);
  const nearWall = half - 4.2;
  if (Math.abs(s.side) > nearWall) {
    aimOffset = -Math.sign(s.side) * Math.min(safe, (Math.abs(s.side) - nearWall) * 2.4 + 1.2);
  }
  const tx = f.x + f.nx * aimOffset, tz = f.z + f.nz * aimOffset;

  // avoid a kart right in front by sliding the aim point sideways
  const rival = nearestRival(kart, ctx.karts, AI.avoidRadius);
  let dodge = 0, brake = 0;
  if (rival) {
    const dx = rival.pos.x - kart.pos.x, dz = rival.pos.z - kart.pos.z;
    const ahead = dx * Math.cos(kart.heading) + dz * Math.sin(kart.heading);
    const side = -dx * Math.sin(kart.heading) + dz * Math.cos(kart.heading);
    if (ahead > 0 && ahead < AI.avoidRadius && Math.abs(side) < 2.6) {
      dodge = (clamp(-side, -1, 1) || (rng() < 0.5 ? -1 : 1)) * (1.4 - ahead / AI.avoidRadius);
      if (ahead < 4.5) brake = -0.7;
    }
  }
  const rx = -Math.sin(kart.heading), rz = Math.cos(kart.heading);   // right of travel
  const aimX = tx + rx * dodge * 2.2, aimZ = tz + rz * dodge * 2.2;

  const err = angleDiff(kart.heading, Math.atan2(aimZ - kart.pos.z, aimX - kart.pos.x));
  // yaw damping kills the weave
  const yaw = ai.prevHeading === null ? 0 : angleDiff(ai.prevHeading, kart.heading) / dt;
  ai.prevHeading = kart.heading;
  let steer = clamp(err * 1.5 - clamp(yaw, -3, 3) * 0.5, -1, 1);
  // slew limit: no snapping the wheel from full left to full right
  const maxDelta = 5.5 * dt;
  steer = clamp(steer, ai.lastSteer - maxDelta, ai.lastSteer + maxDelta);
  ai.lastSteer = steer;

  // ---- throttle / brake to hit the corner speed ----
  const wallPenalty = 1 - 0.3 * clamp((Math.abs(s.side) - (half - 4.5)) / 3.5, 0, 1);
  const want = Math.min(vMax, Math.max(vMax * AI.cornerSlowK, vCorner)) * wallPenalty;
  let throttle = 1;
  if (kart.speed > want * 1.05) throttle = brake || -0.8;
  else if (kart.speed > want) throttle = brake || -0.15;
  else throttle = brake ? Math.max(-0.4, brake) : 1;
  if (kart.speed < 1 && kart.spin > 0) throttle = 0;

  // ---- drift chain: hold drift through medium-long corners, then release for the boost ----
  ai.driftCool = Math.max(0, ai.driftCool - dt);
  let drift = false;
  if (ai.driftT > 0) { ai.driftT -= dt; drift = true; if (ai.driftT <= 0) drift = false; }
  if (!drift && ai.driftCool <= 0 && kart.air.onGround && s.onRoad) {
    const straightish = curv > 0.002 && curv < 0.06 && Math.abs(steer) > 0.15 && kart.speed > want * 0.7;
    if (straightish && rng() < AI.itemUseChance * 3 * dt) {
      // drift long enough to reach the super/ultra mini-turbo tiers (driftCharge 1.0/2.0/3.4 s):
      // the player chains those for 1.3-1.45x top speed, which is exactly the pace the field
      // was missing (player 33 s laps vs 43 s, 2026-11-09).
      ai.driftT = rngRange(rng, 2.2, 4.2);
      ai.driftCool = rngRange(rng, 0.6, 2.0);
      drift = true;
    }
  }
  if (Math.abs(s.side) > half - 2.5) ai.driftT = 0;   // never drift into the wall

  // ---- item usage ----
  ai.useT = Math.max(0, ai.useT - dt);
  let use = false;
  const held = ITEM_TRIPLE[kart.item] ? kart.item : kart.item;
  if (kart.item && ai.useT <= 0) {
    const isBoost = held === ITEM.MUSHROOM;
    const isOffense = held === ITEM.RED_SHELL || held === ITEM.GREEN_SHELL || held === ITEM.BANANA || held === ITEM.FAKE_ITEM;
    const front = nearestRival(kart, ctx.karts.filter((r) => r.place < kart.place), 90);
    const behind = nearestRival(kart, ctx.karts.filter((r) => r.place > kart.place), 22);
    const straight = curv < 0.02;
    const go =
      (isBoost && straight) ||
      (isOffense && (front || behind)) ||
      held === ITEM.LIGHTNING || held === ITEM.STAR;
    if (go && rng() < AI.itemUseChance * dt * 6) { use = true; ai.useT = AI.itemUseCooldown; }
    else ai.useT = Math.max(ai.useT, 0.35);
  }

  kart.input.throttle = throttle; kart.input.steer = steer;
  kart.input.drift = drift; kart.input.use = use;
  return { throttle, steer, drift, use };
}
