// net.js — wire format + client-side interpolation for host-authoritative multiplayer.
// Pure (no DOM/WebRTC/Peer): the transport lives in main.js; everything here runs under node --test.
//
// Model: the host runs the real simulation. Guests send inputs; the host broadcasts state
// snapshots at ~SNAP_HZ. Guests never simulate the race: they BUFFER two snapshots and render
// the karts ~INTERP_DELAY ms in the past (smooth on any connection), while their OWN kart also
// runs local prediction between corrections (feels immediate, snaps soft to the host's truth).

export const INTERP_DELAY = 0.12;   // s of snapshot buffer rendered in the past

const Q1 = (v, s) => Math.round(v / s);
const P2 = (v, s) => +(v || 0).toFixed(2);

export function packSnap(race, karts, items) {
  return {
    t: 's',
    c: P2(race.clock), p: race.phase, cd: P2(race.countdown || 0),
    k: karts.map((k) => ({
      i: k.id,
      x: Q1(k.pos.x, 0.01), y: Q1(k.pos.y, 0.01), z: Q1(k.pos.z, 0.01),   // cm integers: 327 m range
      h: Q1(k.heading, 0.001), s: Q1(k.speed, 0.01), vx: Q1(k.vel.x, 0.01), vz: Q1(k.vel.z, 0.01),
      lap: k.lap, fin: k.finished ? 1 : 0, ft: P2(k.finishTime),
      it: k.item, ct: k.count,
      bt: P2(k.boost.time), bm: P2(k.boost.mul),
      sp: P2(k.spin), st: P2(k.star), iv: P2(k.invisible), sh: P2(k.shrunk),
      ln: P2(k.lean), dt: k.drift.on ? 1 : 0, dr: k.drift.tier,
      pi: k.plIdx | 0,
    })),
    e: items ? items.effects.filter((e) => e.active !== false).slice(0, 24).map((e) => ({
      k: e.kind, m: e.item || 0, o: e.owner || 0,
      x: Q1(e.pos.x, 0.01), y: Q1(e.pos.y, 0.01), z: Q1(e.pos.z, 0.01),
      h: Q1(e.heading || 0, 0.001), r: Q1(e.radius || 0, 0.01), l: P2(e.life || 0),
      hm: e.homing ? 1 : 0, ht: e.homing ? (e.homing.t | 0) : 0, hi: e.homing ? e.homing.i : 0,
    })) : [],
  };
}

export function unpackKart(k) {
  return {
    i: k.i,
    x: k.x * 0.01, y: k.y * 0.01, z: k.z * 0.01,
    h: k.h * 0.001, s: k.s * 0.01, vx: k.vx * 0.01, vz: k.vz * 0.01,
    lap: k.lap, fin: k.fin, ft: k.ft, it: k.it, ct: k.ct,
    bt: k.bt, bm: k.bm, sp: k.sp, st: k.st, iv: k.iv, sh: k.sh,
    ln: k.ln, dt: k.dt, dr: k.dr, pi: k.pi,
  };
}

// lerp helpers with wraparound for angles
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const lerp = (a, b, t) => a + (b - a) * t;
const lerpA = (a, b, t) => a + wrapPi(b - a) * t;

// blend two unpacked kart rows (same order/ids guaranteed by the host)
export function blendKart(A, B, t) {
  const o = {};
  for (const key of Object.keys(A)) {
    if (key === 'i') { o.i = A.i; continue; }
    if (key === 'h') { o.h = lerpA(A.h, B.h, t); continue; }
    if (key === 'fin' || key === 'lap' || key === 'it' || key === 'ct' || key === 'dt' || key === 'dr' || key === 'pi') { o[key] = t < 0.5 ? A[key] : B[key]; continue; }
    o[key] = lerp(A[key], B[key], t);
  }
  return o;
}

// A guest's snapshot buffer. feed() attaches the local clock; at() returns the interpolated
// snapshot to render (always INTERP_DELAY ms behind wall-time), or the latest when still bootstrapping.
export function createReceiver() {
  let prev = null, next = null, tPrev = 0, tNext = 0;
  return {
    feed(snap, now) {
      const u = { snap, ks: snap.k.map(unpackKart), t: now };
      if (!prev || u.t >= tNext) { prev = next || u; tPrev = next ? tNext : u.t; next = u; tNext = u.t; }
    },
    at(now) {
      if (!next) return null;
      const target = now - INTERP_DELAY;
      if (!prev || target <= tPrev) return { ...next, raw: next.snap, at: tNext };
      const t = Math.min(1, (target - tPrev) / Math.max(1e-3, tNext - tPrev));
      return { ...next, ks: next.ks.map((kb, i) => blendKart(prev.ks[i], kb, t)), raw: next.snap, at: tNext };
    },
    empty() { return !next; },
  };
}

// client -> host input, quantized hard (60 Hz, a few bytes)
const q100 = (v) => Math.max(-100, Math.min(100, Math.round((v || 0) * 100)));
export function packInput(k) {
  return { t: 'i', i: k.id, th: q100(k.input.throttle), st: q100(k.input.steer), d: k.input.drift ? 1 : 0, u: k.input.use ? 1 : 0 };
}
export function applyInput(k, m) {
  k.input.throttle = m.th / 100; k.input.steer = m.st / 100; k.input.drift = !!m.d; k.input.use = !!m.u;
}

// Apply one snapshot to the guest's mirror-world (karts + race shim built by main.buildWorld).
// Own kart is corrected softly (blend); every other kart hard — the receiver already interpolated it.
export function applySnap(karts, race, snapR, ownId, blendOwn = 0.3) {
  race.clock = snapR.raw.c; race.phase = snapR.raw.p; race.countdown = snapR.raw.cd;
  for (const u of snapR.ks) {
    const k = karts[u.i];
    if (!k) continue;
    if (u.i === ownId) {
      // soft correction: local prediction ran forward; nudge toward the host's truth
      k.pos.x += (u.x - k.pos.x) * blendOwn; k.pos.y += (u.y - k.pos.y) * blendOwn; k.pos.z += (u.z - k.pos.z) * blendOwn;
      k.heading += wrapPi(u.h - k.heading) * blendOwn;
      k.speed = u.s; k.vel.x = u.vx; k.vel.z = u.vz;
    } else {
      k.pos.x = u.x; k.pos.y = u.y; k.pos.z = u.z; k.heading = u.h;
      k.speed = u.s; k.vel.x = u.vx; k.vel.z = u.vz;
    }
    k.lap = u.lap; k.finished = !!u.fin; k.finishTime = u.ft;
    k.item = u.it; k.count = u.ct;
    k.boost.time = u.bt; k.boost.mul = u.bm;
    k.spin = u.sp; k.star = u.st; k.invisible = u.iv; k.shrunk = u.sh;
    k.lean = u.ln; k.drift.on = !!u.dt; k.drift.tier = u.dr; k.plIdx = u.pi;
  }
}
