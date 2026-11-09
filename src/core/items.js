// items.js — item boxes, item use, live effects (shells, bananas, zaps, clouds, starbursts) and hits.
// PURE: no DOM, no THREE. Contract: docs/INTERFACES.md section 3.

import { ITEM, ITEM_TRIPLE, ITEM_COUNT, ITEMS, KART, PLAYERS, RACE, tableForPlace } from '../config.js';
import { rngWeighted, forward2, headingOf, angleDiff, idxDelta, dist2, clamp } from '../foundation.js';

// Local constants (no knob exists for these in config.js).
const BOX_FLOAT = 0.9;            // cosmetic: box hover height above the surface
const BOX_EDGE_MARGIN = 2.0;      // keep the outer boxes this far inside the road edge
const SHELL_FOLLOW_RATE = 5.0;    // rad/s a non-homing shell turns to align with the centreline
const CLOUD_DROP_EVERY = 1.2;     // s between bananas dropped while invisible (fake item)
const STAR_DROP_EVERY = 2.0;      // s between rolling banana drops while under a star
const ZAP_LIFE = 0.6;             // s a lightning zap marker lives (visual only)
const LIGHTNING_BIG_BONUS = 2.0;  // extra shrink seconds for the "big gap" version
const HIT_FLASH = 0.6;

function callFx(fx, name, ...args) {
  if (fx && typeof fx[name] === 'function') fx[name](...args);
}

export function createItemSystem(track, rng) {
  const pl = track && track.pl;
  const loopOK = !!(pl && pl.count > 1);
  const surfaceY = (x, z) => (track && typeof track.surfaceY === 'function' ? track.surfaceY(x, z) : 0);
  const sample = (x, z, hint) => track.sample(x, z, hint);

  const boxes = [];
  const effects = [];
  const perKart = new Map();   // kart.id -> { lastUse, cloudT, starT }
  let clock = 0;

  function kartState(k) {
    let st = perKart.get(k.id);
    if (!st) { st = { lastUse: -Infinity, lastPick: -Infinity, cloudT: 0, starT: 0, cloudFx: null, starFx: null }; perKart.set(k.id, st); }
    return st;
  }

  function buildBoxes() {
    boxes.length = 0;
    const nodes = (track && track.itemNodes) || [];
    const n = Math.max(1, ITEMS.boxCount);
    for (const node of nodes) {
      const s = sample(node.x, node.z, node.idx);
      const half = typeof s.half === 'number' ? s.half : (track.halfWidth ? track.halfWidth(node.idx) : 6);
      const span = Math.max(0, half - BOX_EDGE_MARGIN);
      for (let i = 0; i < n; i++) {
        const off = n === 1 ? 0 : (i / (n - 1) * 2 - 1) * span;
        const x = node.x + s.nx * off, z = node.z + s.nz * off;
        boxes.push({ x, y: surfaceY(x, z) + BOX_FLOAT, z, active: true, respawnAt: 0 });
      }
    }
  }

  function idxOf(k) {
    const s = sample(k.pos.x, k.pos.z, typeof k.plIdx === 'number' ? k.plIdx : -1);
    return s.idx;
  }

  function fieldSize(ctx) {
    return (ctx && ctx.karts && ctx.karts.length) || (PLAYERS.length + RACE.aiField);
  }

  // ------------------------------------------------------------ effects
  function makeEffect(kind, item, owner, x, z, heading, speed, radius, life) {
    const f = forward2(heading);
    const e = {
      kind, item, owner,
      pos: { x, y: surfaceY(x, z) + radius, z },
      vel: { x: f.x * speed, z: f.z * speed },
      heading, radius, life, active: true, homing: null, spin: 0,
      idx: -1, wallHits: 0,
    };
    effects.push(e);
    return e;
  }

  function dropBanana(k, fx) {
    const f = forward2(k.heading);
    const x = k.pos.x - f.x * ITEMS.banana.dropBack, z = k.pos.z - f.z * ITEMS.banana.dropBack;
    const e = makeEffect('banana', ITEM.BANANA, k.id, x, z, k.heading, 0, ITEMS.banana.radius, ITEMS.banana.life);
    const s = sample(x, z, typeof k.plIdx === 'number' ? k.plIdx : -1);
    e.idx = s.idx;
    if (Math.abs(s.side) > s.half) { e.active = false; e.life = 0; }   // dropped through the wall
    else callFx(fx, 'burst', x, e.pos.y, z, { color: 0xffe14d, count: 6, speed: 3, life: 0.35 });
    return e;
  }

  // nearest rival AHEAD (track-index order, loop-aware) of `fromIdx`, within the homing radius
  function findRedTarget(x, z, fromIdx, ownerId, karts) {
    if (!loopOK || !karts) return null;
    let best = null, bestD = Infinity;
    for (const k of karts) {
      if (k.id === ownerId || k.finished || k.invisible > 0) continue;
      const d = dist2(x, z, k.pos.x, k.pos.z);
      if (d > ITEMS.redHomingRadius) continue;
      if (idxDelta(pl, fromIdx, idxOf(k)) <= 0) continue;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best ? best.id : null;
  }

  function throwShell(k, item, ctx) {
    const f = forward2(k.heading);
    const lead = KART.radius + ITEMS.shell.radius + 0.4;
    const x = k.pos.x + f.x * lead, z = k.pos.z + f.z * lead;
    // red is the STRONGER shell: faster than green (plus homing in stepShell). Same speed made
    // the two feel identical ("no difference in power", 2026-11-09).
    const spd = item === ITEM.RED_SHELL ? ITEMS.shell.speed * ITEMS.shell.redSpeedMul : ITEMS.shell.speed;
    const e = makeEffect('shell', item, k.id, x, z, k.heading, spd, ITEMS.shell.radius, ITEMS.shell.life);
    e.idx = sample(x, z, typeof k.plIdx === 'number' ? k.plIdx : -1).idx;
    if (item === ITEM.RED_SHELL) e.homing = findRedTarget(k.pos.x, k.pos.z, idxOf(k), k.id, ctx && ctx.karts);
    callFx(ctx && ctx.fx, 'burst', x, e.pos.y, z, { color: item === ITEM.RED_SHELL ? 0xff3b30 : 0x34c759, count: 8, speed: 4, life: 0.3 });
    return e;
  }

  function stepShell(e, dt, ctx) {
    const karts = ctx && ctx.karts;
    let speed = Math.hypot(e.vel.x, e.vel.z);
    const s0 = sample(e.pos.x, e.pos.z, e.idx);
    e.idx = s0.idx;

    // red shell: (re)acquire a target ahead of the shell, drop it if it vanished
    if (e.item === ITEM.RED_SHELL && karts) {
      let tgt = e.homing !== null ? karts.find((k) => k.id === e.homing) : null;
      if (tgt && (tgt.finished || tgt.invisible > 0)) { tgt = null; e.homing = null; }
      if (!tgt) {
        e.homing = findRedTarget(e.pos.x, e.pos.z, e.idx, e.owner, karts);
        tgt = e.homing !== null ? karts.find((k) => k.id === e.homing) : null;
      }
      if (tgt) {
        const want = Math.atan2(tgt.pos.z - e.pos.z, tgt.pos.x - e.pos.x);
        e.heading += clamp(angleDiff(e.heading, want), -ITEMS.redTurnRate * dt, ITEMS.redTurnRate * dt);
      }
    }
    if (e.homing === null) {
      // hug the road: align with the centreline in whichever direction the shell travels
      const dir = (Math.cos(e.heading) * s0.tx + Math.sin(e.heading) * s0.tz) >= 0 ? 1 : -1;
      const want = Math.atan2(s0.tz * dir, s0.tx * dir);
      const rate = SHELL_FOLLOW_RATE * dt;
      e.heading += clamp(angleDiff(e.heading, want), -rate, rate);
    }

    const f = forward2(e.heading);
    e.vel.x = f.x * speed; e.vel.z = f.z * speed;
    e.pos.x += e.vel.x * dt; e.pos.z += e.vel.z * dt;
    e.spin += dt * 18;

    // walls: bounce once with ITEMS.shell.bounce (life cut to wallBounceLife), a second hit kills it
    const s = sample(e.pos.x, e.pos.z, e.idx);
    e.idx = s.idx;
    const limit = s.half - e.radius;
    if (Math.abs(s.side) > limit) {
      const sg = s.side > 0 ? 1 : -1;
      const push = s.side - sg * limit;
      e.pos.x -= s.nx * push; e.pos.z -= s.nz * push;
      const vn = e.vel.x * s.nx + e.vel.z * s.nz;
      if (vn * sg > 0) { e.vel.x -= (1 + ITEMS.shell.bounce) * vn * s.nx; e.vel.z -= (1 + ITEMS.shell.bounce) * vn * s.nz; }
      e.vel.x *= ITEMS.shell.bounce; e.vel.z *= ITEMS.shell.bounce;
      e.heading = headingOf(e.vel);
      e.wallHits++;
      e.homing = null;
      callFx(ctx && ctx.fx, 'burst', e.pos.x, e.pos.y, e.pos.z, { color: 0xffffff, count: 6, speed: 4, life: 0.25 });
      if (e.wallHits >= 2) { e.life = 0; e.active = false; }
      else e.life = Math.min(e.life, ITEMS.shell.wallBounceLife);
      speed = Math.hypot(e.vel.x, e.vel.z);
    }
    e.pos.y = surfaceY(e.pos.x, e.pos.z) + e.radius;
  }

  // ------------------------------------------------------------ hits
  function hitKart(k, e, ctx) {
    const fx = ctx && ctx.fx;
    k.spin = ITEMS.spinOutTime;
    k.speed *= KART.spinSpeedLoss;
    k.vel.x *= KART.spinSpeedLoss; k.vel.z *= KART.spinSpeedLoss;
    if (e) {   // small knock away from the impact point
      const dx = k.pos.x - e.pos.x, dz = k.pos.z - e.pos.z, l = Math.hypot(dx, dz) || 1;
      k.vel.x += dx / l * ITEMS.hitPush * KART.spinSpeedLoss; k.vel.z += dz / l * ITEMS.hitPush * KART.spinSpeedLoss;
    }
    k.hitFlash = HIT_FLASH;
    if (k.fx) k.fx.shake = 1;
    callFx(fx, 'burst', k.pos.x, k.pos.y + 0.8, k.pos.z, { color: 0xffd23f, count: 16, speed: 7, life: 0.6 });
    callFx(fx, 'ring', k.pos.x, k.pos.y + 0.3, k.pos.z, { color: 0xffffff, r0: 0.5, r1: 4, life: 0.45 });
  }

  function applyHits(ctx) {
    const karts = ctx && ctx.karts;
    if (!karts) return;
    const fx = ctx.fx;
    for (const e of effects) {
      if (!e.active || (e.kind !== 'shell' && e.kind !== 'banana')) continue;
      for (const k of karts) {
        if (k.id === e.owner) continue;            // own shells/bananas never hit their owner
        if (k.invisible > 0) continue;             // invisible (fake item) karts are intangible
        const r = e.radius + KART.radius + (k.star > 0 ? ITEMS.star.hitRadiusBonus : 0);
        if (dist2(e.pos.x, e.pos.z, k.pos.x, k.pos.z) > r) continue;
        e.active = false; e.life = 0;
        if (k.star > 0) callFx(fx, 'burst', e.pos.x, e.pos.y, e.pos.z, { color: 0xfff176, count: 12, speed: 6, life: 0.4 });
        else hitKart(k, e, ctx);
        break;
      }
    }
  }

  // ------------------------------------------------------------ use
  function useOne(k, base, ctx) {
    const fx = ctx && ctx.fx;
    switch (base) {
      case ITEM.MUSHROOM: {
        const cur = k.boost.time > 0 ? k.boost.mul : 1;
        k.boost.mul = Math.max(cur, KART.boostItemMul);
        k.boost.time = Math.max(k.boost.time, KART.boostItemTime);
        if (k.fx) k.fx.boost = 1;
        callFx(fx, 'ring', k.pos.x, k.pos.y + 0.3, k.pos.z, { color: 0xff8a00, r0: 0.6, r1: 3, life: 0.35 });
        return true;
      }
      case ITEM.GREEN_SHELL:
      case ITEM.RED_SHELL:
        throwShell(k, base, ctx);
        return true;
      case ITEM.BANANA:
        dropBanana(k, fx);
        return true;
      case ITEM.FAKE_ITEM: {   // === ITEM.CLOUD
        k.invisible = ITEMS.cloud.invisTime;
        const st = kartState(k);
        st.cloudT = 0;
        if (st.cloudFx) { st.cloudFx.active = false; st.cloudFx.life = 0; }
        st.cloudFx = makeEffect('cloud', ITEM.CLOUD, k.id, k.pos.x, k.pos.z, k.heading, 0, KART.radius * 1.4, ITEMS.cloud.invisTime);
        callFx(fx, 'burst', k.pos.x, k.pos.y + 1, k.pos.z, { color: 0xd8d8f0, count: 14, speed: 3, life: 0.6 });
        return true;
      }
      case ITEM.LIGHTNING: {
        const karts = (ctx && ctx.karts) || [];
        const big = Math.ceil(karts.length / 2);
        for (const v of karts) {
          if (v.id === k.id || v.star > 0 || v.invisible > 0 || v.finished) continue;
          const gap = (k.place || 1) - (v.place || 1);
          v.shrunk = ITEMS.lightning.shrinkTime + (gap >= big ? LIGHTNING_BIG_BONUS : 0);
          v.speed *= ITEMS.lightning.slowFactor;
          v.vel.x *= ITEMS.lightning.slowFactor; v.vel.z *= ITEMS.lightning.slowFactor;
          v.hitFlash = HIT_FLASH;
          if (v.fx) v.fx.shake = 1;
          makeEffect('zap', ITEM.LIGHTNING, k.id, v.pos.x, v.pos.z, v.heading, 0, KART.radius, ZAP_LIFE);
          callFx(fx, 'burst', v.pos.x, v.pos.y + 2, v.pos.z, { color: 0x8fd3ff, count: 14, speed: 6, life: 0.4, additive: true });
          callFx(fx, 'ring', v.pos.x, v.pos.y + 0.3, v.pos.z, { color: 0x8fd3ff, r0: 0.5, r1: 4, life: 0.4 });
        }
        return true;
      }
      case ITEM.GLOVE: {                       // Re-Volt's Whoppa (2026-11-09): a punch, not a projectile
        const karts = (ctx && ctx.karts) || [];
        const fx2 = k.pos.x + Math.sin(k.heading) * 3, fz2 = k.pos.z + Math.cos(k.heading) * 3;
        let victim = null, best = ITEMS.glove.range;
        for (const v of karts) {
          if (v.id === k.id || v.star > 0 || v.finished) continue;
          const d2 = (v.pos.x - k.pos.x) ** 2 + (v.pos.z - k.pos.z) ** 2;
          if (d2 > best * best) continue;
          const ahead = (v.pos.x - k.pos.x) * Math.sin(k.heading) + (v.pos.z - k.pos.z) * Math.cos(k.heading);
          if (ahead < Math.sqrt(d2) * 0.5) continue;   // must be roughly in front (±60°)
          victim = v; best = Math.sqrt(d2);
        }
        if (victim) {
          victim.spin = Math.max(victim.spin || 0, ITEMS.glove.spin);
          victim.speed *= ITEMS.glove.slow;
          callFx(fx, 'ring', victim.pos.x, victim.pos.y + 0.4, victim.pos.z, { color: 0xffffff, r0: 0.5, r1: 4.5, life: 0.45 });
          callFx(fx, 'burst', victim.pos.x, victim.pos.y + 0.9, victim.pos.z, { color: 0xff5050, count: 16, speed: 5, life: 0.5 });
        } else {
          callFx(fx, 'burst', fx2, k.pos.y + 0.9, fz2, { color: 0xffffff, count: 10, speed: 3, life: 0.35 });   // whiffed air
        }
        return true;
      }
      case ITEM.MAGNET: {                       // Re-Volt's magnet (2026-11-09)
        k.magnetT = ITEMS.magnet.time;
        makeEffect('magnet', ITEM.MAGNET, k.id, k.pos.x, k.pos.z, k.heading, 0, 1.1, ITEMS.magnet.time);
        return true;
      }
      case ITEM.STAR: {
        k.star = ITEMS.star.time;
        k.spin = 0;
        k.shrunk = 0;
        const st = kartState(k);
        st.starT = 0;
        if (st.starFx) { st.starFx.active = false; st.starFx.life = 0; }
        st.starFx = makeEffect('starburst', ITEM.STAR, k.id, k.pos.x, k.pos.z, k.heading, 0, KART.radius * 1.6, ITEMS.star.time);
        callFx(fx, 'ring', k.pos.x, k.pos.y + 0.5, k.pos.z, { color: 0xffe14d, r0: 0.8, r1: 5, life: 0.5 });
        return true;
      }
      default:
        return false;
    }
  }

  function use(k, ctx) {
    if (!k || !k.item) return false;
    const st = kartState(k);
    if (clock - st.lastUse < ITEMS.itemGap) return false;
    const held = k.item;
    const base = ITEM_TRIPLE[held] !== undefined ? ITEM_TRIPLE[held] : held;
    if (!useOne(k, base, ctx)) return false;
    st.lastUse = clock;
    if (ITEM_COUNT[held]) {
      k.count = Math.max(0, (k.count | 0) - 1);
      if (k.count <= 0) { k.item = ITEM.NONE; k.count = 0; }
    } else {
      k.item = ITEM.NONE; k.count = 0;
    }
    return true;
  }

    // ------------------------------------------------------------ collect
  function baseOf(id) { return ITEM_TRIPLE[id] !== undefined ? ITEM_TRIPLE[id] : id; }

  function collect(k, ctx) {
    if (!k || k.finished) return 0;
    // one pickup per pickGap per kart: passing a dense cluster must not silently consume
    // every box in it while replacing the draw you just made (player report, 2026-11-08)
    if (clock - kartState(k).lastPick < ITEMS.pickGap) return 0;
    for (const b of boxes) {
      if (!b.active) continue;
      // dist2 is SQUARED distance; boxRadius is linear. Comparing them directly capped the
      // real pickup radius at sqrt(1.9)=1.38m while the crate is 1.5m wide — edge passes of a
      // box silently collected nothing (the player's "I held nothing and still couldn't pick
      // anything up" report). Compare like with like.
      if (dist2(b.x, b.z, k.pos.x, k.pos.z) > ITEMS.boxRadius * ITEMS.boxRadius) continue;

      // What is in hand gets USED first: a second box while holding anything used to draw a
      // new item over the old one ("I held a powerup and got another without using it",
      // 2026-11-09). The box stays untouched for the next pass. lastPick is set here too so
      // driving through a box while blocked cannot spam the refusal.
      if (k.item && k.item !== ITEM.NONE) {
        kartState(k).lastPick = clock;
        if (typeof ctx?.onBlocked === 'function') ctx.onBlocked(k, b, 'busy');
        return 0;
      }

      const r = (ctx && ctx.rng) || rng;
      const id = rngWeighted(r, tableForPlace(k.place || 1, fieldSize(ctx)));
      b.active = false;
      b.respawnAt = clock + ITEMS.boxRespawn;
      kartState(k).lastPick = clock;
      k.item = id;
      k.count = ITEM_COUNT[id] || 1;
      callFx(ctx && ctx.fx, 'burst', b.x, b.y, b.z, { color: 0x6fd3ff, count: 14, speed: 5, life: 0.5 });
      return k.item;
    }
    return 0;
  }

  // ------------------------------------------------------------ update
  function update(dt, ctx) {
    clock += dt;
    for (const b of boxes) if (!b.active && clock >= b.respawnAt) b.active = true;

    const karts = (ctx && ctx.karts) || [];
    const fx = ctx && ctx.fx;
    for (const k of karts) {
      const st = perKart.get(k.id);
      if (!st) continue;
      if (k.invisible > 0) {
        st.cloudT += dt;
        if (st.cloudT >= CLOUD_DROP_EVERY) { st.cloudT -= CLOUD_DROP_EVERY; dropBanana(k, fx); }
      } else st.cloudT = 0;
      if (k.star > 0) {
        st.starT += dt;
        if (st.starT >= STAR_DROP_EVERY) { st.starT -= STAR_DROP_EVERY; dropBanana(k, fx); }
      } else st.starT = 0;
      // attached visuals follow their kart and die with the effect
      for (const key of ['cloudFx', 'starFx']) {
        const e = st[key];
        if (!e) continue;
        const on = key === 'cloudFx' ? k.invisible > 0 : k.star > 0;
        if (!on || !e.active) { e.active = false; e.life = 0; st[key] = null; continue; }
        e.pos.x = k.pos.x; e.pos.z = k.pos.z; e.pos.y = k.pos.y + 1.0; e.heading = k.heading; e.spin += dt * 3;
      }
    }

    for (const e of effects) {
      if (!e.active) continue;
      if (e.kind === 'shell') stepShell(e, dt, ctx);
      else if (e.kind === 'banana') e.spin += dt * 0.5;
      e.life -= dt;
      if (e.life <= 0) { e.life = 0; e.active = false; }
    }

    applyHits(ctx);

    let w = 0;   // compact in place: `items.effects` keeps its identity
    for (let i = 0; i < effects.length; i++) if (effects[i].active) effects[w++] = effects[i];
    effects.length = w;
  }

  function reset() {
    effects.length = 0;
    perKart.clear();
    clock = 0;
    buildBoxes();
  }

  buildBoxes();

  return { boxes, effects, reset, update, collect, use, applyHits, clock: () => clock };
}
