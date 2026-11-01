// foundation.js — shared math, RNG, and polyline utilities. PURE: no DOM, no THREE.
// Every other module imports from here so there is one identical truth.

// ---------- RNG (deterministic) ----------
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rngRange(rng, a, b) { return a + (b - a) * rng(); }
export function rngPick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
export function rngShuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// weighted pick: table = [{ id, w }, ...] -> id
export function rngWeighted(rng, table) {
  let total = 0; for (const e of table) total += e.w;
  let r = rng() * total;
  for (const e of table) { r -= e.w; if (r <= 0) return e.id; }
  return table[table.length - 1].id;
}

// ---------- scalars ----------
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const smoothstep = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
export const angleDiff = (from, to) => wrapPi(to - from);
export function approach(v, target, step) {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
}

// ---------- 2D vectors in the XZ plane (Y is up) ----------
// heading convention: forward = { x: cos(heading), z: sin(heading) }
export function forward2(heading) { return { x: Math.cos(heading), z: Math.sin(heading) }; }
export function headingOf(v) { return Math.atan2(v.z, v.x); }
export const len2 = (v) => Math.hypot(v.x, v.z);
export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export function norm2(v) { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; }
// side offset: perpendicular to tangent, +side = left of travel direction
export const leftOf = (t) => ({ x: t.z, z: -t.x });

// ---------- curves ----------
// Catmull-Rom (uniform, centripetal-ish) for one segment p1->p2 guided by p0,p3
export function catmullRom2(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  const z = 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
  return { x, z };
}

// Control points -> dense centerline resampled at ~`spacing` metres, closed loop.
// Returns { pts:[{x,z}], tangents:[{x,z}], normals:[{x,z}], segLen:[], cumLen:[], total }
export function buildPolyline(ctrl, spacing = 2.5) {
  const n = ctrl.length;
  // raw oversampling
  const raw = [];
  const per = Math.max(8, Math.ceil(60 / spacing));
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let s = 0; s < per; s++) raw.push(catmullRom2(p0, p1, p2, p3, s / per));
  }
  // arc-length resample
  let total = 0;
  const cum = [0];
  for (let i = 1; i <= raw.length; i++) {
    const a = raw[i - 1], b = raw[i % raw.length];
    total += Math.hypot(b.x - a.x, b.z - a.z);
    cum.push(total);
  }
  const pts = [];
  let k = 0;
  for (let d = 0; d < total - 1e-6; d += spacing) {
    while (k < cum.length - 2 && cum[k + 1] < d) k++;
    const seg = cum[k + 1] - cum[k] || 1;
    const t = (d - cum[k]) / seg;
    const a = raw[k % raw.length], b = raw[(k + 1) % raw.length];
    pts.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });
  }
  const count = pts.length;
  const tangents = [], normals = [], segLen = [];
  for (let i = 0; i < count; i++) {
    const a = pts[i], b = pts[(i + 1) % count];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    tangents.push({ x: dx / l, z: dz / l });
    normals.push({ x: dz / l, z: -dx / l }); // left of travel
    segLen.push(l);
  }
  return { pts, tangents, normals, segLen, total, count };
}

// Nearest point on a closed polyline. `hint` (a point index) makes it cheap: only a
// window around the hint is searched, with a full-scan fallback that upgrades the hint.
// Returns { idx, dist, t (along seg 0..1), tx, tz, nx, nz, side (signed lateral offset,+ = left) }
export function nearestOnPolyline(pl, x, z, hint = -1, window = 60) {
  let best = -1, bestD = Infinity;
  if (hint >= 0 && hint < pl.count) {
    for (let o = -window; o <= window; o++) {
      const i = (hint + o + pl.count) % pl.count;
      const d = (pl.pts[i].x - x) ** 2 + (pl.pts[i].z - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  if (hint < 0 || bestD > (window * 8) ** 2) {
    best = -1; bestD = Infinity;
    for (let i = 0; i < pl.count; i++) {
      const d = (pl.pts[i].x - x) ** 2 + (pl.pts[i].z - z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  const i = best, p = pl.pts[i], tvec = pl.tangents[i];
  const relx = x - p.x, relz = z - p.z;
  const along = relx * tvec.x + relz * tvec.z;
  const side = relx * pl.normals[i].x + relz * pl.normals[i].z; // + = left of travel
  return {
    idx: i,
    dist: Math.sqrt(bestD),
    t: clamp(along / (pl.segLen[i] || 1), 0, 1),
    tx: tvec.x, tz: tvec.z, nx: pl.normals[i].x, nz: pl.normals[i].z,
    side,
  };
}

// position + frame at an index along the polyline
export function frameAt(pl, idx) {
  const i = ((idx % pl.count) + pl.count) % pl.count;
  return { x: pl.pts[i].x, z: pl.pts[i].z, tx: pl.tangents[i].x, tz: pl.tangents[i].z, nx: pl.normals[i].x, nz: pl.normals[i].z };
}
// advance n indices along a closed polyline
export const advanceIdx = (pl, idx, n) => (((idx + n) % pl.count) + pl.count) % pl.count;
// signed index delta a->b following the loop direction
export function idxDelta(pl, from, to) {
  let d = to - from;
  if (d > pl.count / 2) d -= pl.count;
  if (d < -pl.count / 2) d += pl.count;
  return d;
}
// arc-length distance travelled from index a to b in the racing direction
export function arcBetween(pl, a, b) {
  const d = idxDelta(pl, a, b);
  let s = 0;
  for (let i = 0; i < Math.abs(d); i++) s += pl.segLen[(a + (d > 0 ? i : d + i) + pl.count * 2) % pl.count];
  return d >= 0 ? s : -s;
}

// ---------- misc ----------
export function kmh(speedMs) { return speedMs * 3.6; }
export function formatTime(sec) {
  if (!isFinite(sec)) return '--:--.-';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), d = Math.floor((sec * 10) % 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}
export function formatGap(sec) {
  if (!isFinite(sec)) return '---';
  return `+${sec.toFixed(2)}`;
}
