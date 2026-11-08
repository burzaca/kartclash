// trackMesh.js — the circuit as three.js geometry: road ribbon, markings, boost pads, kerbs,
// barriers with posts, mottled ground, start gantry, grandstands and instanced scenery.
// Receives THREE as a parameter (no import of three here). Zero textures, zero external assets.
//
// Everything is built from the SAME ribbon frames the track queries use (track.frameX/Z,
// track.halfWidth, track.elevAtIdx), so a ribbon vertex at (i, side) has y === track.surfaceY(x, z).

import { mulberry32, clamp, smoothstep, idxDelta } from '../foundation.js';

const TAU = Math.PI * 2;

// ===================================================================== small helpers
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
const fbm2 = (x, z) => 0.6 * vnoise3(x, 0.5, z) + 0.3 * vnoise3(x * 2.3, 7.1, z * 2.3) + 0.1 * vnoise3(x * 5.1, 3.3, z * 5.1);

// Add/replace a vertex colour attribute. fn(x,y,z,nx,ny,nz) -> THREE.Color
function paint(THREE, geo, fn) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const p = geo.attributes.position, nr = geo.attributes.normal, cnt = p.count;
  const col = new Float32Array(cnt * 3);
  const fixed = (fn && fn.isColor) ? fn : null;
  for (let i = 0; i < cnt; i++) {
    const c = fixed || fn(p.getX(i), p.getY(i), p.getZ(i), nr.getX(i), nr.getY(i), nr.getZ(i));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
// Average normals of vertices that share a position (removes UV-seam creases on displaced spheres).
function weldNormals(geo) {
  const p = geo.attributes.position, nr = geo.attributes.normal, map = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
    let e = map.get(k); if (!e) { e = [0, 0, 0, []]; map.set(k, e); }
    e[0] += nr.getX(i); e[1] += nr.getY(i); e[2] += nr.getZ(i); e[3].push(i);
  }
  for (const e of map.values()) {
    const l = Math.hypot(e[0], e[1], e[2]) || 1;
    for (const i of e[3]) nr.setXYZ(i, e[0] / l, e[1] / l, e[2] / l);
  }
  nr.needsUpdate = true;
  return geo;
}
function xform(THREE, geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
}
// Merge geometries that all carry position + normal + color (uvs dropped).
function merge(THREE, parts) {
  let vc = 0, ic = 0;
  for (const g of parts) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3);
  const idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of parts) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const cnt = g.attributes.position.count;
    for (let i = 0; i < cnt; i++) {
      pos[(vo + i) * 3] = g.attributes.position.getX(i); pos[(vo + i) * 3 + 1] = g.attributes.position.getY(i); pos[(vo + i) * 3 + 2] = g.attributes.position.getZ(i);
      nor[(vo + i) * 3] = g.attributes.normal.getX(i); nor[(vo + i) * 3 + 1] = g.attributes.normal.getY(i); nor[(vo + i) * 3 + 2] = g.attributes.normal.getZ(i);
      const c = g.attributes.color;
      col[(vo + i) * 3] = c ? c.getX(i) : 1; col[(vo + i) * 3 + 1] = c ? c.getY(i) : 1; col[(vo + i) * 3 + 2] = c ? c.getZ(i) : 1;
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) idx[io + k] = g.index.getX(k) + vo;
    else for (let k = 0; k < cnt; k++) idx[io + k] = k + vo;
    io += g.index ? g.index.count : cnt;
    vo += cnt;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
// Displaced, welded sphere blob (rocks, bushes, canopies).
function blob(THREE, r, ws, hs, amp, freq, seed) {
  const g = new THREE.SphereGeometry(r, ws, hs);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), l = Math.hypot(x, y, z) || 1;
    const d = 1 + amp * (vnoise3(x / l * freq + seed, y / l * freq, z / l * freq) - 0.5) * 2
      + amp * 0.35 * (vnoise3(x / l * freq * 2.7, y / l * freq * 2.7 + seed, z / l * freq * 2.7) - 0.5) * 2;
    p.setXYZ(i, x * d, y * d, z * d);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return weldNormals(g);
}
function roundRectShape(THREE, w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function extrudeShape(THREE, shape, depth, bevel = 0.02) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10 });
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}
const cyl = (THREE, rt, rb, h, seg = 16) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1); g.deleteAttribute('uv'); return g; };
const box = (THREE, w, h, d) => { const g = new THREE.BoxGeometry(w, h, d); g.deleteAttribute('uv'); return g; };
const sph = (THREE, r, ws = 20, hs = 14) => { const g = new THREE.SphereGeometry(r, ws, hs); g.deleteAttribute('uv'); return weldNormals(g); };
// lathe from [[r,y],...] profile
function lathe(THREE, prof, seg = 24) {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.deleteAttribute('uv');
  return weldNormals(g);
}

// AG section weight per polyline index: 0 outside track.agRanges, cosine ramp to 1 over the first
// and last `ramp` metres (matches the core's bank ramp). Wrap-aware; tolerates missing agRanges.
export function agWeights(track, ramp = 30) {
  const n = track.pl.count, W = new Float32Array(n), cum = track.cum, loop = track.loop;
  const arc = (a, b) => (((cum[b] - cum[a]) % loop) + loop) % loop;
  for (const r of track.agRanges || []) {
    const len = arc(r.i0, r.i1);
    for (let i = r.i0, g = 0; g < n; i = (i + 1) % n, g++) {
      const s = arc(r.i0, i), e = Math.min(s, len - s);
      W[i] = Math.max(W[i], 0.5 - 0.5 * Math.cos(Math.PI * clamp(e / ramp, 0, 1)));
      if (i === r.i1) break;
    }
  }
  return W;
}
const AG_EXT = 1.2;      // AG road runs this far past half so the bank climb (half + 1.0) stays on asphalt
const AG_CYAN = 0x29e6ff;

// ===================================================================== main
export function buildTrackScene(THREE, track, theme) {
  theme = Object.assign({ grass: 0x5f9a4a, road: 0x53565e, curb: 0xd8232a, wall: 0xe8e1d5, trees: 0x2f7a3a }, track.def?.theme || {}, theme || {});
  const group = new THREE.Group(); group.name = 'track';
  const pl = track.pl, n = pl.count, MX = track.frameX, MZ = track.frameZ, cum = track.cum, curv = track.curv;
  const PX = (i) => pl.pts[i].x, PZ = (i) => pl.pts[i].z;
  const half = (i) => track.halfWidth(i);
  const EV = (i) => track.elevAtIdx(i);
  const rnd = mulberry32(((track.def?.seed ?? 1) ^ 0x51ed27) >>> 0);
  const C = (hex) => new THREE.Color(hex);

  const matStd = (o = {}) => new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.8, metalness: 0.0 }, o));

  // "claimed": a point on THIS leg that actually belongs to another part of the road (overlapping
  // hairpin insides). Walls/kerbs there are skipped and the ribbon tucks under the other leg.
  function claimedBy(x, z, i, insideMargin) {
    const q = track.sample(x, z, i);
    if (Math.abs(idxDelta(pl, i, q.idx)) <= 6) return null;
    if (insideMargin !== undefined && Math.abs(q.side) > q.half - insideMargin) return null;
    return q;
  }

  // per-vertex corner flag (for kerbs, wall accents, post spacing)
  const cornerAt = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (Math.abs(curv[i]) > 1 / 60) for (let k = -4; k <= 4; k++) cornerAt[(i + k + n) % n] = 1;

  // AG: road edge moves out, and barriers sit on the banked surface (height via surfaceY)
  const W = agWeights(track);
  const edgeOff = (j) => half(j) + AG_EXT * W[j];
  const edgeY = (j, sg) => (W[j] > 0 ? track.surfaceY(PX(j) + sg * edgeOff(j) * MX[j], PZ(j) + sg * edgeOff(j) * MZ[j]) : EV(j));

  // ================================================================= road ribbon
  const U = [-1, -0.965, -0.93];
  for (let u = -0.8; u <= 0.8001; u += 0.1) U.push(+u.toFixed(3));
  U.push(0.93, 0.965, 1);
  const COLS = U.length;
  const road = (() => {
    const rows = n + 1, vc = rows * COLS;
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3);
    const base = C(theme.road), line = C(theme.road).multiplyScalar(0.8), white = C(0xf2f2ee);
    const padTint = C(0x2a9df4), agTint = C(0x123a5c);
    const tmp = new THREE.Color();
    for (let r = 0; r < rows; r++) {
      const i = r % n, h = edgeOff(i), mx = MX[i], mz = MZ[i];
      const lineOff = -clamp(curv[i] * 30, -1, 1) * 0.55 * h;   // racing line hugs the inside
      for (let k = 0; k < COLS; k++) {
        const side = U[k] * h, x = PX(i) + side * mx, z = PZ(i) + side * mz;
        const q = track.sample(x, z, i);
        let y = W[i] > 0 ? q.y : EV(i);   // AG: banked cross-section straight from surfaceY
        let nx = -q.slopeX, ny = 1, nz = -q.slopeZ;
        if (Math.abs(idxDelta(pl, i, q.idx)) > 6) { y = Math.min(y, q.y) - 0.035; }   // under the other leg
        const v = r * COLS + k;
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        const nl = Math.hypot(nx, ny, nz); nor[v * 3] = nx / nl; nor[v * 3 + 1] = ny / nl; nor[v * 3 + 2] = nz / nl;
        // colour: asphalt grain + racing line + edge lines + faint pad glow
        const grain = 0.94 + 0.1 * fbm2(x * 0.35, z * 0.35);
        const dl = Math.abs(side - lineOff);
        tmp.copy(base).lerp(line, Math.exp(-((dl / 1.6) ** 2)) * 0.85).multiplyScalar(grain);
        if (Math.abs(U[k]) >= 0.96) tmp.copy(white).multiplyScalar(0.97 + 0.03 * grain);
        if (q.pad) tmp.lerp(padTint, 0.25);
        if (W[i] > 0) tmp.lerp(agTint, 0.4 * W[i]);
        col[v * 3] = tmp.r; col[v * 3 + 1] = tmp.g; col[v * 3 + 2] = tmp.b;
      }
    }
    const idx = new Uint32Array(n * (COLS - 1) * 6);
    let o = 0;
    for (let r = 0; r < n; r++) for (let k = 0; k < COLS - 1; k++) {
      const a = r * COLS + k, b = (r + 1) * COLS + k, c = a + 1, d = b + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = c; idx[o++] = b; idx[o++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, matStd({ roughness: 0.9 }));
    m.name = 'road'; m.receiveShadow = true; m.castShadow = false;
    return m;
  })();
  group.add(road);

  // ================================================================= markings (crisp quads, own verts)
  // world point + surface y at (arc s, lateral side)
  const at = (s, side, lift) => {
    const p = track.pointAt(s, side);
    return [p.x, track.sample(p.x, p.z, p.idx).y + lift, p.z];
  };
  function quadBuilder() {
    const P = [], N = [], Cc = [], I = [];
    return {
      quad(a, b, c, d, color) {   // a,b,c,d counter-clockwise seen from above (b = forward of a)
        const v = P.length / 3;
        for (const p of [a, b, c, d]) { P.push(p[0], p[1], p[2]); N.push(0, 1, 0); Cc.push(color.r, color.g, color.b); }
        // ensure upward winding
        const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2];
        const up = uz * vx - ux * vz;   // y of (b-a) x (c-a)
        if (up >= 0) I.push(v, v + 1, v + 2, v, v + 2, v + 3); else I.push(v, v + 2, v + 1, v, v + 3, v + 2);
      },
      tri(a, b, c, color) {
        const v = P.length / 3;
        for (const p of [a, b, c]) { P.push(p[0], p[1], p[2]); N.push(0, 1, 0); Cc.push(color.r, color.g, color.b); }
        const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
        if (up >= 0) I.push(v, v + 1, v + 2); else I.push(v, v + 2, v + 1);
      },
      geometry() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
        g.setIndex(I);
        g.computeBoundingSphere();
        return g;
      },
    };
  }
  const startS = cum[track.startIdx];
  const marks = (() => {
    const qb = quadBuilder();
    const blk = C(0x15161a), wht = C(0xf4f4f0);
    // checkered start/finish band: 3 rows x ~1 m cells across the full width
    const h0 = track.pointAt(startS, 0).half;
    const cells = Math.max(8, Math.round((2 * h0) / 1.05));
    const cw = (2 * h0) / cells, rowsN = 3, rl = 1.05;
    for (let r = 0; r < rowsN; r++) {
      const s0 = startS - (rowsN * rl) / 2 + r * rl, s1 = s0 + rl;
      for (let c = 0; c < cells; c++) {
        const a0 = -h0 + c * cw, a1 = a0 + cw;
        qb.quad(at(s0, a0, 0.012), at(s1, a0, 0.012), at(s1, a1, 0.012), at(s0, a1, 0.012), (r + c) & 1 ? blk : wht);
      }
    }
    // white grid boxes for the starting slots
    for (let i = 0; i < 6; i++) {
      const g = track.gridSlot(i, 6);
      const ps = track.progressOf(g.x, g.z, g.idx);
      const sSlot = startS - ((1 - ps.frac) % 1) * track.loop;
      const lat = (i % 2 === 0 ? 1 : -1) * Math.abs(track.sample(g.x, g.z, g.idx).side);
      const sF = sSlot + 1.6;
      qb.quad(at(sF, lat - 1.3, 0.012), at(sF + 0.3, lat - 1.3, 0.012), at(sF + 0.3, lat + 1.3, 0.012), at(sF, lat + 1.3, 0.012), wht);
      for (const e of [-1.3, 1.0]) qb.quad(at(sF - 1.4, lat + e, 0.012), at(sF + 0.3, lat + e, 0.012), at(sF + 0.3, lat + e + 0.3, 0.012), at(sF - 1.4, lat + e + 0.3, 0.012), wht);
    }
    const m = new THREE.Mesh(qb.geometry(), matStd({ roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.name = 'road-markings'; m.receiveShadow = true;
    return m;
  })();
  group.add(marks);

  // glowing chevron boost pads (unlit, not tone-mapped -> reads as emissive)
  const padMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const pads = (() => {
    const qb = quadBuilder();
    const plate = C(0x0b2a5a), rim = C(0x22d3ff), hot = C(0xffe14a), warm = C(0xff8a1c);
    for (const p of track.pads) {
      const L = p.len, W = p.halfW;
      const steps = 6;
      for (let k = 0; k < steps; k++) {   // base plate, follows the curve
        const s0 = p.s - L / 2 + (k / steps) * L, s1 = p.s - L / 2 + ((k + 1) / steps) * L;
        qb.quad(at(s0, -W, 0.014), at(s1, -W, 0.014), at(s1, W, 0.014), at(s0, W, 0.014), plate);
        qb.quad(at(s0, -W, 0.016), at(s1, -W, 0.016), at(s1, -W + 0.28, 0.016), at(s0, -W + 0.28, 0.016), rim);
        qb.quad(at(s0, W - 0.28, 0.016), at(s1, W - 0.28, 0.016), at(s1, W, 0.016), at(s0, W, 0.016), rim);
      }
      for (let c = 0; c < 3; c++) {          // three chevrons pointing along travel
        const a0 = p.s - L / 2 + 0.7 + c * 2.65, tip = a0 + 1.7, th = 1.05, w = W * 0.8;
        const col = c === 2 ? hot : c === 1 ? hot.clone().lerp(warm, 0.5) : warm;
        for (const sg of [-1, 1]) {
          qb.quad(at(a0, sg * w, 0.02), at(tip, 0, 0.02), at(tip + th, 0, 0.02), at(a0 + th, sg * w, 0.02), col);
        }
      }
    }
    const m = new THREE.Mesh(qb.geometry(), padMat);
    m.name = 'boost-pads'; m.receiveShadow = false;
    return m;
  })();
  group.add(pads);

  // ================================================================= kerbs (corner edges)
  const curb = (() => {
    const P = [], N = [], Cc = [], I = [];
    const red = C(theme.curb), wht = C(0xf6f4ef);
    const KW = 1.15;   // kerb width (on the road edge, inside the wall)
    const prof = [[KW, -0.012], [KW * 0.55, 0.06], [0, 0.075]];   // [inset from edge, height]
    let block = 0;
    for (let i = 0; i < n; i++) {
      if (!cornerAt[i] || W[i] > 0 || W[(i + 1) % n] > 0) { block = 0; continue; }   // no kerbs on the bank
      const i1 = (i + 1) % n;
      for (const sg of [-1, 1]) {
        for (let hh = 0; hh < 2; hh++) {
          const t0 = hh * 0.5, t1 = t0 + 0.5;
          const ends = [t0, t1].map((t) => {
            const h = half(i) + t * (half(i1) - half(i));
            let mx = MX[i] + t * (MX[i1] - MX[i]), mz = MZ[i] + t * (MZ[i1] - MZ[i]);
            const ml = Math.hypot(mx, mz); mx /= ml; mz /= ml;
            const cx = PX(i) + t * (PX(i1) - PX(i)), cz = PZ(i) + t * (PZ(i1) - PZ(i));
            return { h, mx, mz, cx, cz, y: EV(i) + t * (EV(i1) - EV(i)) };
          });
          const e0 = ends[0];
          if (claimedBy(e0.cx + sg * (e0.h - 0.5) * e0.mx, e0.cz + sg * (e0.h - 0.5) * e0.mz, i)) continue;
          const color = ((block + hh) & 1) ? wht : red;
          const v0 = P.length / 3;
          for (const e of ends) {
            for (const [inset, hy] of prof) {
              const sd = sg * (e.h - inset);
              P.push(e.cx + sd * e.mx, e.y + hy, e.cz + sd * e.mz);
              const tilt = inset > KW * 0.5 ? 0.16 : 0.0;   // inner ramp leans toward the road
              const nx = -sg * e.mx * tilt, nz = -sg * e.mz * tilt, l = Math.hypot(nx, 1, nz);
              N.push(nx / l, 1 / l, nz / l);
              Cc.push(color.r, color.g, color.b);
            }
          }
          // outer lip (vertical face down into the wall base)
          const v1 = P.length / 3;
          for (const e of ends) {
            const sd = sg * e.h;
            for (const hy of [0.075, -0.05]) {
              P.push(e.cx + sd * e.mx, e.y + hy, e.cz + sd * e.mz);
              N.push(sg * e.mx, 0, sg * e.mz);
              Cc.push(color.r * 0.8, color.g * 0.8, color.b * 0.8);
            }
          }
          // top strips: profile points 0-1, 1-2 between the two ends (rows of 3)
          for (let k = 0; k < 2; k++) {
            const a = v0 + k, b = v0 + 3 + k, c = a + 1, d = b + 1;
            if (sg > 0) I.push(a, b, c, c, b, d); else I.push(a, c, b, c, d, b);
          }
          { const a = v1, b = v1 + 2, c = v1 + 1, d = v1 + 3;
            if (sg > 0) I.push(a, b, c, c, b, d); else I.push(a, c, b, c, d, b); }
        }
      }
      block += 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
    g.setIndex(I);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, matStd({ roughness: 0.55 }));
    m.name = 'kerbs'; m.receiveShadow = true; m.castShadow = false;
    return m;
  })();
  group.add(curb);

  // ================================================================= barriers (swept rounded wall)
  const WT = 0.75, WH = 0.8, WB = -0.45, CAPR = WT / 2;
  // profile runs: [ [o, h, no, nh], ... ] — o outward from the road edge, h up
  const runs = [
    [[0, WB, -1, 0], [0, WH * 0.32, -1, 0], [0, WH, -1, 0]],
    (() => { const r = []; for (let k = 0; k <= 8; k++) { const a = Math.PI - (k / 8) * Math.PI; r.push([CAPR + Math.cos(a) * CAPR, WH + Math.sin(a) * CAPR * 0.7, Math.cos(a), Math.sin(a)]); } return r; })(),
    [[WT, WH, 1, 0], [WT, WB, 1, 0]],
  ];
  const wallSkip = [new Uint8Array(n), new Uint8Array(n)];
  const wall = (() => {
    const P = [], N = [], Cc = [], I = [];
    const wc = C(theme.wall), wDark = C(theme.wall).multiplyScalar(0.84), dirt = C(theme.wall).multiplyScalar(0.62);
    const accent = C(theme.curb), capW = C(theme.wall).multiplyScalar(0.95);
    for (const [si, sg] of [[0, -1], [1, 1]]) {
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        const h = half(i);
        const mid = claimedBy(PX(i) + sg * (h + 0.35) * MX[i], PZ(i) + sg * (h + 0.35) * MZ[i], i, 0.3);
        if (mid) { wallSkip[si][i] = 1; continue; }
        const panel = (Math.floor(i / 2) & 1) ? wc : wDark;
        for (let rI = 0; rI < runs.length; rI++) {
          const run = runs[rI];
          const v0 = P.length / 3;
          for (const j of [i, i1]) {
            const hj = edgeOff(j), mx = MX[j], mz = MZ[j], y0 = edgeY(j, sg), drop = y0 - EV(j);
            for (const [o, hy, no, nh] of run) {
              const sd = sg * (hj + o);
              P.push(PX(j) + sd * mx, y0 + (hy <= WB + 0.01 ? hy - drop : hy), PZ(j) + sd * mz);   // banked wall reaches the ground
              const nx = no * sg * mx, nz = no * sg * mz, l = Math.hypot(nx, nh, nz) || 1;
              N.push(nx / l, nh / l, nz / l);
              let c = panel;
              if (rI === 0 && hy <= WB + 0.01) c = dirt;
              else if (rI === 1) c = cornerAt[i] ? ((Math.floor(i / 2) & 1) ? accent : capW) : capW;
              else if (rI === 2) c = wDark;
              Cc.push(c.r, c.g, c.b);
            }
          }
          const m = run.length;
          for (let k = 0; k < m - 1; k++) {
            const a = v0 + k, b = v0 + m + k, c = a + 1, d = b + 1;
            if (sg > 0) I.push(a, b, c, c, b, d); else I.push(a, c, b, c, d, b);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
    g.setIndex(I);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, matStd({ roughness: 0.62 }));
    m.name = 'barrier'; m.castShadow = true; m.receiveShadow = true;
    return m;
  })();
  group.add(wall);

  // barrier posts (instanced lathe) — denser through corners
  const posts = (() => {
    const geo = paint(THREE, lathe(THREE, [[0.0, -0.4], [0.16, -0.4], [0.16, 0.05], [0.13, 0.12], [0.11, 0.3], [0.11, 1.45], [0.13, 1.5], [0.14, 1.56], [0.12, 1.63], [0.07, 1.68], [0.0, 1.7]], 12), C(0xffffff));
    const list = [];
    for (const [si, sg] of [[0, -1], [1, 1]]) {
      for (let i = 0; i < n; i++) {
        if (wallSkip[si][i]) continue;
        const step = cornerAt[i] ? 3 : 6;
        if (i % step || W[i] > 0) continue;   // AG bank gets the neon rail instead of posts
        const sd = sg * (half(i) + WT + 0.12);
        list.push({ x: PX(i) + sd * MX[i], z: PZ(i) + sd * MZ[i], y: EV(i), corner: cornerAt[i] });
      }
    }
    const m = new THREE.InstancedMesh(geo, matStd({ roughness: 0.45, metalness: 0.25 }), Math.max(1, list.length));
    const mat4 = new THREE.Matrix4(), c1 = C(0x3a3f47), c2 = C(theme.curb);
    list.forEach((p, k) => { mat4.makeTranslation(p.x, p.y, p.z); m.setMatrixAt(k, mat4); m.setColorAt(k, p.corner ? c2 : c1); });
    m.count = list.length;
    m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    m.name = 'barrier-posts'; m.castShadow = true; m.receiveShadow = true;
    return m;
  })();
  group.add(posts);

  // ================================================================= ground
  const ground = (() => {
    const b = track.bounds, M = 130, CELL = 5;
    const x0 = b.minX - M, x1 = b.maxX + M, z0 = b.minZ - M, z1 = b.maxZ + M;
    const nxC = Math.ceil((x1 - x0) / CELL), nzC = Math.ceil((z1 - z0) / CELL);
    const vc = (nxC + 1) * (nzC + 1);
    const pos = new Float32Array(vc * 3), col = new Float32Array(vc * 3);
    const grass = C(theme.grass), grassD = C(theme.grass).multiplyScalar(0.78), grassL = C(theme.grass).lerp(C(0xd8e86a), 0.18);
    const worn = C(theme.grass).lerp(C(0x9a8a5a), 0.45), gravel = C(0xc9b07c);
    const tmp = new THREE.Color();
    let hint = track.startIdx;
    for (let zi = 0; zi <= nzC; zi++) {
      for (let xi = 0; xi <= nxC; xi++) {
        const x = x0 + (xi / nxC) * (x1 - x0), z = z0 + (zi / nzC) * (z1 - z0);
        const q = track.sample(x, z, hint); hint = q.idx;
        const e = Math.abs(q.side) - q.half;
        let y = q.y;
        if (e < 1.2) y -= 0.3; else if (e < 9) y -= 0.06;
        const v = zi * (nxC + 1) + xi;
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        const nse = fbm2(x * 0.045, z * 0.045), fine = vnoise3(x * 0.4, 1.7, z * 0.4);
        tmp.copy(grassD).lerp(grassL, clamp(nse * 1.25 - 0.1, 0, 1)).multiplyScalar(0.93 + 0.12 * fine);
        const mow = (Math.floor((x + z * 0.35) / 9) & 1) ? 1.0 : 0.955;      // mown stripes, subtle
        tmp.multiplyScalar(e > 14 ? mow : 1);
        if (e < 8) tmp.lerp(worn, 0.55 * (1 - smoothstep((e - 1) / 7)));
        const cv = curv[q.idx], outside = Math.sign(q.side) === Math.sign(cv);
        if (Math.abs(cv) > 1 / 40 && outside && e < 13) tmp.lerp(gravel, 0.85 * (1 - smoothstep((e - 7) / 6)));   // gravel traps
        col[v * 3] = tmp.r; col[v * 3 + 1] = tmp.g; col[v * 3 + 2] = tmp.b;
      }
    }
    const idx = new Uint32Array(nxC * nzC * 6);
    let o = 0;
    for (let zi = 0; zi < nzC; zi++) for (let xi = 0; xi < nxC; xi++) {
      const a = zi * (nxC + 1) + xi, b2 = a + 1, c = a + (nxC + 1), d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b2; idx[o++] = b2; idx[o++] = c; idx[o++] = d;   // (+x,+z) grid -> up-facing
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, matStd({ roughness: 0.95 }));
    m.name = 'ground'; m.receiveShadow = true;
    // flat skirt out to the horizon (terrain is exactly 0 at the grid edge)
    const R = 1600, sk = grass.clone().multiplyScalar(0.9);
    const ring = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], outer = [[-R + (x0 + x1) / 2, -R + (z0 + z1) / 2], [R + (x0 + x1) / 2, -R + (z0 + z1) / 2], [R + (x0 + x1) / 2, R + (z0 + z1) / 2], [-R + (x0 + x1) / 2, R + (z0 + z1) / 2]];
    const sp = [], si = [];
    for (const [x, z] of [...ring, ...outer]) sp.push(x, -0.02, z);
    for (let k = 0; k < 4; k++) {
      const a = k, b2 = (k + 1) % 4, c = 4 + k, d = 4 + (k + 1) % 4;
      si.push(a, c, b2, b2, c, d);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(8).fill(0).flatMap(() => [0, 1, 0]), 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(new Array(8).fill(0).flatMap(() => [sk.r, sk.g, sk.b]), 3));
    sg.setIndex(si);
    // make sure the skirt faces up
    { const p = sp; const ax = p[12] - p[0], az = p[14] - p[2], bx = p[3] - p[0], bz = p[5] - p[2]; if (az * bx - ax * bz < 0) { for (let k = 0; k < si.length; k += 3) { const t = si[k + 1]; si[k + 1] = si[k + 2]; si[k + 2] = t; } sg.setIndex(si); } }
    sg.computeBoundingSphere();
    const skirt = new THREE.Mesh(sg, matStd({ roughness: 1 }));
    skirt.name = 'ground-skirt'; skirt.receiveShadow = true;
    m.add(skirt);
    return m;
  })();
  group.add(ground);

  // ================================================================= start / finish gantry
  const gantry = (() => {
    const sp = track.pointAt(startS, 0), h = sp.half, span = h + 1.9;
    const parts = [];
    const steel = C(0xd9dde3), dark = C(0x2a2d33), red = C(theme.curb), wht = C(0xf5f5f2), blk = C(0x141518);
    for (const sx of [-1, 1]) {           // pillars (lathed, flared base)
      const pg = lathe(THREE, [[0, -1], [0.75, -1], [0.75, 0.2], [0.62, 0.45], [0.5, 0.8], [0.46, 6.6], [0.52, 6.9], [0.55, 7.4], [0.45, 7.6], [0, 7.62]], 24);
      parts.push(paint(THREE, xform(THREE, pg, { x: sx * span }), steel));
      const band = cyl(THREE, 0.49, 0.49, 0.5, 24);
      parts.push(paint(THREE, xform(THREE, band, { x: sx * span, y: 2.2 }), red));
    }
    for (const y of [6.3, 7.35]) for (const zz of [-0.45, 0.45]) {   // truss chords
      parts.push(paint(THREE, xform(THREE, cyl(THREE, 0.11, 0.11, span * 2, 14), { y, z: zz, rz: Math.PI / 2 }), steel));
    }
    const bays = 12;
    for (let k = 0; k < bays; k++) {      // diagonal struts, both faces
      const xa = -span + (k / bays) * span * 2, xb = xa + (span * 2) / bays;
      const len = Math.hypot(xb - xa, 1.05), ang = Math.atan2(1.05, xb - xa);
      for (const zz of [-0.45, 0.45]) {
        const flip = k & 1;
        parts.push(paint(THREE, xform(THREE, cyl(THREE, 0.06, 0.06, len, 10), { x: (xa + xb) / 2, y: 6.825, z: zz, rz: flip ? -(Math.PI / 2 - ang) : (Math.PI / 2 - ang) }), steel));
      }
    }
    // banner with a checker strip on both faces + red header
    const bw = span * 1.4, bh = 1.6;
    parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, bw, bh, 0.18), 0.3, 0.04), { y: 5.35, z: -0.15 }), red));
    const cells = 18, cw = bw * 0.92 / cells;
    for (const zf of [-0.21, 0.36]) for (let r = 0; r < 2; r++) for (let c = 0; c < cells; c++) {
      const g = box(THREE, cw, 0.32, 0.03);
      parts.push(paint(THREE, xform(THREE, g, { x: -bw * 0.46 + (c + 0.5) * cw, y: 4.95 + r * 0.32, z: zf }), (r + c) & 1 ? blk : wht));
    }
    for (const zf of [-0.21, 0.36]) {     // header stripe
      parts.push(paint(THREE, xform(THREE, box(THREE, bw * 0.92, 0.42, 0.03), { y: 5.82, z: zf }), wht));
    }
    // start-light pod
    parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, 3.4, 0.8, 0.25), 0.5, 0.05), { y: 7.95, z: -0.25 }), dark));
    for (let k = 0; k < 5; k++) for (const zf of [-0.32, 0.32]) parts.push(paint(THREE, xform(THREE, sph(THREE, 0.24, 18, 12), { x: -1.2 + k * 0.6, y: 7.95, z: zf * 1.05, sz: 0.5 }), C(0x4a0b0b)));
    const g = merge(THREE, parts);
    const m = new THREE.Mesh(g, matStd({ roughness: 0.45, metalness: 0.2 }));
    // local X = across the road (frame normal), local Z = travel direction, Y up
    const xA = new THREE.Vector3(sp.nx, 0, sp.nz), yA = new THREE.Vector3(0, 1, 0), zA = new THREE.Vector3().crossVectors(xA, yA);
    m.matrix.makeBasis(xA, yA, zA).setPosition(sp.x, track.surfaceY(sp.x, sp.z), sp.z);
    m.matrixAutoUpdate = false;
    m.updateMatrixWorld(true);
    m.name = 'start-gantry'; m.castShadow = true; m.receiveShadow = true;
    return m;
  })();
  group.add(gantry);

  // ================================================================= AG sections: underglow, rails, entry gantry
  const ag = new THREE.Group(); ag.name = 'ag';
  if ((track.agRanges || []).length) {
    const cyan = C(AG_CYAN);
    // underglow: additive overlay sharing the road's vertices (only AG rows indexed), bright at the
    // edges with a light band every 8 m so speed reads on the bank
    const rp = road.geometry.attributes.position, gcol = new Float32Array(rp.count * 3), gi = [];
    for (let r = 0; r <= n; r++) {
      const i = r % n, w = W[i], band = (cum[i] % 8) < 1.2 ? 0.35 : 0;
      for (let k = 0; k < COLS; k++) {
        const f = w * (0.1 + 0.8 * smoothstep((Math.abs(U[k]) - 0.55) / 0.45) + band), v = r * COLS + k;
        gcol[v * 3] = cyan.r * f; gcol[v * 3 + 1] = cyan.g * f; gcol[v * 3 + 2] = cyan.b * f;
      }
      if (r < n && w > 0 && W[(r + 1) % n] > 0) for (let k = 0; k < COLS - 1; k++) {
        const a = r * COLS + k, b = a + COLS;
        gi.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', rp);
    gg.setAttribute('color', new THREE.BufferAttribute(gcol, 3));
    gg.setIndex(gi);
    gg.computeBoundingSphere();
    const glow = new THREE.Mesh(gg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    glow.name = 'ag-underglow';
    ag.add(glow);

    const neon = new THREE.MeshBasicMaterial({ color: AG_CYAN, toneMapped: false });
    const rails = [], signs = [], frames = [];
    for (const rg of track.agRanges) {
      // glowing rail along the top of each banked barrier
      for (const sg of [-1, 1]) {
        const pts = [];
        for (let i = rg.i0, g = 0; g < n; i = (i + 1) % n, g++) {
          if (W[i] > 0 || i === rg.i0 || i === rg.i1) {
            const sd = sg * (edgeOff(i) + CAPR);
            pts.push(new THREE.Vector3(PX(i) + sd * MX[i], edgeY(i, sg) + WH + CAPR * 0.7 + 0.08, PZ(i) + sd * MZ[i]));
          }
          if (i === rg.i1) break;
        }
        if (pts.length < 2) continue;
        const tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.12, 8, false);
        tg.deleteAttribute('uv');
        rails.push(paint(THREE, tg, cyan));
      }
      // entry gantry at the range start: pillars + crossbar frame, glowing "> AG <" sign
      const sp = track.pointAt(cum[rg.i0], 0), span = sp.half + 1.9;
      const steel = C(0x3a3f47), parts = [], glowParts = [];
      for (const sx of [-1, 1]) parts.push(paint(THREE, xform(THREE, lathe(THREE, [[0, -1], [0.55, -1], [0.55, 0.2], [0.36, 0.5], [0.32, 6.4], [0.38, 6.6], [0, 6.62]], 20), { x: sx * span }), steel));
      parts.push(paint(THREE, box(THREE, span * 2 + 0.8, 0.5, 0.5).translate(0, 6.4, 0), steel));
      parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, 6.4, 1.7, 0.2), 0.3, 0.04), { y: 5.3, z: -0.15 }), C(0x0d1220)));
      const lit = (geo) => { geo.deleteAttribute?.('uv'); glowParts.push(paint(THREE, geo, C(0xffffff))); };
      const zf = -0.24;   // the face oncoming karts see (travel is local +Z); their right hand is local -X
      lit(box(THREE, 0.16, 1.1, 0.06).rotateZ(0.36).translate(0.95 + 0.2, 5.3, zf));    // A
      lit(box(THREE, 0.16, 1.1, 0.06).rotateZ(-0.36).translate(0.95 - 0.2, 5.3, zf));
      lit(box(THREE, 0.42, 0.12, 0.06).translate(0.95, 5.15, zf));
      lit(new THREE.TorusGeometry(0.42, 0.08, 8, 28, 1.6 * Math.PI).rotateZ(0.95 * Math.PI).translate(-0.95, 5.3, zf));   // G
      lit(box(THREE, 0.3, 0.12, 0.06).translate(-0.95 - 0.27, 5.3, zf));
      for (const sx of [-1, 1]) for (let c = 0; c < 2; c++) {     // chevrons pointing at the letters
        const s = new THREE.Shape(), x0 = sx * (2.7 - c * 0.45), d = -sx;
        const pts = [[0, 0.45], [0.18, 0.45], [0.42, 0], [0.18, -0.45], [0, -0.45], [0.24, 0]].map(([x, y]) => [x0 + x * d, y]);
        s.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) s.lineTo(pts[k][0], pts[k][1]); s.closePath();
        const cg = extrudeShape(THREE, s, 0.03, 0);
        paint(THREE, xform(THREE, cg, { y: 5.3, z: zf - 0.03 }), cyan);
        glowParts.push(cg);
      }
      const xA = new THREE.Vector3(sp.nx, 0, sp.nz), zA = new THREE.Vector3().crossVectors(xA, new THREE.Vector3(0, 1, 0));
      const basis = new THREE.Matrix4().makeBasis(xA, new THREE.Vector3(0, 1, 0), zA).setPosition(sp.x, track.surfaceY(sp.x, sp.z), sp.z);
      frames.push(merge(THREE, parts).applyMatrix4(basis));
      signs.push(merge(THREE, glowParts).applyMatrix4(basis));
    }
    if (rails.length) { const m = new THREE.Mesh(merge(THREE, rails), neon); m.name = 'ag-rails'; ag.add(m); }
    if (frames.length) {
      const f = new THREE.Mesh(merge(THREE, frames), matStd({ roughness: 0.5, metalness: 0.3 }));
      f.name = 'ag-gantry'; f.castShadow = true; f.receiveShadow = true; ag.add(f);
      const s = new THREE.Mesh(merge(THREE, signs), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
      s.name = 'ag-sign'; ag.add(s);
    }
  }
  group.add(ag);

  // ================================================================= instanced scenery
  const props = new THREE.Group(); props.name = 'props';
  const byKind = {};
  for (const d of track.decor) (byKind[d.kind] = byKind[d.kind] || []).push(d);
  const propMat = matStd({ roughness: 0.82 });
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
  // one InstancedMesh per (kind, part); items -> instances; colorOf(item) -> THREE.Color
  function instanced(name, geo, items, colorOf, mat = propMat, opts = {}) {
    if (!items.length) return null;
    const m = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((d, k) => {
      tmpE.set(opts.tilt ? (hash3(k, 3, 9) - 0.5) * opts.tilt : 0, d.rot, opts.tilt ? (hash3(k, 5, 1) - 0.5) * opts.tilt : 0);
      tmpQ.setFromEuler(tmpE);
      const sc = d.scale || 1;
      tmpS.set(sc, sc * (opts.squash ? 0.8 + 0.4 * hash3(k, 7, 7) : 1), sc);
      tmpV.set(d.x, d.y + (opts.sink || 0) * sc, d.z);
      tmpM.compose(tmpV, tmpQ, tmpS);
      m.setMatrixAt(k, tmpM);
      m.setColorAt(k, colorOf(d, k));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    m.name = name; m.castShadow = opts.cast !== false; m.receiveShadow = true;
    return m;
  }
  function kindGroup(kind, meshes) {
    const g = new THREE.Group(); g.name = 'decor-' + kind;
    for (const m of meshes) if (m) g.add(m);
    if (g.children.length) props.add(g);
    return g;
  }
  const own = (d) => tmpC.set(d.color);
  const grey = (v) => tmpC.setRGB(v, v, v);

  // ---- trees: trunk + round (lobed blob) or pine (lathed tiers) canopy
  if (byKind.tree) {
    const trunk = paint(THREE, (() => {
      const g = lathe(THREE, [[0, 0], [0.42, 0], [0.36, 0.25], [0.3, 0.8], [0.26, 1.6], [0.24, 2.6], [0.22, 3.2], [0, 3.25]], 16);
      return xform(THREE, g, { y: -0.15 });
    })(), (x, y) => grey(0.85 + 0.15 * vnoise3(x * 6, y * 3, 1)).clone());
    const canopyShade = (ymin, ymax) => (x, y, z, nx, ny) => grey(clamp(0.55 + 0.45 * (y - ymin) / (ymax - ymin) + 0.08 * ny, 0.45, 1.05)).clone();
    const round = (() => {
      const lobes = [
        xform(THREE, blob(THREE, 1, 24, 16, 0.11, 2.2, 1.3), { y: 4.0, sx: 2.3, sy: 2.0, sz: 2.3 }),
        xform(THREE, blob(THREE, 1, 18, 12, 0.12, 2.6, 4.1), { x: 1.15, y: 3.35, z: 0.45, sx: 1.45, sy: 1.3, sz: 1.45 }),
        xform(THREE, blob(THREE, 1, 18, 12, 0.12, 2.6, 7.7), { x: -0.95, y: 3.55, z: -0.7, sx: 1.5, sy: 1.35, sz: 1.5 }),
        xform(THREE, blob(THREE, 1, 18, 12, 0.12, 2.6, 2.9), { x: 0.2, y: 5.4, z: -0.2, sx: 1.4, sy: 1.25, sz: 1.4 }),
      ];
      return merge(THREE, lobes.map((g) => paint(THREE, g, canopyShade(1.8, 6.8))));
    })();
    const pine = (() => {
      // separate pieces per tier: flat underside disc + lathed skirt -> crisp rims, correct normals
      const tiers = [[2.5, 1.9, 3.2], [2.0, 3.0, 4.4], [1.5, 4.2, 5.6], [1.0, 5.4, 7.3]];   // [radius, base y, top y]
      const shade = canopyShade(1.7, 7.3), parts = [];
      for (const [r, y0, y1] of tiers) {
        const h = y1 - y0;
        parts.push(paint(THREE, lathe(THREE, [[0.0, y0], [r * 0.5, y0 + 0.04], [r, y0 + 0.1]], 22), (x, y, z) => grey(0.5).clone()));
        parts.push(paint(THREE, lathe(THREE, [[r, y0 + 0.1], [r * 0.9, y0 + h * 0.18], [r * 0.7, y0 + h * 0.4], [r * 0.48, y0 + h * 0.62], [r * 0.26, y0 + h * 0.84], [0.0, y1]], 22), shade));
      }
      return merge(THREE, parts);
    })();
    const roundItems = byKind.tree.filter((d) => d.variant !== 1), pineItems = byKind.tree.filter((d) => d.variant === 1);
    const trunkCol = (d, k) => tmpC.set(0x6b4a2f).multiplyScalar(0.8 + 0.4 * hash3(k, 1, 2));
    kindGroup('tree', [
      instanced('tree-trunk', trunk, byKind.tree, trunkCol),
      instanced('tree-canopy-round', round, roundItems, own),
      instanced('tree-canopy-pine', pine, pineItems, (d) => tmpC.set(d.color).multiplyScalar(0.82)),
    ]);
  }

  // ---- rocks (displaced, mossy tops)
  if (byKind.rock) {
    const moss = C(theme.grass).lerp(C(0xffffff), 0.25);
    const g = paint(THREE, xform(THREE, blob(THREE, 1, 22, 16, 0.22, 1.7, 9.2), { y: 0.35, sx: 1.35, sy: 0.78, sz: 1.05 }),
      (x, y, z, nx, ny) => new THREE.Color(1, 1, 1).lerp(moss, smoothstep((ny - 0.55) / 0.4) * 0.6).multiplyScalar(0.85 + 0.25 * vnoise3(x * 3, y * 3, z * 3)));
    kindGroup('rock', [instanced('rock', g, byKind.rock, own, propMat, { tilt: 0.25, squash: true })]);
  }

  // ---- bushes (lobed cluster)
  if (byKind.bush) {
    const lobes = [
      xform(THREE, blob(THREE, 1, 20, 14, 0.14, 2.4, 3.3), { y: 0.55, sx: 1.1, sy: 0.85, sz: 1.1 }),
      xform(THREE, blob(THREE, 1, 18, 12, 0.14, 2.4, 5.9), { x: 0.85, y: 0.42, z: 0.2, sx: 0.8, sy: 0.65, sz: 0.8 }),
      xform(THREE, blob(THREE, 1, 18, 12, 0.14, 2.4, 8.1), { x: -0.7, y: 0.45, z: -0.35, sx: 0.85, sy: 0.7, sz: 0.85 }),
    ];
    const g = merge(THREE, lobes.map((l) => paint(THREE, l, (x, y, z, nx, ny) => grey(clamp(0.58 + 0.38 * y / 1.3 + 0.06 * ny, 0.5, 1.05)).clone())));
    kindGroup('bush', [instanced('bush', g, byKind.bush, own)]);
  }

  // ---- cone stacks (lathed cones with reflective band, square base)
  if (byKind.cone) {
    const orange = C(0xff6a10), white = C(0xf7f7f2), black = C(0x1b1b1f);
    const one = (y0) => {
      const body = lathe(THREE, [[0.0, 0.05], [0.27, 0.05], [0.25, 0.12], [0.2, 0.32], [0.16, 0.48], [0.12, 0.62], [0.08, 0.76], [0.05, 0.82], [0.0, 0.84]], 20);
      return paint(THREE, xform(THREE, body, { y: y0 }), (x, y) => ((y - y0) > 0.33 && (y - y0) < 0.5 ? white : orange));
    };
    const base = paint(THREE, (() => { const g = extrudeShape(THREE, roundRectShape(THREE, 0.62, 0.62, 0.08), 0.05, 0.01); return xform(THREE, g, { rx: -Math.PI / 2 }); })(), black);
    const g = merge(THREE, [base, one(0), one(0.13), one(0.24)]);
    kindGroup('cone', [instanced('cone', g, byKind.cone, (d, k) => grey(0.92 + 0.08 * hash3(k, 2, 2)))]);
  }

  // ---- tyre stacks (tori; painted tyres take the instance colour, rubber stays dark)
  if (byKind.tirestack) {
    const parts = [];
    for (let k = 0; k < 4; k++) {
      const t = new THREE.TorusGeometry(0.42, 0.17, 10, 22); t.deleteAttribute('uv');
      xform(THREE, t, { y: 0.17 + k * 0.33, rx: Math.PI / 2, ry: k * 0.7 });
      parts.push(paint(THREE, t, (k & 1) ? C(0xffffff) : C(0x1d1d20)));
    }
    kindGroup('tirestack', [instanced('tirestack', merge(THREE, parts), byKind.tirestack, own)]);
  }

  // ---- lamp posts (lathed pole + arm + housing) and their glowing lenses
  if (byKind.lamp) {
    const pole = lathe(THREE, [[0, 0], [0.32, 0], [0.3, 0.12], [0.2, 0.3], [0.16, 0.6], [0.12, 3.5], [0.09, 6.4], [0.1, 6.55], [0, 6.6]], 18);
    const arm = xform(THREE, cyl(THREE, 0.06, 0.06, 2.0, 12), { y: 6.45, z: 0.95, rx: Math.PI / 2 });
    const housing = xform(THREE, lathe(THREE, [[0, 0.0], [0.42, 0.0], [0.36, 0.12], [0.18, 0.25], [0, 0.28]], 22), { y: 6.2, z: 1.9, sx: 1.2, sz: 0.8 });
    const g = merge(THREE, [paint(THREE, pole, C(0xffffff)), paint(THREE, arm, C(0xffffff)), paint(THREE, housing, C(0x30343a))]);
    const lens = paint(THREE, xform(THREE, sph(THREE, 0.32, 20, 12), { y: 6.18, z: 1.9, sx: 1.25, sy: 0.25, sz: 0.85 }), C(0xffffff));
    const glow = new THREE.MeshBasicMaterial({ color: 0xfff0c8, toneMapped: false });
    kindGroup('lamp', [
      instanced('lamp', g, byKind.lamp, own, matStd({ roughness: 0.4, metalness: 0.4 })),
      instanced('lamp-lens', lens, byKind.lamp, () => grey(1), glow, { cast: false }),
    ]);
  }

  // ---- flags (pole + baked-wave banner; banner colour per instance)
  if (byKind.flag) {
    const pole = merge(THREE, [paint(THREE, cyl(THREE, 0.05, 0.07, 5.6, 12).translate(0, 2.8, 0), C(0xe6e8ec)), paint(THREE, sph(THREE, 0.11, 14, 10).translate(0, 5.65, 0), C(0xf2c14e))]);
    const banner = (() => {
      const w = 1.7, h = 1.05, g = new THREE.PlaneGeometry(w, h, 18, 6); g.deleteAttribute('uv');
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = (p.getX(i) + w / 2) / w;   // 0 at the pole
        p.setXYZ(i, 0.06 + u * w, 4.85 + p.getY(i) - u * 0.12, Math.sin(u * 5.2) * 0.16 * u);
      }
      g.computeVertexNormals();
      return paint(THREE, g, (x, y) => (Math.abs(y - (4.85 - (x / 1.7) * 0.12)) < 0.13 ? grey(0.55) : grey(1)).clone());
    })();
    kindGroup('flag', [
      instanced('flag-pole', pole, byKind.flag, () => grey(1), matStd({ roughness: 0.4, metalness: 0.5 })),
      instanced('flag-banner', banner, byKind.flag, own, matStd({ roughness: 0.9, side: THREE.DoubleSide }), { cast: true }),
    ]);
  }

  // ---- chevron corner boards (separate meshes for left/right arrows: no negative scales)
  if (byKind.sign) {
    const board = C(theme.curb), arrow = C(0xfafaf7), metal = C(0x9aa0a8);
    const make = (dir) => {
      const parts = [];
      for (const lx of [-0.75, 0.75]) parts.push(paint(THREE, cyl(THREE, 0.05, 0.05, 1.2, 10).translate(lx, 0.6, -0.05), metal));
      parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, 2.0, 0.85, 0.12), 0.06, 0.02), { y: 1.55, z: -0.03 }), board));
      for (let c = 0; c < 3; c++) {
        const s = new THREE.Shape(), x0 = -0.62 + c * 0.45;
        const pts = [[x0, 0.3], [x0 + 0.17, 0.3], [x0 + 0.38, 0], [x0 + 0.17, -0.3], [x0, -0.3], [x0 + 0.21, 0]].map(([x, y]) => [x * dir, y]);
        s.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) s.lineTo(pts[k][0], pts[k][1]); s.closePath();
        parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, s, 0.02, 0), { y: 1.55, z: 0.06 }), arrow));
      }
      return merge(THREE, parts);
    };
    kindGroup('sign', [
      instanced('sign-right', make(1), byKind.sign.filter((d) => d.dir >= 0), () => grey(1)),
      instanced('sign-left', make(-1), byKind.sign.filter((d) => d.dir < 0), () => grey(1)),
    ]);
  }

  // ---- sponsor billboards (3 designs; shapes not text)
  if (byKind.billboard) {
    const designs = [[0xd8232a, 0xf2c14e, 0xffffff], [0x1c86d1, 0xffffff, 0xf2c14e], [0x2fae5a, 0xef7f26, 0xffffff]];
    const meshes = designs.map(([bg, disc, bar], v) => {
      const L = 11, H = 3.2, parts = [];
      const items = byKind.billboard.filter((d) => d.variant % designs.length === v);
      if (!items.length) return null;
      for (const lx of [-L * 0.36, L * 0.36]) parts.push(paint(THREE, cyl(THREE, 0.13, 0.16, 5.2, 14).translate(lx, 2.6, -0.25), C(0x8b9098)));
      parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, L + 0.35, H + 0.35, 0.3), 0.25, 0.04), { y: 3.6, z: -0.3 }), C(0x22252b)));
      parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, L, H, 0.22), 0.04, 0), { y: 3.6, z: -0.0 }), C(bg)));
      const dg = new THREE.CircleGeometry(1.15, 40); dg.deleteAttribute('uv');
      parts.push(paint(THREE, xform(THREE, dg, { x: -L * 0.32, y: 3.6, z: 0.06 }), C(disc)));
      const ring = new THREE.RingGeometry(0.55, 0.78, 40); ring.deleteAttribute('uv');
      parts.push(paint(THREE, xform(THREE, ring, { x: -L * 0.32, y: 3.6, z: 0.07 }), C(bg)));
      parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, L * 0.5, 0.75, 0.3), 0.02, 0), { x: L * 0.12, y: 4.05, z: 0.04 }), C(bar)));
      parts.push(paint(THREE, xform(THREE, extrudeShape(THREE, roundRectShape(THREE, L * 0.36, 0.45, 0.2), 0.02, 0), { x: L * 0.05, y: 3.05, z: 0.04 }), C(bar).multiplyScalar(0.85)));
      return instanced('billboard-' + v, merge(THREE, parts), items, () => grey(1), matStd({ roughness: 0.55 }));
    });
    kindGroup('billboard', meshes);
  }

  // ---- grandstands (stepped concrete, coloured seats, spectators, roof on columns)
  if (byKind.stand) {
    const r2 = mulberry32(((track.def?.seed ?? 7) ^ 0xa11ce) >>> 0);
    const L = 26, D = 9, parts = [];
    const conc = C(0xc9c6c0), concD = C(0x9e9b95);
    parts.push(paint(THREE, box(THREE, L, 2.2, D).translate(0, 0.1, 0), concD));   // plinth (sunk below grade)
    const rowsN = 6, stepH = 0.55, stepD = 1.15, front = D / 2 - 1.2;
    const seatCols = [C(theme.curb), C(0xf5f5f2), C(0x1c86d1), C(0xf2c14e)];
    const shirts = [0xd8232a, 0x1c86d1, 0xf2c14e, 0x2fae5a, 0xffffff, 0x8e44ad, 0xef7f26, 0x222222];
    const skins = [0xf1c27d, 0xe8b98c, 0xc68642, 0x8d5524, 0xffdbac];
    for (let r = 0; r < rowsN; r++) {
      const top = 1.2 + (r + 1) * stepH, zc = front - r * stepD - stepD / 2;
      parts.push(paint(THREE, box(THREE, L, top, stepD).translate(0, top / 2, zc), (r & 1) ? conc : concD.clone().lerp(conc, 0.6)));
      for (let k = 0; k < 38; k++) {
        const x = -L / 2 + 0.8 + k * ((L - 1.6) / 37);
        const sc = seatCols[(r + Math.floor(k / 6)) % seatCols.length];
        parts.push(paint(THREE, box(THREE, 0.5, 0.12, 0.45).translate(x, top + 0.22, zc + 0.15), sc));
        parts.push(paint(THREE, box(THREE, 0.5, 0.45, 0.07).translate(x, top + 0.45, zc - 0.1), sc));
        if (r2() < 0.42) {      // a spectator
          const shirt = C(shirts[Math.floor(r2() * shirts.length)]);
          parts.push(paint(THREE, xform(THREE, sph(THREE, 0.22, 10, 7), { x, y: top + 0.62, z: zc + 0.05, sx: 1, sy: 1.35, sz: 0.8 }), shirt));
          parts.push(paint(THREE, sph(THREE, 0.15, 10, 7).translate(x, top + 1.05, zc + 0.08), C(skins[Math.floor(r2() * skins.length)])));
        }
      }
    }
    const backTop = 1.2 + rowsN * stepH;
    parts.push(paint(THREE, box(THREE, L, backTop + 1.6, 0.35).translate(0, (backTop + 1.6) / 2, front - rowsN * stepD - 0.2), concD));
    for (const ex of [-L / 2 - 0.15, L / 2 + 0.15]) parts.push(paint(THREE, box(THREE, 0.3, backTop + 0.4, D - 1.2).translate(ex, (backTop + 0.4) / 2, -0.4), conc));
    const roofY = backTop + 3.4;
    for (let k = 0; k < 5; k++) {
      const x = -L / 2 + 1 + k * ((L - 2) / 4);
      parts.push(paint(THREE, cyl(THREE, 0.16, 0.2, roofY + 0.3, 14).translate(x, roofY / 2, front - rowsN * stepD + 0.1), C(0xd9dde3)));
    }
    const roof = extrudeShape(THREE, roundRectShape(THREE, L + 1.6, D - 0.6, 0.3), 0.22, 0.05);
    parts.push(paint(THREE, xform(THREE, roof, { y: roofY, z: -0.5, rx: -Math.PI / 2 + 0.09 }), (x, y, z, nx, ny) => (ny > 0 ? C(theme.curb) : C(0xf2f2ee))));
    const g = merge(THREE, parts);
    kindGroup('stand', [instanced('stand', g, byKind.stand, () => grey(1), matStd({ roughness: 0.75 }))]);
  }

  // any kind we have no model for still shows up (simple marker), so data never silently vanishes
  const known = new Set(['tree', 'rock', 'bush', 'cone', 'tirestack', 'lamp', 'flag', 'sign', 'billboard', 'stand']);
  for (const kind of Object.keys(byKind)) {
    if (known.has(kind)) continue;
    const g = paint(THREE, sph(THREE, 0.6, 16, 12).translate(0, 0.6, 0), C(0xffffff));
    kindGroup(kind, [instanced(kind, g, byKind[kind], own)]);
  }
  group.add(props);

  group.userData = { padMaterial: padMat, startS, extras: { marks, pads, posts, gantry, ag } };
  return { group, meshes: { road, curb, wall, ground, props, marks, pads, posts, gantry, ag } };
}
