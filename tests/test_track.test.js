// test_track.test.js — contract tests for src/core/track.js (INTERFACES §1), run on EVERY track.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack } from '../src/core/track.js';
import { TRACKS, KART, RACE } from '../src/config.js';

const built = TRACKS.map((def) => ({ def, tr: buildTrack(def) }));

test('circuit summary (length + decor per kind)', () => {
  for (const { def, tr } of built) {
    const counts = {};
    for (const d of tr.decor) counts[d.kind] = (counts[d.kind] || 0) + 1;
    const kinds = Object.keys(counts).sort().map((k) => `${k}=${counts[k]}`).join(' ');
    console.log(`[track] ${def.id}: total ${tr.total.toFixed(1)} m, ${tr.pl.count} pts, startIdx ${tr.startIdx}, ` +
      `half ${tr.meta.halfMin.toFixed(2)}..${tr.meta.halfMax.toFixed(2)} m, decor ${tr.decor.length}: ${kinds}`);
    assert.ok(tr.decor.length >= 120, `${def.id}: decor count ${tr.decor.length}`);
    for (const k of ['tree', 'rock', 'bush', 'stand', 'flag', 'lamp', 'sign', 'billboard', 'tirestack', 'cone']) {
      assert.ok(counts[k] > 0, `${def.id}: no ${k}`);
    }
  }
});

for (const { def, tr } of built) {
  const pl = tr.pl, n = pl.count;

  test(`${def.id}: shape of the track object`, () => {
    for (const k of ['def', 'name', 'id', 'pl', 'total', 'halfWidth', 'surfaceY', 'sample', 'progressOf',
      'checkpoints', 'startIdx', 'gridSlot', 'itemNodes', 'pads', 'decor', 'bounds', 'minimap']) {
      assert.ok(k in tr, `missing ${k}`);
    }
    const s = tr.sample(pl.pts[5].x, pl.pts[5].z, 5);
    assert.deepEqual(Object.keys(s).sort(),
      ['ag', 'dist', 'frac', 'half', 'idx', 'nx', 'nz', 'onRoad', 'pad', 'side', 'slopeX', 'slopeZ', 'tx', 'tz', 'y'].sort());
    assert.equal(tr.checkpoints.length, 8);
    assert.equal(tr.itemNodes.length, def.itemNodes.length);
    assert.equal(tr.pads.length, def.boostPads.length);
    assert.ok(tr.minimap.xs.length === tr.minimap.zs.length && tr.minimap.xs.length > 50);
  });

  test(`${def.id}: closed polyline is continuous (no jump > 6 m)`, () => {
    for (let i = 0; i < n; i++) {
      const a = pl.pts[i], b = pl.pts[(i + 1) % n];
      assert.ok(Math.hypot(b.x - a.x, b.z - a.z) <= 6, `jump at ${i}`);
    }
  });

  test(`${def.id}: total length in 900..1600 m`, () => {
    assert.ok(tr.total >= 900 && tr.total <= 1600, `total ${tr.total}`);
    assert.equal(tr.total, pl.total);
  });

  test(`${def.id}: halfWidth stays within widthVar`, () => {
    for (let i = 0; i < n; i++) {
      const h = tr.halfWidth(i);
      assert.ok(h >= def.width / 2 * (1 - def.widthVar) - 1e-9 && h <= def.width / 2 * (1 + def.widthVar) + 1e-9, `half ${h} at ${i}`);
    }
  });

  test(`${def.id}: sample on the centreline -> |side| < 0.6, onRoad; off at half + 5`, () => {
    for (let i = 0; i < n; i++) {
      const p = pl.pts[i];
      for (const hint of [i, -1]) {
        const s = tr.sample(p.x, p.z, hint);
        assert.ok(Math.abs(s.side) < 0.6, `side ${s.side} at ${i}`);
        assert.equal(s.onRoad, true, `centreline off-road at ${i}`);
      }
      for (const sg of [-1, 1]) {
        const h = tr.halfWidth(i) + 5;
        const out = tr.sample(p.x + pl.normals[i].x * h * sg, p.z + pl.normals[i].z * h * sg, i);
        assert.equal(out.onRoad, false, `half+5 counted on-road at ${i} side ${sg}`);
      }
    }
  });

  test(`${def.id}: onRoad uses the kart-radius inset`, () => {
    for (let i = 0; i < n; i += 7) {
      const p = pl.pts[i], h = tr.halfWidth(i);
      const s = tr.sample(p.x, p.z, i);
      const inside = tr.sample(p.x + s.nx * (h - KART.radius - 0.2), p.z + s.nz * (h - KART.radius - 0.2), i);
      const edge = tr.sample(p.x + s.nx * (h - KART.radius + 0.3), p.z + s.nz * (h - KART.radius + 0.3), i);
      assert.equal(inside.onRoad, true, `inset inside at ${i}`);
      assert.equal(edge.onRoad, false, `inset edge at ${i}`);
    }
  });

  test(`${def.id}: surfaceY is one function of (x,z): sample().y === surfaceY(), any hint`, () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let k = 0; k < 400; k++) {
      const i = Math.floor(rnd() * n), lat = (rnd() * 2 - 1) * tr.halfWidth(i) * 1.6;
      const x = pl.pts[i].x + pl.normals[i].x * lat, z = pl.pts[i].z + pl.normals[i].z * lat;
      const y = tr.surfaceY(x, z);
      for (const hint of [i, -1, (i + 17) % n, (i + Math.floor(n / 2)) % n]) {
        assert.equal(tr.sample(x, z, hint).y, y, `y mismatch at ${x},${z} hint ${hint}`);
      }
    }
    // gentle and continuous: elevation inside +-1.5 amp, no step > 0.25 m between 1 m neighbours
    let maxAbs = 0, maxStep = 0;
    const b = tr.bounds;
    for (let z = b.minZ; z <= b.maxZ; z += 7) {
      let prev = null;
      for (let x = b.minX; x <= b.maxX; x += 1) {
        const y = tr.surfaceY(x, z);
        maxAbs = Math.max(maxAbs, Math.abs(y));
        // AG half-pipes are steep by design (bank + its embankment); their continuity has its own test
        if (prev !== null && !tr.sample(x, z, -1).ag) maxStep = Math.max(maxStep, Math.abs(y - prev));
        prev = y;
      }
    }
    assert.ok(maxAbs <= def.elev.amp * 1.01 + Math.max(0, ...(def.ag || []).map((a) => a.amp)), `elevation ${maxAbs}`);   // + AG bank
    assert.ok(maxStep < 0.25, `terrain step ${maxStep}`);
    const s = tr.sample(pl.pts[10].x, pl.pts[10].z, 10);
    assert.ok(Number.isFinite(s.slopeX) && Number.isFinite(s.slopeZ) && Math.hypot(s.slopeX, s.slopeZ) < 0.2);
  });

  test(`${def.id}: progressOf is monotonic along a full lap walk`, () => {
    const s0 = tr.cum[tr.startIdx];
    let prev = tr.progressOf(pl.pts[tr.startIdx].x, pl.pts[tr.startIdx].z, tr.startIdx);
    assert.ok(prev.frac < 1e-6 || prev.frac > 1 - 1e-6, `start frac ${prev.frac}`);
    let wraps = 0, hint = prev.idx;
    const steps = Math.ceil(tr.loop / 0.5);
    for (let k = 1; k <= steps; k++) {
      const p = tr.pointAt(s0 + (k / steps) * tr.loop * 0.9999 + 0.01, 0);
      const cur = tr.progressOf(p.x, p.z, hint);
      if (cur.frac < prev.frac) { wraps++; assert.ok(prev.frac > 0.99 && cur.frac < 0.01, `backwards at ${k}: ${prev.frac} -> ${cur.frac}`); }
      prev = cur; hint = cur.idx;
    }
    assert.ok(wraps <= 1);
    assert.ok(prev.frac > 0.99, `lap walk ended at ${prev.frac}`);
  });

  test(`${def.id}: checkpoints are 8 gates in racing order from the start line`, () => {
    assert.equal(tr.checkpoints[0].idx, tr.startIdx);
    let last = -1;
    for (const c of tr.checkpoints) {
      const rel = (c.idx - tr.startIdx + n) % n;
      assert.ok(rel > last, 'gate order');
      last = rel;
      assert.ok(Math.abs(Math.hypot(c.tx, c.tz) - 1) < 1e-6);
    }
  });

  test(`${def.id}: gridSlot slots are on-road, behind the line and >= 4 m apart`, () => {
    const count = 2 + RACE.aiField + 2;
    const slots = [];
    for (let i = 0; i < count; i++) {
      const g = tr.gridSlot(i, count);
      const s = tr.sample(g.x, g.z, tr.startIdx);
      assert.equal(s.onRoad, true, `slot ${i} off-road`);
      const fr = tr.progressOf(g.x, g.z, tr.startIdx).frac;
      assert.ok(fr > 0.9, `slot ${i} not behind the line (frac ${fr})`);
      const fw = { x: Math.cos(g.heading), z: Math.sin(g.heading) };
      assert.ok(fw.x * s.tx + fw.z * s.tz > 0.95, `slot ${i} heading`);
      slots.push(g);
    }
    for (let a = 0; a < slots.length; a++) for (let b = a + 1; b < slots.length; b++) {
      assert.ok(Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z) >= 4, `slots ${a},${b} too close`);
    }
  });

  test(`${def.id}: pads and item nodes sit on the road; pad flag fires on a pad`, () => {
    for (const p of tr.pads) {
      const s = tr.sample(p.x, p.z, p.idx);
      assert.equal(s.onRoad, true);
      assert.equal(s.pad, true, 'pad centre must report pad');
      const off = tr.sample(p.x + s.nx * (p.halfW + 0.6), p.z + s.nz * (p.halfW + 0.6), p.idx);
      assert.equal(off.pad, false, 'beside the pad must not report pad');
    }
    for (const it of tr.itemNodes) assert.equal(tr.sample(it.x, it.z, it.idx).onRoad, true);
  });

  test(`${def.id}: decor is deterministic and all off the road (|side| > half + 4)`, () => {
    const again = buildTrack(def).decor;
    assert.deepEqual(again, tr.decor);
    const st = pl.pts[tr.startIdx];
    for (const d of tr.decor) {
      const s = tr.sample(d.x, d.z, -1);
      assert.ok(Math.abs(s.side) > s.half + 4, `${d.kind} at ${d.x.toFixed(1)},${d.z.toFixed(1)} side ${s.side.toFixed(2)} half ${s.half.toFixed(2)}`);
      assert.equal(d.y, tr.surfaceY(d.x, d.z));
      if (d.kind !== 'stand' && d.kind !== 'arch') assert.ok(Math.hypot(d.x - st.x, d.z - st.z) >= 60, `${d.kind} too close to start`);
      for (const k of ['rot', 'scale', 'color']) assert.ok(Number.isFinite(d[k]), `${d.kind}.${k}`);
    }
  });

  test(`${def.id}: bounds contain every centreline point`, () => {
    const b = tr.bounds;
    for (const p of pl.pts) assert.ok(p.x > b.minX && p.x < b.maxX && p.z > b.minZ && p.z < b.maxZ);
    const m = tr.minimap;
    for (let k = 0; k < m.xs.length; k++) assert.ok(m.xs[k] >= m.minX && m.xs[k] <= m.maxX && m.zs[k] >= m.minZ && m.zs[k] <= m.maxZ);
  });

  // ---------------------------------------------------------------- anti-gravity (§7)
  test(`${def.id}: agRanges + bankOffset (0 outside, 0 at side 0, ≈amp at |side|=half mid-range)`, () => {
    assert.equal(tr.agRanges.length, def.ag.length);
    const inRange = (i, r) => (r.i0 <= r.i1 ? i >= r.i0 && i <= r.i1 : i >= r.i0 || i <= r.i1);
    for (const r of tr.agRanges) {
      assert.ok(r.i0 >= 0 && r.i1 >= 0 && r.amp === def.ag[tr.agRanges.indexOf(r)].amp);
      const len = ((r.i1 - r.i0 + n) % n);
      const mid = (r.i0 + Math.floor(len / 2)) % n, h = tr.halfWidth(mid);
      assert.ok(Math.abs(tr.bankOffset(mid, h) - r.amp) < 1e-9, `mid bank ${tr.bankOffset(mid, h)}`);
      assert.ok(Math.abs(tr.bankOffset(mid, -h) - r.amp) < 1e-9);
      assert.equal(tr.bankOffset(mid, 0), 0);
      assert.ok(Math.abs(tr.bankOffset(mid, h * 3) - r.amp) < 1e-9, 'clamped beyond the edge');
      const p = pl.pts[mid];
      assert.equal(tr.sample(p.x, p.z, mid).ag, true);
      // surfaceY carries the bank: edge sits ~amp above the centre (elevation is level across)
      const q = tr.pointAt(tr.cum[mid], h * 0.999);
      assert.ok(Math.abs(tr.surfaceY(q.x, q.z) - tr.surfaceY(p.x, p.z) - r.amp) < 0.05);
    }
    for (let i = 0; i < n; i++) {
      if (tr.agRanges.some((r) => inRange(i, r))) continue;
      assert.equal(tr.bankOffset(i, tr.halfWidth(i)), 0, `bank outside at ${i}`);
      assert.equal(tr.sample(pl.pts[i].x, pl.pts[i].z, i).ag, false, `ag flag outside at ${i}`);
    }
  });

  test(`${def.id}: banked surface is continuous across range edges (no step > 0.2 m)`, () => {
    for (const r of tr.agRanges) {
      for (const i of [r.i0, r.i1]) {
        const s0 = tr.cum[i];
        for (const f of [0, 0.5, -0.5, 0.95, -0.95, 1.05]) {
          let prev = null;
          for (let ds = -40; ds <= 40; ds += 0.5) {
            const p = tr.pointAt(s0 + ds, 0), q = tr.pointAt(s0 + ds, f * p.half);
            const y = tr.surfaceY(q.x, q.z);
            if (prev !== null) assert.ok(Math.abs(y - prev) <= 0.2, `step ${(y - prev).toFixed(3)} at ds ${ds} f ${f}`);
            prev = y;
          }
        }
      }
    }
  });

  test(`${def.id}: outside AG ranges the surface is exactly the no-AG surface`, () => {
    const flat = buildTrack({ ...def, ag: [] });
    assert.equal(flat.agRanges.length, 0);
    const inAny = (i) => tr.agRanges.some((r) => (r.i0 <= r.i1 ? i >= r.i0 - 1 && i <= r.i1 + 1 : i >= r.i0 - 1 || i <= r.i1 + 1));
    for (let i = 0; i < n; i += 3) {
      if (inAny(i)) continue;
      for (const f of [0, 0.7, -1]) {
        const q = tr.pointAt(tr.cum[i], f * tr.halfWidth(i));
        assert.equal(tr.surfaceY(q.x, q.z), flat.surfaceY(q.x, q.z), `idx ${i}`);
      }
    }
  });
}

test('sample().frac is relative to the PAINTED start/finish (regression 2026-11-09: lap counted early near the last speed pad)', () => {
  const tr = buildTrack(TRACKS[0]);
  const pl = tr.pl, at = (i) => pl.pts[(i + pl.count) % pl.count];
  const p = at(tr.startIdx);
  const f0 = tr.sample(p.x, p.z, tr.startIdx).frac;
  assert.ok(Math.min(f0, 1 - f0) < 2e-3, `frac must be at the 0/1 seam at the checkered band, got ${f0.toFixed(4)}`);
  const q = at(tr.startIdx + pl.count - 1);
  const f = tr.sample(q.x, q.z, tr.startIdx + pl.count - 1).frac;
  assert.ok(f > 0.99, `one vertex before the line must read ~1, got ${f.toFixed(3)}`);
});
