// kart.js — arcade kart physics (the driving feel). PURE: no DOM, no THREE.
// Contract: docs/INTERFACES.md §0 (state shape) and §2 (behaviour).
//
// Conventions
//   forward = (cos h, sin h) in XZ, Y up.  right of travel = (-sin h, cos h).
//   steer +1 = right = heading INCREASES.  track `side` is + to the LEFT of travel.
//   lean  > 0 = body rolls toward the right of travel (outward roll in a left turn).
//
// Model (per fixed step)
//   1. timers tick down (boost, star, invisible, shrunk, spin, wallHit, hitFlash, fx.shake)
//   2. drift latch / charge / release  -> boost
//   3. heading += steer * steerRate * falloff(speed) * (drift?driftTurnBoost:1) * (air?airSteer:1) * dt
//   4. speed (signed scalar) ramps toward maxEff with accel / brake / reverse / drag
//   5. vel = damp(vel, forward*speed, grip)      <- the lag of vel behind heading IS the slide
//   6. pos += vel*dt, then track.sample(): walls, off-road, pads, surface height
//   External impulses (walls, kart bumps) change vel and feed their forward component back
//   into speed — that is "speed derived from vel projected on forward".

import { KART, ITEMS, CAM, RACE, PLAYERS } from '../config.js';
import { clamp, damp, approach, sign, forward2, wrapPi } from '../foundation.js';

// ---- local constants (cosmetic or structural; nothing here duplicates a config knob) ----
const SHRUNK_MUL = 0.85;          // contract §2: shrunk -> 0.85 speed cap
const LOW_SPEED_STEER = 5.0;      // m/s below which steering authority fades to 0 (no turning on the spot)
const BOOST_THRUST = 2.5;         // accel multiplier while a boost is active (boosts must feel punchy)
const DRIFT_MIN_SPEED = 9.0;      // m/s needed to latch a drift
const DRIFT_KEEP_SPEED = 5.5;     // drift breaks (no boost) below this
const DRIFT_STEER_BASE = 0.6;     // steer inside a drift = dir * clamp(BASE + RANGE*steer*dir, MIN, 1)
const DRIFT_STEER_RANGE = 0.4;
const DRIFT_STEER_MIN = 0.2;
const WALL_FX_TIME = 0.5;         // s a wall hit stays "fresh" (also cooldown before the next speed cut)
const HIT_FLASH = 0.6;            // matches items.js hit flash
const MAX_WHEEL_ANGLE = 0.45;     // rad front-wheel visual steer
const STEER_VIS_RATE = 14;
const WHEEL_RADIUS = 0.32;        // m, for wheelSpin
const LEAN_RATE = 8;
const DUST_INTERVAL = 0.06;       // s between off-road dust puffs
const SPARK_INTERVAL = 0.05;      // s between drift spark trails
const SPARK_COLORS = [0x5ab4ff, 0xff9a2a, 0xd36bff];   // mini / super / ultra
const AG_EXTRA = 1.0;             // m past the road edge a kart may climb inside an anti-gravity range
const AG_ASSIST_FROM = 0.6;       // |side|/half where the inward bank assist starts
const AG_ASSIST = 0.006;          // inward accel per (m/s)², ≈5.4 m/s² at top speed high on the bank
const AG_ALIGN = 6;               // 1/s rate the nose turns along the bank lip
const AG_FX_DECAY = 0.5;          // s for fx.ag to fade after leaving a range
const DEFAULT_FIELD = RACE.aiField + PLAYERS.length;

// Private per-kart scratch that is NOT part of the shared §0 shape.
const priv = new WeakMap();
function P(k) {
  let p = priv.get(k);
  if (!p) { p = { dust: 0, spark: 0, prevYaw: 0 }; priv.set(k, p); }
  return p;
}

const fxCall = (fx, fn, ...a) => { if (fx && typeof fx[fn] === 'function') fx[fn](...a); };

// ------------------------------------------------------------------ create
export function createKart(id, spec, human) {
  return {
    id, name: (spec && spec.name) || `P${id + 1}`, spec, human: !!human, ai: human ? null : {},
    pos: { x: 0, y: 0, z: 0 },
    heading: 0,
    speed: 0,
    vel: { x: 0, z: 0 },
    input: { throttle: 0, steer: 0, drift: false, use: false },
    drift: { on: false, dir: 0, time: 0, tier: -1 },
    air: { y: 0, vy: 0, onGround: true },
    boost: { time: 0, mul: 1 },
    item: 0, count: 0,
    star: 0, invisible: 0, shrunk: 0, spin: 0,
    offRoad: false, onPad: false, wallHit: 0, hitFlash: 0,
    plIdx: 0,
    lap: 0, progress: 0, place: 1, finished: false, finishTime: 0, raceTime: 0, lapStart: 0, lapTimes: [],
    fx: { shake: 0, boost: 0, spark: -1, ag: 0 },
    lean: 0, wheelSpin: 0, steerVis: 0,
  };
}

// ------------------------------------------------------------------ helpers
// Fresh boost replaces a weaker one; an equal one extends; a weaker one is ignored while active.
export function applyBoost(kart, mul, time) {
  const b = kart.boost;
  if (b.time <= 0 || mul > b.mul) { b.mul = mul; b.time = time; }
  else if (mul === b.mul) b.time = Math.max(b.time, time);
}

export function maxEffOf(kart) {
  const boostMul = kart.boost.time > 0 ? kart.boost.mul : 1;
  return KART.maxSpeed * boostMul * (kart.shrunk > 0 ? SHRUNK_MUL : 1)
    * (kart.offRoad ? KART.offRoadMul : 1) * (kart.star > 0 ? KART.starMul : 1)
    * (kart.vmul || 1);   // per-kart top-speed multiplier (AI puts skill here; humans stay 1.0)
}

export function steerFalloffFactor(speed) {
  const a = Math.abs(speed);
  return (1 - KART.steerFalloff * clamp(a / KART.maxSpeed, 0, 1)) * clamp(a / LOW_SPEED_STEER, 0, 1);
}

function tierFor(time) {
  let t = -1;
  for (let i = 0; i < KART.driftCharge.length; i++) if (time >= KART.driftCharge[i]) t = i;
  return t;
}

function endDrift(kart, fire, fx) {
  const d = kart.drift;
  if (fire && d.tier >= 0) {
    applyBoost(kart, KART.driftBoost[d.tier], KART.driftBoostTime[d.tier]);
    fxCall(fx, 'ring', kart.pos.x, kart.pos.y + 0.3, kart.pos.z,
      { color: SPARK_COLORS[d.tier], r0: 0.5, r1: 3 + d.tier, life: 0.4 });
  }
  d.on = false; d.dir = 0; d.time = 0; d.tier = -1;
}

// unit "left of travel" normal from a track sample (fake tracks may leave nx/nz at 0)
function leftNormal(s) {
  if (s.nx || s.nz) { const l = Math.hypot(s.nx, s.nz); return { x: s.nx / l, z: s.nz / l }; }
  return { x: s.tz, z: -s.tx };
}

function surfaceAt(track, x, z, s) {
  return typeof track.surfaceY === 'function' ? track.surfaceY(x, z) : (s && s.y) || 0;
}

// ------------------------------------------------------------------ step
export function stepKart(kart, track, dt, ctx = {}) {
  const fx = ctx.fx;
  const p = P(kart);
  const inp = kart.input;

  // ---- 1. timers
  kart.boost.time = Math.max(0, kart.boost.time - dt);
  if (kart.boost.time <= 0) kart.boost.mul = 1;
  kart.star = Math.max(0, kart.star - dt);
  kart.invisible = Math.max(0, kart.invisible - dt);
  kart.shrunk = Math.max(0, kart.shrunk - dt);
  kart.spin = Math.max(0, kart.spin - dt);
  kart.wallHit = Math.max(0, kart.wallHit - dt);
  kart.hitFlash = Math.max(0, kart.hitFlash - dt);
  kart.fx.shake = Math.max(0, kart.fx.shake - CAM.shakeDecay * dt);

  const spinning = kart.spin > 0;
  const throttle = spinning ? 0 : clamp(inp.throttle || 0, -1, 1);
  const steerIn = spinning ? 0 : clamp(inp.steer || 0, -1, 1);
  const driftHeld = !spinning && !!inp.drift;
  const steerDir = sign(steerIn);
  const air = kart.air;
  const d = kart.drift;

  // ---- 2. drift / mini-turbo chain
  if (d.on) {
    if (!driftHeld) endDrift(kart, true, fx);                                  // release -> boost for tier
    else if (Math.abs(kart.speed) < DRIFT_KEEP_SPEED || kart.speed < 0) endDrift(kart, false, fx);
  }
  if (!d.on && driftHeld && air.onGround && kart.speed >= DRIFT_MIN_SPEED) {
    // Holding the drift key latches a drift with or without steering. d.dir === 0 means a
    // straight drift and steering passes through normally. It used to require steering to even
    // start and died the moment the wheel centered ("shift does nothing"), and it punched the
    // kart airborne, which read as the model sinking into the ground (2026-11-09) — no hop.
    d.on = true; d.dir = steerDir; d.time = 0; d.tier = -1;
  }
  if (d.on) {
    const before = d.tier;
    d.time += dt;
    d.tier = tierFor(d.time);
    if (d.tier > before) fxCall(fx, 'burst', kart.pos.x, kart.pos.y + 0.3, kart.pos.z,
      { color: SPARK_COLORS[d.tier], count: 10, speed: 5, life: 0.35, size: 0.25, additive: true });
  }
  kart.fx.spark = d.on ? d.tier : -1;

  // ---- 3. steering
  let steer = steerIn;
  if (kart.magnetT > 0) {
    // Re-Volt's magnet, borrowed for Kart Clash (2026-11-09): the kart sticks to the centre
    // line on its own. Steering input is ignored while it lasts; throttle stays yours.
    kart.magnetT -= dt;
    const ms = track.sample(kart.pos.x, kart.pos.z, kart.plIdx);
    const tx = ms.tx || 0, tz = ms.tz || 0;
    if (tx || tz) steer = clamp(wrapPi(Math.atan2(tz, tx) - kart.heading) * 2.2, -1, 1);
  } else if (d.on && d.dir !== 0)
  if (d.on && d.dir !== 0) steer = d.dir * clamp(DRIFT_STEER_BASE + DRIFT_STEER_RANGE * steerIn * d.dir, DRIFT_STEER_MIN, 1);
  const dirSign = kart.speed < 0 ? -1 : 1;                                    // reverse steers mirrored
  const yawRate = steer * dirSign * KART.steerRate * steerFalloffFactor(kart.speed)
    * (d.on ? KART.driftTurnBoost : 1) * (air.onGround ? 1 : KART.airSteer);
  kart.heading += yawRate * dt;
  const f = forward2(kart.heading);

  // ---- 4. speed (signed scalar along forward)
  const maxEff = maxEffOf(kart);
  const boosting = kart.boost.time > 0;
  const startSpeed = kart.speed;
  let speed = kart.speed;
  if (spinning) {
    speed = approach(speed, 0, KART.brake * dt);
  } else if (boosting && throttle >= 0) {
    speed = approach(speed, maxEff, KART.accel * BOOST_THRUST * dt);         // boosts push without throttle
  } else if (throttle > 0) {
    if (speed < 0) speed = approach(speed, 0, KART.brake * dt);
    else speed = approach(speed, maxEff, KART.accel * throttle * dt);
  } else if (throttle < 0) {
    if (speed > 0) speed = approach(speed, 0, KART.brake * -throttle * dt);
    else speed = approach(speed, -KART.reverseMax, KART.accel * -throttle * dt);
  } else {
    speed = damp(speed, 0, KART.drag, dt);
    if (Math.abs(speed) < 0.05) speed = 0;
  }
  // cap: never above maxEff; if we were already above (boost ended, went off-road) bleed off at brake rate
  const cap = Math.max(maxEff, startSpeed - KART.brake * dt);
  if (speed > cap) speed = cap;
  if (speed < -KART.reverseMax) speed = -KART.reverseMax;
  kart.speed = speed;

  // ---- 5. grip: velocity converges to forward*speed (slide = lag)
  const grip = d.on ? KART.driftGrip : kart.offRoad ? KART.offRoadGrip : KART.grip;
  kart.vel.x = damp(kart.vel.x, f.x * speed, grip, dt);
  kart.vel.z = damp(kart.vel.z, f.z * speed, grip, dt);

  // ---- air
  if (!air.onGround) {
    air.vy -= KART.hopGravity * dt;
    air.y += air.vy * dt;
    if (air.y <= 0) {
      air.y = 0; air.vy = 0; air.onGround = true;
      kart.fx.shake = Math.max(kart.fx.shake, 0.08);
      fxCall(fx, 'burst', kart.pos.x, kart.pos.y, kart.pos.z,
        { color: 0xd9cdb0, count: 6, speed: 3, life: 0.35, size: 0.3, gravity: -4 });
    }
  }

  // ---- 6. integrate + track
  kart.pos.x += kart.vel.x * dt;
  kart.pos.z += kart.vel.z * dt;
  const s = track.sample(kart.pos.x, kart.pos.z, kart.plIdx);
  const ag = !!s.ag;
  const limit = ag ? s.half + AG_EXTRA : s.half - KART.radius;
  let surfS = s;
  if (ag) {
    // anti-gravity wall-ride: the bank (track.surfaceY) lifts the kart; no wall hit, no speed loss
    const n = leftNormal(s), sg = sign(s.side), ox = n.x * sg, oz = n.z * sg;
    const u = Math.abs(s.side) / s.half;
    if (u > AG_ASSIST_FROM && kart.speed > 0) {             // gentle inward pull a ∝ speed²: yaw at a/v
      const a = AG_ASSIST * kart.speed * kart.speed * Math.min(1, (u - AG_ASSIST_FROM) / (1 - AG_ASSIST_FROM));
      kart.heading += sign(f.z * ox - f.x * oz) * (a / kart.speed) * dt;
    }
    if (Math.abs(s.side) > limit) {                         // top of the bank: slide along it
      const pen = Math.abs(s.side) - limit;
      kart.pos.x -= ox * pen; kart.pos.z -= oz * pen;
      const vOut = kart.vel.x * ox + kart.vel.z * oz;
      if (vOut > 0) { kart.vel.x -= ox * vOut; kart.vel.z -= oz * vOut; }
      const fo = f.x * ox + f.z * oz;
      if (fo > 0) {                                         // nose into the lip: turn it along the bank
        const along = Math.atan2(f.z - oz * fo, f.x - ox * fo);
        kart.heading += wrapPi(along - kart.heading) * Math.min(1, AG_ALIGN * dt);
      }
      surfS = null;
    }
  } else if (Math.abs(s.side) > limit) {
    const n = leftNormal(s);
    const sg = sign(s.side);
    const ox = n.x * sg, oz = n.z * sg;                    // outward unit vector
    const pen = Math.abs(s.side) - limit;
    kart.pos.x -= ox * pen;
    kart.pos.z -= oz * pen;
    const vOut = kart.vel.x * ox + kart.vel.z * oz;
    const fBefore = kart.vel.x * f.x + kart.vel.z * f.z;
    const fresh = kart.wallHit <= 0;
    if (vOut > 0) {                                         // reflect the outward part
      kart.vel.x -= ox * vOut * (1 + KART.wallBounce);
      kart.vel.z -= oz * vOut * (1 + KART.wallBounce);
    }
    if (fresh) {
      // cut the tangential (along-wall) motion too, so the projection below keeps the loss
      const vx = kart.vel.x, vz = kart.vel.z;
      const vo = vx * ox + vz * oz;
      kart.vel.x = ox * vo + (vx - ox * vo) * KART.wallSpeedLoss;
      kart.vel.z = oz * vo + (vz - oz * vo) * KART.wallSpeedLoss;
      const impact = clamp((Math.abs(vOut) + Math.abs(kart.speed) * 0.3) / KART.maxSpeed, 0.15, 1);
      kart.speed *= KART.wallSpeedLoss;
      kart.wallHit = WALL_FX_TIME;
      kart.fx.shake = Math.max(kart.fx.shake, impact);
      if (d.on) endDrift(kart, false, fx);                  // slamming a wall kills the charge
      fxCall(fx, 'burst', kart.pos.x + ox * KART.radius, kart.pos.y + 0.5, kart.pos.z + oz * KART.radius,
        { color: 0xffe08a, count: 10, speed: 7, life: 0.4, size: 0.25, additive: true });
    } else {
      // grinding along the wall: speed follows the reflected velocity
      const fAfter = kart.vel.x * f.x + kart.vel.z * f.z;
      if (kart.speed > 0) kart.speed = Math.max(0, Math.min(kart.speed, kart.speed + (fAfter - fBefore)));
    }
    surfS = null;
  }

  kart.offRoad = !ag && !s.onRoad;
  const wasOnPad = kart.onPad;
  kart.onPad = !!s.pad;
  if (kart.onPad) {
    applyBoost(kart, KART.padMul, KART.padTime);
    if (!wasOnPad) {
      kart.fx.shake = Math.max(kart.fx.shake, 0.15);
      fxCall(fx, 'ring', kart.pos.x, kart.pos.y + 0.2, kart.pos.z, { color: 0xffd23f, r0: 0.6, r1: 4, life: 0.45 });
    }
  }

  kart.pos.y = surfaceAt(track, kart.pos.x, kart.pos.z, surfS || s) + air.y;

  // ---- effects for the renderer
  kart.fx.boost = kart.boost.time > 0 ? Math.min(1, kart.boost.time / 0.4) : 0;
  kart.fx.ag = ag ? 1 : Math.max(0, (kart.fx.ag || 0) - dt / AG_FX_DECAY);
  kart.steerVis = damp(kart.steerVis, steer * MAX_WHEEL_ANGLE, STEER_VIS_RATE, dt);
  kart.wheelSpin += (kart.speed / WHEEL_RADIUS) * dt;
  if (kart.wheelSpin > 1e6 || kart.wheelSpin < -1e6) kart.wheelSpin %= Math.PI * 2;
  const latAcc = kart.speed * yawRate;                     // m/s^2, + = turning right
  const latRef = KART.maxSpeed * KART.steerRate * (1 - KART.steerFalloff);
  kart.lean = damp(kart.lean, -KART.bankMax * clamp(latAcc / latRef, -1, 1), LEAN_RATE, dt);
  p.prevYaw = yawRate;

  // off-road dust
  if (kart.offRoad && air.onGround && Math.abs(kart.speed) > 3) {
    p.dust += dt;
    if (p.dust >= DUST_INTERVAL) {
      p.dust = 0;
      fxCall(fx, 'burst', kart.pos.x - f.x * 1.2, kart.pos.y + 0.2, kart.pos.z - f.z * 1.2,
        { color: 0x9a7b4f, count: 3, speed: 2.5, life: 0.5, size: 0.4, gravity: -2 });
    }
  } else p.dust = 0;
  // drift sparks behind the rear wheels
  if (d.on && d.tier >= 0 && air.onGround) {
    p.spark += dt;
    if (p.spark >= SPARK_INTERVAL) {
      p.spark = 0;
      const r = { x: -f.z, z: f.x };
      for (const sd of [-1, 1]) {
        fxCall(fx, 'trail', kart.pos.x - f.x * 1.1 + r.x * sd * 0.8, kart.pos.y + 0.15,
          kart.pos.z - f.z * 1.1 + r.z * sd * 0.8, { color: SPARK_COLORS[d.tier], life: 0.25, size: 0.22 });
      }
    }
  } else p.spark = 0;
}

// ------------------------------------------------------------------ kart vs kart
export function resolveKartCollisions(karts) {
  const minD = KART.bumperRadius * 2;
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i], b = karts[j];
      let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      let dd = Math.hypot(dx, dz);
      if (dd >= minD) continue;
      const overlap = minD - dd;
      if (dd < 1e-6) {                                     // perfectly stacked: separate deterministically
        const h = a.heading + Math.PI / 2; dx = Math.cos(h); dz = Math.sin(h); dd = 1;
        if (!(Math.abs(dx) + Math.abs(dz))) { dx = 1; dz = 0; }
      }
      const nx = dx / dd, nz = dz / dd;                    // a -> b
      const aStar = a.star > 0, bStar = b.star > 0;
      // mass weights: a star kart is immovable for a non-star kart
      let wa = 0.5, wb = 0.5;
      if (aStar && !bStar) { wa = 0; wb = 1; } else if (bStar && !aStar) { wa = 1; wb = 0; }

      a.pos.x -= nx * overlap * wa; a.pos.z -= nz * overlap * wa;
      b.pos.x += nx * overlap * wb; b.pos.z += nz * overlap * wb;

      // velocity: cancel the approaching normal component (shared by weights) + a push kick
      const vrel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      const closing = vrel < 0 ? -vrel : 0;
      const kick = KART.pushForce * (overlap / minD);
      const dva = (closing + kick) * wa, dvb = (closing + kick) * wb;
      const fa = forward2(a.heading), fb = forward2(b.heading);
      a.vel.x -= nx * dva; a.vel.z -= nz * dva;
      b.vel.x += nx * dvb; b.vel.z += nz * dvb;
      // speed follows the forward projection of the impulse
      a.speed += -(nx * fa.x + nz * fa.z) * dva;
      b.speed += (nx * fb.x + nz * fb.z) * dvb;

      // star ramming spins the other kart out
      const victim = aStar && !bStar ? b : bStar && !aStar ? a : null;
      if (victim && victim.spin <= 0) {
        victim.spin = ITEMS.spinOutTime;
        victim.speed *= KART.spinSpeedLoss;
        victim.hitFlash = HIT_FLASH;
        victim.fx.shake = Math.max(victim.fx.shake, 1);
        if (victim.drift.on) endDrift(victim, false, null);
      } else if (!victim) {
        const shake = clamp(closing / 15, 0.1, 0.5);
        a.fx.shake = Math.max(a.fx.shake, shake);
        b.fx.shake = Math.max(b.fx.shake, shake);
      }
    }
  }
}

// ------------------------------------------------------------------ recover / reset
function clearMotion(kart) {
  kart.speed = 0;
  kart.vel.x = 0; kart.vel.z = 0;
  kart.drift.on = false; kart.drift.dir = 0; kart.drift.time = 0; kart.drift.tier = -1;
  kart.air.y = 0; kart.air.vy = 0; kart.air.onGround = true;
  kart.fx.spark = -1;
  kart.lean = 0; kart.steerVis = 0;
}

// Put the kart back on the centreline at plIdx, facing along the track, speed 0.
export function recoverKart(kart, track) {
  const pl = track.pl;
  const i = pl && pl.count ? ((kart.plIdx % pl.count) + pl.count) % pl.count : 0;
  const pt = pl && pl.pts && pl.pts[i] ? pl.pts[i] : { x: kart.pos.x, z: kart.pos.z };
  let tx, tz;
  if (pl && pl.tangents && pl.tangents[i]) { tx = pl.tangents[i].x; tz = pl.tangents[i].z; }
  else { const s = track.sample(pt.x, pt.z, i); tx = s.tx; tz = s.tz; }
  kart.pos.x = pt.x; kart.pos.z = pt.z;
  kart.heading = Math.atan2(tz, tx);
  clearMotion(kart);
  kart.spin = 0;
  kart.boost.time = 0; kart.boost.mul = 1;
  kart.offRoad = false; kart.onPad = false;
  kart.pos.y = surfaceAt(track, pt.x, pt.z, null);
}

// Grid placement. `slot` = grid index (track.gridSlot(slot, count)) or an already-resolved
// { x, z, heading }. Resets driving + effect state; race bookkeeping (lap/progress/place/plIdx)
// belongs to race.js and is left alone.
export function resetKart(kart, slot, track, count = DEFAULT_FIELD) {
  const g = typeof slot === 'object' && slot ? slot : track.gridSlot(slot, count);
  kart.pos.x = g.x; kart.pos.z = g.z;
  kart.heading = g.heading;
  clearMotion(kart);
  kart.input.throttle = 0; kart.input.steer = 0; kart.input.drift = false; kart.input.use = false;
  kart.boost.time = 0; kart.boost.mul = 1;
  kart.item = 0; kart.count = 0;
  kart.star = 0; kart.invisible = 0; kart.shrunk = 0; kart.spin = 0;
  kart.offRoad = false; kart.onPad = false; kart.wallHit = 0; kart.hitFlash = 0;
  kart.fx.shake = 0; kart.fx.boost = 0; kart.fx.ag = 0;
  kart.wheelSpin = 0;
  kart.pos.y = surfaceAt(track, g.x, g.z, null);
  priv.delete(kart);
}
