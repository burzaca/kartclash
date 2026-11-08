// track.js — pure track model: centreline, width profile, elevation, queries, scenery data.
// PURE: no DOM, no THREE. Everything is derived deterministically from one TRACKS entry.
//
// Coordinate model ("ribbon coordinates")
// ---------------------------------------
// The road is the band swept by  P(s, side) = C(s) + side * M(s)
//   C(s)  = centreline (pl.pts, linear between vertices)
//   M(s)  = frame normal: a SMOOTHED left-normal (pl.normals averaged over a window that is
//           chosen at build time so the band never folds, even through the hairpins whose
//           centreline radius is smaller than the half-width), lerped between vertices.
// sample() inverts that map exactly per segment (bilinear -> quadratic), so a point produced by
// the renderer as  pts[i] + u * M[i]  maps back to  s = cum[i], side = u.  The renderer builds
// the ribbon, kerbs and barriers from the same frames (exported below as frameX/frameZ), which
// is what keeps road mesh and surfaceY() in agreement.
//
// Elevation
// ---------
// y(s) = smooth waves over a *corner-warped* lap fraction (tight corners advance the wave slowly,
// so hairpins are nearly level and their overlapping inside never shows a step). Off the road the
// terrain lerps (over a 0.8..5 m shoulder) to a compact-support weighted blend of the centreline
// heights, which is continuous everywhere and flattens to 0 far from the circuit.
// surfaceY(x, z) is ONE deterministic function of (x, z): sample(x, z, anyHint).y === surfaceY(x, z).

import { buildPolyline, nearestOnPolyline, frameAt, advanceIdx, mulberry32, clamp, smoothstep, wrapPi, idxDelta } from '../foundation.js';
import { KART, RACE } from '../config.js';

const TAU = Math.PI * 2;
const SPACING = 2.5;              // centreline resample spacing (contract: buildPolyline(def.ctrl, 2.5))
const HINT_WINDOW = 40;           // +-vertices searched around a hint
const CAND_SPAN = 16;             // +-segments tried around the nearest vertex when inverting the ribbon map
const PAD_LEN = 9;                // boost pad length along the track, m
const SHOULDER_IN = 0.8, SHOULDER_OUT = 5.0;   // e (m beyond road edge) where height blends to terrain
const BLEND_R = 45, BLEND_R2 = BLEND_R * BLEND_R;
const BLEND_FADE0 = 12, BLEND_FADE_LEN = 30;   // terrain eases back to y=0 between 12 and 42 m out
const BOUNDS_MARGIN = 30;
const START_CLEAR = 60;           // no scenery (except stands) within this radius of the start line
const SHOULDER = 4;               // decor must sit beyond half + SHOULDER
const SLOPE_H = 0.5;              // finite-difference step for slopes
const AG_RAMP = 30;               // m over which an anti-gravity bank fades in/out at each range end

function smoothCyclic(src, r) {
  const n = src.length, out = new Float64Array(n);
  let acc = 0;
  for (let k = -r; k <= r; k++) acc += src[((k % n) + n) % n];
  const inv = 1 / (2 * r + 1);
  for (let i = 0; i < n; i++) {
    out[i] = acc * inv;
    acc += src[(i + r + 1) % n] - src[((i - r) % n + n) % n];
  }
  return out;
}

function varyColor(hex, rng, amount = 0.14, warm = 0.0) {
  let r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const f = 1 + (rng() * 2 - 1) * amount;
  const w = (rng() * 2 - 1) * warm;
  r = clamp(Math.round(r * f + w * 40), 0, 255);
  g = clamp(Math.round(g * f + w * 18), 0, 255);
  b = clamp(Math.round(b * f - w * 25), 0, 255);
  return (r << 16) | (g << 8) | b;
}

export function buildTrack(def) {
  const pl = buildPolyline(def.ctrl, SPACING);
  const n = pl.count, total = pl.total;
  const rng = mulberry32(def.seed >>> 0);

  // ---------------------------------------------------------------- flat arrays
  const PX = new Float64Array(n), PZ = new Float64Array(n);
  const TX = new Float64Array(n), TZ = new Float64Array(n);
  const SEG = new Float64Array(n), cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    PX[i] = pl.pts[i].x; PZ[i] = pl.pts[i].z;
    TX[i] = pl.tangents[i].x; TZ[i] = pl.tangents[i].z;
    SEG[i] = pl.segLen[i]; cum[i + 1] = cum[i] + SEG[i];
  }
  const loop = cum[n];   // length of the resampled loop (== total within a few cm)

  // ---------------------------------------------------------------- curvature (signed, + = right turn)
  const rawK = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ip = (i - 1 + n) % n;
    const a = Math.atan2(TZ[ip], TX[ip]), b = Math.atan2(TZ[i], TX[i]);
    rawK[i] = wrapPi(b - a) / (0.5 * (SEG[ip] + SEG[i]));
  }
  const curv = smoothCyclic(smoothCyclic(rawK, 5), 5);
  const corner = new Float64Array(n);
  for (let i = 0; i < n; i++) corner[i] = clamp(Math.abs(curv[i]) * 22, 0, 1);   // 1 at radius <= 22 m
  const cornerS = smoothCyclic(corner, 6);

  // ---------------------------------------------------------------- width profile (within widthVar)
  const a1 = rng() * TAU, a2 = rng() * TAU;
  const vRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = cum[i] / loop;
    const wave = 0.55 * Math.sin(TAU * 2 * f + a1) + 0.45 * Math.sin(TAU * 3 * f + a2);
    vRaw[i] = clamp(0.5 * wave + 0.8 * cornerS[i] - 0.25, -1, 1);   // corners run wider (MK style)
  }
  const vS = smoothCyclic(smoothCyclic(vRaw, 8), 8);
  const HALF = new Float64Array(n);
  let halfMax = 0, halfMin = Infinity;
  for (let i = 0; i < n; i++) {
    HALF[i] = def.width * 0.5 * (1 + (def.widthVar || 0) * vS[i]);
    if (HALF[i] > halfMax) halfMax = HALF[i];
    if (HALF[i] < halfMin) halfMin = HALF[i];
  }

  // ---------------------------------------------------------------- fold-free frame normals
  const bandLimit = halfMax + SHOULDER_OUT + 1.5;   // the (s, side) map must be 1:1 out to here
  const MX = new Float64Array(n), MZ = new Float64Array(n);
  let frameK = 0;
  for (let K = 2; K <= 40; K++) {
    for (let i = 0; i < n; i++) {
      let sx = 0, sz = 0;
      for (let k = -K; k <= K; k++) {
        const j = (i + k + n) % n, w = K + 1 - Math.abs(k);
        sx += w * pl.normals[j].x; sz += w * pl.normals[j].z;
      }
      const l = Math.hypot(sx, sz) || 1;
      MX[i] = sx / l; MZ[i] = sz / l;
    }
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const i1 = (i + 1) % n;
      for (const sd of [-bandLimit, bandLimit]) {
        const ex = PX[i1] + sd * MX[i1] - (PX[i] + sd * MX[i]);
        const ez = PZ[i1] + sd * MZ[i1] - (PZ[i] + sd * MZ[i]);
        if (ex * TX[i] + ez * TZ[i] < 0.2 * SEG[i]) { ok = false; break; }
      }
    }
    frameK = K;
    if (ok) break;
  }

  // ---------------------------------------------------------------- elevation (corner-warped)
  const el = def.elev || { amp: 0, waves: 1, phase: 0 };
  const amp = el.amp || 0, waves = Math.max(1, Math.round(el.waves || 1)), phase = el.phase || 0;
  const U = new Float64Array(n + 1);          // warped lap fraction at vertices, U[n] = 1
  {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = SEG[i] / (1 + 20 * cornerS[i] * cornerS[i]);
    for (let i = 0; i < n; i++) U[i + 1] = U[i] + w[i];
    const inv = 1 / U[n];
    for (let i = 0; i <= n; i++) U[i] *= inv;
  }
  const elevU = (u) => amp * (0.8 * Math.sin(TAU * waves * u + phase) + 0.2 * Math.sin(TAU * (2 * waves + 1) * u + phase * 1.7));
  const EV = new Float64Array(n);
  for (let i = 0; i < n; i++) EV[i] = elevU(U[i]);
  const elevAt = (j, t) => elevU(U[j] + t * (U[j + 1] - U[j]));

  // normalised weighted average of nearby centreline heights, faded to 0 by the distance to the
  // nearest vertex (a gentle 30 m ramp) — continuous everywhere, no rim at the support edge.
  function terrainBlend(x, z) {
    let sw = 0, sy = 0, dmin2 = Infinity;
    for (let k = 0; k < n; k++) {
      const dx = PX[k] - x, dz = PZ[k] - z, d2 = dx * dx + dz * dz;
      if (d2 < dmin2) dmin2 = d2;
      if (d2 < BLEND_R2) { const q = 1 - d2 / BLEND_R2, w = q * q; sw += w; sy += w * EV[k]; }
    }
    if (sw <= 0) return 0;
    const fade = 1 - smoothstep((Math.sqrt(dmin2) - BLEND_FADE0) / BLEND_FADE_LEN);
    return fade > 0 ? (sy / sw) * fade : 0;
  }

  // ---------------------------------------------------------------- hint safety radius
  // G = min distance between vertices more than HINT_WINDOW/2 apart along the loop. If the
  // windowed nearest vertex v is within HINT_WINDOW/2 of the hint and closer than G/2, no vertex
  // outside the window can be closer -> the windowed answer IS the global answer (hint-independent).
  let G = Infinity;
  for (let i = 0; i < n; i++) {
    for (let k = i + 1; k < n; k++) {
      const sep = Math.min(k - i, n - (k - i));
      if (sep <= HINT_WINDOW / 2) continue;
      const d = Math.hypot(PX[i] - PX[k], PZ[i] - PZ[k]);
      if (d < G) G = d;
    }
  }
  const safeR = G / 2;

  // ---------------------------------------------------------------- ribbon-map inversion
  const L = { i: 0, j: 0, t: 0, s: 0, side: 0, dist: 0, half: 0, mx: 1, mz: 0, valid: false };
  let qT = 0, qSide = 0;
  function solveSeg(j, x, z) {
    const j1 = j + 1 === n ? 0 : j + 1;
    const Dx = PX[j1] - PX[j], Dz = PZ[j1] - PZ[j];
    const Qx = x - PX[j], Qz = z - PZ[j];
    const M0x = MX[j], M0z = MZ[j], dMx = MX[j1] - M0x, dMz = MZ[j1] - M0z;
    const a = Dx * dMz - Dz * dMx;
    const b = (Dx * M0z - Dz * M0x) - (Qx * dMz - Qz * dMx);
    const c = -(Qx * M0z - Qz * M0x);
    let t;
    if (Math.abs(a) < 1e-12) t = Math.abs(b) < 1e-12 ? 0 : -c / b;
    else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      const q = -0.5 * (b + (b >= 0 ? sq : -sq));
      const r1 = q / a, r2 = Math.abs(q) > 1e-15 ? c / q : r1;
      const d1 = r1 < 0 ? -r1 : r1 > 1 ? r1 - 1 : 0, d2 = r2 < 0 ? -r2 : r2 > 1 ? r2 - 1 : 0;
      t = d1 <= d2 ? r1 : r2;
    }
    if (t < -1e-9 || t > 1 + 1e-9) return false;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const Mx = M0x + t * dMx, Mz = M0z + t * dMz, m2 = Mx * Mx + Mz * Mz;
    qT = t;
    qSide = ((Qx - t * Dx) * Mx + (Qz - t * Dz) * Mz) / (m2 || 1);
    return true;
  }

  // locate(x, z, hint): fills L. Result does not depend on the hint (see safeR proof above).
  let lastHint = 0;
  function locate(x, z, hint) {
    let r = null;
    const h = hint >= 0 && hint < n ? Math.round(hint) % n : -1;
    if (h >= 0) {
      r = nearestOnPolyline(pl, x, z, h, HINT_WINDOW);
      if (Math.abs(idxDelta(pl, h, r.idx)) > HINT_WINDOW / 2 || r.dist >= safeR) r = null;
    }
    if (!r) r = nearestOnPolyline(pl, x, z, -1);
    const i = r.idx;
    let bestSide = Infinity, bj = -1, bt = 0;
    for (let o = 0; o <= 2 * CAND_SPAN; o++) {
      const off = (o & 1) ? (o >> 1) : -((o >> 1) + 1);   // segments i-1, i, i-2, i+1, i-3, i+2 ...
      const j = (i + off + n * 4) % n;
      if (!solveSeg(j, x, z)) continue;
      const as = qSide < 0 ? -qSide : qSide;
      if (as <= bandLimit && as < bestSide) { bestSide = as; bj = j; bt = qT; L.side = qSide; }
    }
    L.i = i;
    if (bj >= 0) {
      const j1 = bj + 1 === n ? 0 : bj + 1;
      L.valid = true; L.j = bj; L.t = bt;
      L.s = cum[bj] + bt * SEG[bj];
      L.half = HALF[bj] + bt * (HALF[j1] - HALF[bj]);
      let mx = MX[bj] + bt * (MX[j1] - MX[bj]), mz = MZ[bj] + bt * (MZ[j1] - MZ[bj]);
      const ml = Math.hypot(mx, mz) || 1; L.mx = mx / ml; L.mz = mz / ml;
      const cx = PX[bj] + bt * (PX[j1] - PX[bj]), cz = PZ[bj] + bt * (PZ[j1] - PZ[bj]);
      L.dist = Math.hypot(x - cx, z - cz);
    } else {
      // far outside the band (or beyond a hairpin's centre): nearest vertex, true distance
      L.valid = false; L.j = i; L.t = 0; L.s = cum[i]; L.half = HALF[i];
      L.mx = MX[i]; L.mz = MZ[i];
      const dx = x - PX[i], dz = z - PZ[i];
      L.dist = Math.hypot(dx, dz);
      L.side = (dx * MX[i] + dz * MZ[i] >= 0 ? 1 : -1) * L.dist;
    }
    lastHint = i;
    return L;
  }

  // height for an already-located point (L must be fresh)
  function heightFromL(x, z) {
    const as = L.side < 0 ? -L.side : L.side, e = as - L.half;
    let base = L.valid ? elevAt(L.j, L.t) : EV[L.i];
    if (L.valid) {   // anti-gravity half-pipe: amp * clamp(|side|/half)^2, amp ramped along the range
      const j1 = L.j + 1 === n ? 0 : L.j + 1, a = AGA[L.j] + L.t * (AGA[j1] - AGA[L.j]);
      if (a > 0) { const u = as < L.half ? as / L.half : 1; base += a * u * u; }
    }
    if (e <= SHOULDER_IN && L.valid) return base;
    const k = L.valid ? smoothstep((e - SHOULDER_IN) / (SHOULDER_OUT - SHOULDER_IN)) : 1;
    if (k >= 1) return terrainBlend(x, z);
    return base + (terrainBlend(x, z) - base) * k;
  }

  function surfaceY(x, z) { locate(x, z, lastHint); return heightFromL(x, z); }

  const halfWidth = (idx) => HALF[((Math.round(idx) % n) + n) % n];

  // ---------------------------------------------------------------- arc helpers
  const wrapS = (s) => ((s % loop) + loop) % loop;
  function segOfS(s) {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid - 1; }
    return lo;
  }
  // world point at arc length s (from vertex 0) and lateral offset `side` (ribbon coordinates)
  function pointAt(s, side = 0) {
    s = wrapS(s);
    const j = segOfS(s), j1 = (j + 1) % n;
    const t = clamp((s - cum[j]) / (SEG[j] || 1), 0, 1);
    let mx = MX[j] + t * (MX[j1] - MX[j]), mz = MZ[j] + t * (MZ[j1] - MZ[j]);
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const cx = PX[j] + t * (PX[j1] - PX[j]), cz = PZ[j] + t * (PZ[j1] - PZ[j]);
    return { x: cx + side * mx, z: cz + side * mz, tx: TX[j], tz: TZ[j], nx: mx, nz: mz,
      idx: t > 0.5 ? j1 : j, s, half: HALF[j] + t * (HALF[j1] - HALF[j]) };
  }

  // ---------------------------------------------------------------- start line
  let startIdx = 0;
  {
    let best = Infinity;
    const lim = Math.floor(n * 0.12);
    for (let i = 0; i <= lim; i++) {
      let m = 0;
      for (let k = -14; k <= 18; k++) m = Math.max(m, Math.abs(curv[(i + k + n) % n]));
      const score = m + i * 1e-6;
      if (score < best) { best = score; startIdx = i; }
    }
  }
  const startS = cum[startIdx];
  const fracOfS = (s) => { const f = (s - startS) / loop; return f - Math.floor(f); };

  // ---------------------------------------------------------------- features from lap fractions
  const sOfFrac = (f) => wrapS(startS + f * loop);

  // ---------------------------------------------------------------- anti-gravity ranges (§7)
  // AGA[i] = bank amp at vertex i, cosine-ramped over AG_RAMP m at both range ends (0 outside);
  // AGIN[i] = 1 when vertex i lies inside a range. heightFromL reads AGA, so surfaceY carries the bank.
  const AGA = new Float64Array(n), AGIN = new Uint8Array(n);
  const agRanges = (def.ag || []).map(({ t, t2, amp }) => {
    const s0 = sOfFrac(t), len = wrapS(sOfFrac(t2) - s0);
    let i0 = -1, i1 = -1;
    for (let k = 0; k < n; k++) {
      const i = (segOfS(s0) + k) % n, d = wrapS(cum[i] - s0);
      if (d > len) continue;
      const r = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.min(d, len - d) / AG_RAMP));
      AGA[i] = Math.max(AGA[i], amp * r); AGIN[i] = 1;
      if (i0 < 0) i0 = i;
      i1 = i;
    }
    return { i0, i1, amp };
  });
  const wrapI = (idx) => ((Math.round(idx) % n) + n) % n;
  function bankOffset(idx, side) {
    const i = wrapI(idx), u = Math.min(1, Math.abs(side) / HALF[i]);
    return AGA[i] * u * u;
  }

  const checkpoints = [];
  for (let k = 0; k < 8; k++) {
    const idx = advanceIdx(pl, startIdx, Math.round(k * n / 8));
    const f = frameAt(pl, idx);
    checkpoints.push({ idx, x: f.x, z: f.z, tx: f.tx, tz: f.tz });
  }
  const itemNodes = (def.itemNodes || []).map((f) => {
    const p = pointAt(sOfFrac(f), 0);
    return { idx: p.idx, x: p.x, z: p.z };
  });
  const pads = (def.boostPads || []).map((bp) => {
    const s = sOfFrac(bp.t);
    const p = pointAt(s, 0);
    return { idx: p.idx, x: p.x, z: p.z, tx: p.tx, tz: p.tz, halfW: (bp.w || 0.5) * p.half, len: PAD_LEN, s };
  });

  // ---------------------------------------------------------------- queries
  function sample(x, z, hintIdx = -1) {
    locate(x, z, hintIdx);
    const j = L.j, t = L.t, side = L.side, half = L.half, s = L.s, valid = L.valid;
    const nx = L.mx, nz = L.mz, dist = L.dist;
    const idx = valid ? (t > 0.5 ? (j + 1) % n : j) : L.i;
    const y = heightFromL(x, z);
    let pad = false;
    if (valid) {
      for (let k = 0; k < pads.length; k++) {
        const p = pads[k];
        let ds = s - p.s;
        if (ds > loop / 2) ds -= loop; else if (ds < -loop / 2) ds += loop;
        if (ds >= -p.len / 2 && ds <= p.len / 2 && (side < 0 ? -side : side) <= p.halfW) { pad = true; break; }
      }
    }
    const yx1 = surfaceYHint(x + SLOPE_H, z, idx), yx0 = surfaceYHint(x - SLOPE_H, z, idx);
    const yz1 = surfaceYHint(x, z + SLOPE_H, idx), yz0 = surfaceYHint(x, z - SLOPE_H, idx);
    return {
      idx, dist, side, half,
      onRoad: (side < 0 ? -side : side) <= half - KART.radius,
      tx: TX[j], tz: TZ[j], nx, nz, y,
      slopeX: (yx1 - yx0) / (2 * SLOPE_H), slopeZ: (yz1 - yz0) / (2 * SLOPE_H),
      pad, ag: AGIN[idx] === 1,
    };
  }
  function surfaceYHint(x, z, hint) { locate(x, z, hint); return heightFromL(x, z); }

  function progressOf(x, z, hintIdx = -1) {
    locate(x, z, hintIdx);
    const idx = L.valid ? (L.t > 0.5 ? (L.j + 1) % n : L.j) : L.i;
    return { idx, frac: fracOfS(L.s) };
  }

  function gridSlot(i, count = 1) {
    const row = Math.floor(i / 2), col = i % 2;
    const back = 4 + row * RACE.startGridGap + col * RACE.startGridGap * 0.5;
    const lat = (col === 0 ? 1 : -1) * RACE.startLateral;
    const p = pointAt(startS - back, lat);
    return { x: p.x, z: p.z, heading: Math.atan2(p.tz, p.tx), y: surfaceY(p.x, p.z), idx: p.idx };
  }

  // ---------------------------------------------------------------- bounds + minimap
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    for (const sd of [-HALF[i], HALF[i]]) {
      const x = PX[i] + sd * MX[i], z = PZ[i] + sd * MZ[i];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  const bounds = { minX: minX - BOUNDS_MARGIN, maxX: maxX + BOUNDS_MARGIN, minZ: minZ - BOUNDS_MARGIN, maxZ: maxZ + BOUNDS_MARGIN };
  const mm = { xs: [], zs: [], pts: [], minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let k = 0; k < n; k += 4) {
    const i = (startIdx + k) % n;
    mm.xs.push(PX[i]); mm.zs.push(PZ[i]); mm.pts.push({ x: PX[i], z: PZ[i] });
  }
  for (let i = 0; i < n; i++) {
    if (PX[i] < mm.minX) mm.minX = PX[i]; if (PX[i] > mm.maxX) mm.maxX = PX[i];
    if (PZ[i] < mm.minZ) mm.minZ = PZ[i]; if (PZ[i] > mm.maxZ) mm.maxZ = PZ[i];
  }

  const track = {
    def, name: def.name, id: def.id,
    pl, total, startIdx, checkpoints, itemNodes, pads,
    halfWidth, surfaceY, sample, progressOf, gridSlot, agRanges, bankOffset,
    bounds, minimap: mm,
    decor: [],
    // extras (read-only, used by the renderer and handy for AI/tools)
    loop, cum, curv, frameX: MX, frameZ: MZ, pointAt, elevAtIdx: (i) => EV[((i % n) + n) % n],
    meta: { frameK, bandLimit, safeR, halfMin, halfMax, padLen: PAD_LEN },
  };

  track.decor = buildDecor(track, def, rng, { n, PX, PZ, TX, TZ, MX, MZ, HALF, curv, startS, loop });
  return track;
}

// ===================================================================== scenery
// decorItem = { kind, x, y, z, rot, scale, color, variant, dir, len }
//   rot   : yaw for the renderer (object.rotation.y = rot). Props are authored facing local +Z;
//           local +Z maps to world (sin rot, cos rot). "Facing the road" props point +Z at the road.
//   dir   : 'sign' only: +1 = chevrons point right (as seen by the driver), -1 = left
//   len   : 'stand'/'billboard' length along the road, m
function buildDecor(track, def, rng, A) {
  const { n, PX, PZ, TX, TZ, MX, MZ, HALF, curv, startS, loop } = A;
  const theme = def.theme || {};
  const out = [];
  const placed = [];
  const st = track.pointAt(startS, 0);
  const b = track.bounds;
  const area = { minX: b.minX - 50, maxX: b.maxX + 50, minZ: b.minZ - 50, maxZ: b.maxZ + 50 };
  const yaw = (dx, dz) => Math.atan2(dx, dz);

  function clearOf(x, z, r, minE, nearStartOK) {
    if (x < area.minX || x > area.maxX || z < area.minZ || z > area.maxZ) return false;
    if (!nearStartOK && Math.hypot(x - st.x, z - st.z) < START_CLEAR + r) return false;
    const q = track.sample(x, z, -1);
    const need = Math.max(SHOULDER + 0.05 + r, minE);   // footprint edge beyond road + shoulder
    if (Math.abs(q.side) - q.half < need) return false;
    if (q.dist - q.half < need) return false;
    for (let k = 0; k < placed.length; k++) {
      const p = placed[k];
      const dd = p.r + r;
      if (Math.abs(p.x - x) < dd && Math.abs(p.z - z) < dd && Math.hypot(p.x - x, p.z - z) < dd) return false;
    }
    return true;
  }
  function add(kind, x, z, o = {}) {
    const item = {
      kind, x, y: track.surfaceY(x, z), z,
      rot: o.rot ?? 0, scale: o.scale ?? 1, color: o.color ?? 0xffffff,
      variant: o.variant ?? 0, dir: o.dir ?? 0, len: o.len ?? 0,
    };
    out.push(item);
    placed.push({ x, z, r: o.r ?? 1 });
    return item;
  }
  // try to place something at arc s, lateral sign sg, beyond-edge distance e
  function atEdge(s, sg, e) {
    const p = track.pointAt(s, 0);
    const side = sg * (p.half + e);
    const q = track.pointAt(s, side);
    return { x: q.x, z: q.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz, toRoadX: -sg * p.nx, toRoadZ: -sg * p.nz };
  }

  // ---- grandstands at the start (the only scenery allowed near the line)
  {
    const tries = [
      { ds: -4, sg: 1 }, { ds: 26, sg: -1 }, { ds: -4, sg: -1 }, { ds: 26, sg: 1 }, { ds: -30, sg: 1 }, { ds: -30, sg: -1 },
    ];
    let made = 0;
    for (const tr of tries) {
      if (made >= 2) break;
      const len = 26, depth = 9, e = SHOULDER + 1.2 + depth / 2;
      const c = atEdge(startS + tr.ds, tr.sg, e);
      let ok = true;
      for (let k = -2; k <= 2 && ok; k++) {
        const px = c.x + c.tx * k * (len / 4), pz = c.z + c.tz * k * (len / 4);
        if (!clearOf(px, pz, depth / 2, SHOULDER, true)) ok = false;
      }
      if (!ok) continue;
      add('stand', c.x, c.z, { rot: yaw(c.toRoadX, c.toRoadZ), len, r: len / 2, color: 0xffffff, variant: made });
      // reserve the footprint along its length too
      for (const k of [-1, 1]) placed.push({ x: c.x + c.tx * k * len / 3, z: c.z + c.tz * k * len / 3, r: depth / 2 + 1 });
      made++;
    }
  }

  // ---- corners: chevron signs, tyre stacks (outside), cones (inside apex)
  const TH = 1 / 45;
  const corners = [];
  {
    let i0 = 0;
    while (i0 < n && Math.abs(curv[i0]) > TH) i0++;          // start outside a corner
    let i = 0;
    while (i < n) {
      const k = (i0 + i) % n;
      if (Math.abs(curv[k]) > TH) {
        let apex = k, best = Math.abs(curv[k]), len = 0;
        while (i < n && Math.abs(curv[(i0 + i) % n]) > TH) {
          const kk = (i0 + i) % n;
          if (Math.abs(curv[kk]) > best) { best = Math.abs(curv[kk]); apex = kk; }
          i++; len++;
        }
        corners.push({ apex, entry: k, len, dir: Math.sign(curv[apex]), k: best });
      } else i++;
    }
  }
  for (const c of corners) {
    const sApex = track.cum[c.apex], sEntry = track.cum[c.entry];
    const outSg = c.dir;            // right turn (+) -> outside is the left (+side)
    // chevron signs at the corner entry, angled toward incoming traffic
    for (const ds of [-4, 10]) {
      const q = atEdge(sEntry + ds, outSg, 5.4);
      if (!clearOf(q.x, q.z, 1.0, 5, false)) continue;
      const fx = -q.tx * 0.75 + q.toRoadX * 0.65, fz = -q.tz * 0.75 + q.toRoadZ * 0.65;
      add('sign', q.x, q.z, { rot: yaw(fx, fz), dir: c.dir, r: 1.0, color: theme.curb ?? 0xd8232a });
    }
    // tyre stacks along the outside of the apex
    for (let k = -2; k <= 2; k++) {
      const q = atEdge(sApex + k * 7, outSg, 5.0);
      if (!clearOf(q.x, q.z, 0.8, 4.5, false)) continue;
      add('tirestack', q.x, q.z, { rot: rng() * TAU, variant: (k + 2) % 3, scale: 0.9 + rng() * 0.2, r: 0.8,
        color: [0xd8232a, 0xffffff, theme.curb ?? 0x1c86d1][(k + 2) % 3] });
    }
    // cones at the inside apex
    for (let k = 0; k <= 1; k++) {
      const q = atEdge(sApex + (k * 2 - 1) * 3, -outSg, 4.6 + rng() * 0.8);
      if (!clearOf(q.x, q.z, 0.5, 4.5, false)) continue;
      add('cone', q.x, q.z, { rot: rng() * TAU, scale: 0.9 + rng() * 0.25, r: 0.5, color: 0xff7a1a, variant: k & 1 });
    }
    // a rock or two outside the run-off
    if (rng() < 0.7) {
      const q = atEdge(sApex + (rng() * 2 - 1) * 10, outSg, 9 + rng() * 6);
      if (clearOf(q.x, q.z, 1.8, 6, false)) add('rock', q.x, q.z, { rot: rng() * TAU, scale: 1.1 + rng() * 0.9, r: 1.8, color: varyColor(0xb3ada2, rng, 0.12) });
    }
  }

  // ---- lamps and flags along the lap
  for (let s = 0, k = 0; s < loop; s += 42, k++) {
    const sg = (k & 1) ? 1 : -1;
    const q = atEdge(startS + 20 + s, sg, 4.8);
    if (!clearOf(q.x, q.z, 0.6, 4.6, false)) continue;
    add('lamp', q.x, q.z, { rot: yaw(q.toRoadX, q.toRoadZ), r: 0.6, color: 0xdfe3ea });
  }
  const FLAG_COLORS = [0xd8232a, 0xf2c14e, 0x1c86d1, 0x2fae5a, 0xffffff, 0x8e44ad, 0xef7f26];
  for (let s = 0, k = 0; s < loop; s += 58, k++) {
    const sg = (k & 1) ? -1 : 1;
    const q = atEdge(startS + 41 + s, sg, 6 + rng() * 2);
    if (!clearOf(q.x, q.z, 0.8, 5, false)) continue;
    add('flag', q.x, q.z, { rot: yaw(q.tx, q.tz) + (rng() - 0.5) * 0.4, r: 0.8, color: FLAG_COLORS[k % FLAG_COLORS.length], variant: k % 3 });
  }

  // ---- sponsor billboards on the straights
  {
    let lastS = -1e9, made = 0;
    for (let s = 70; s < loop - 40 && made < 6; s += 12) {
      const sa = startS + s;
      const p = track.pointAt(sa, 0);
      let straight = true;
      for (let k = -8; k <= 8; k++) if (Math.abs(curv[(p.idx + k + n) % n]) > 1 / 90) { straight = false; break; }
      if (!straight || s - lastS < 95) continue;
      const sg = made & 1 ? 1 : -1;
      const len = 11, e = 9.5;
      const q = atEdge(sa, sg, e);
      let ok = true;
      for (const k of [-1, 0, 1]) if (!clearOf(q.x + q.tx * k * len * 0.4, q.z + q.tz * k * len * 0.4, 1.6, 6, false)) ok = false;
      if (!ok) { const q2 = atEdge(sa, -sg, e); ok = true;
        for (const k of [-1, 0, 1]) if (!clearOf(q2.x + q2.tx * k * len * 0.4, q2.z + q2.tz * k * len * 0.4, 1.6, 6, false)) ok = false;
        if (!ok) continue; Object.assign(q, q2); }
      const fx = q.toRoadX * 0.9 - q.tx * 0.45, fz = q.toRoadZ * 0.9 - q.tz * 0.45;
      add('billboard', q.x, q.z, { rot: yaw(fx, fz), len, r: len / 2, variant: made % 3, color: 0xffffff });
      lastS = s; made++;
    }
  }

  // ---- bushes hugging the run-off
  for (let k = 0, made = 0; k < 220 && made < 30; k++) {
    const s = rng() * loop, sg = rng() < 0.5 ? -1 : 1;
    const q = atEdge(s, sg, 5.5 + rng() * 9);
    if (!clearOf(q.x, q.z, 1.2, 5, false)) continue;
    add('bush', q.x, q.z, { rot: rng() * TAU, scale: 0.8 + rng() * 0.6, r: 1.2,
      color: varyColor(theme.trees ?? 0x2f7a3a, rng, 0.18, 0.4) });
    made++;
  }

  // ---- trees: clustered woods + scattered singles
  const treeCol = theme.trees ?? 0x2f7a3a;
  {
    let made = 0;
    const clusters = [];
    for (let k = 0; k < 400 && clusters.length < 11; k++) {
      const x = area.minX + rng() * (area.maxX - area.minX), z = area.minZ + rng() * (area.maxZ - area.minZ);
      const q = track.sample(x, z, -1);
      if (Math.abs(q.side) - q.half < 16 || Math.hypot(x - st.x, z - st.z) < START_CLEAR + 15) continue;
      clusters.push({ x, z });
    }
    for (const c of clusters) {
      const want = 5 + Math.floor(rng() * 4);
      for (let k = 0, got = 0; k < 40 && got < want; k++) {
        const a = rng() * TAU, r = Math.sqrt(rng()) * 15;
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        const sc = 0.85 + rng() * 0.6;
        if (!clearOf(x, z, 2.2 * sc, 7, false)) continue;
        add('tree', x, z, { rot: rng() * TAU, scale: sc, r: 2.2 * sc, color: varyColor(treeCol, rng, 0.16, 0.5), variant: rng() < 0.4 ? 1 : 0 });
        got++; made++;
      }
    }
    for (let k = 0; k < 600 && made < 82; k++) {
      const x = area.minX + rng() * (area.maxX - area.minX), z = area.minZ + rng() * (area.maxZ - area.minZ);
      const sc = 0.8 + rng() * 0.7;
      if (!clearOf(x, z, 2.2 * sc, 8, false)) continue;
      add('tree', x, z, { rot: rng() * TAU, scale: sc, r: 2.2 * sc, color: varyColor(treeCol, rng, 0.16, 0.5), variant: rng() < 0.4 ? 1 : 0 });
      made++;
    }
  }

  // ---- scattered rocks
  for (let k = 0, made = 0; k < 300 && made < 16; k++) {
    const x = area.minX + rng() * (area.maxX - area.minX), z = area.minZ + rng() * (area.maxZ - area.minZ);
    const sc = 0.7 + rng() * 1.3;
    if (!clearOf(x, z, 1.5 * sc, 6, false)) continue;
    add('rock', x, z, { rot: rng() * TAU, scale: sc, r: 1.5 * sc, color: varyColor(0xb3ada2, rng, 0.14, 0.2) });
    made++;
  }

  return out;
}
