// tests/test_hud_layout.js — the HUD must never collide, leave the pane, or smother the picture.
// This is the regression test for "the HUD is too cramped": the layout is a pure function, so the
// geometry can be proven for every window size instead of eyeballed in one screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hudLayout, hudBoxes, overlaps, inside, hudUnit } from '../src/ui/hudLayout.js';

// window sizes we support, both as one pane (1 player) and as a split-screen half (2 players)
const WINDOWS = [
  [1024, 640], [1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440], [900, 600],
];

const panes = [];
for (const [w, h] of WINDOWS) {
  panes.push({ why: `${w}x${h} solo`, w, h });
  panes.push({ why: `${w}x${Math.floor(h / 2)} split half`, w, h: Math.floor(h / 2) });
}

test('no HUD element overlaps another, at any supported size', () => {
  for (const p of panes) {
    const boxes = hudBoxes(hudLayout(p.w, p.h));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        assert.ok(
          !overlaps(boxes[i], boxes[j]),
          `${p.why}: ${boxes[i].name} ${JSON.stringify(boxes[i])} overlaps ${boxes[j].name} ${JSON.stringify(boxes[j])}`
        );
      }
    }
  }
});

test('every HUD element stays inside its pane', () => {
  for (const p of panes) {
    const L = hudLayout(p.w, p.h);
    for (const b of hudBoxes(L).concat([{ name: 'status', ...L.status }])) {
      assert.ok(inside(b, p.w, p.h), `${p.why}: ${b.name} escapes the pane: ${JSON.stringify(b)}`);
    }
  }
});

test('the HUD covers a small part of the pane, so the track stays readable', () => {
  for (const p of panes) {
    const boxes = hudBoxes(hudLayout(p.w, p.h));
    const hudArea = boxes.reduce((s, b) => s + b.w * b.h, 0);
    const frac = hudArea / (p.w * p.h);
    assert.ok(frac < 0.16, `${p.why}: HUD covers ${(frac * 100).toFixed(1)}% of the pane`);
  }
});

test('HUD elements stay big enough to read (the other failure mode: shrinking to nothing)', () => {
  for (const p of panes) {
    const L = hudLayout(p.w, p.h);
    assert.ok(L.topbar.h >= 20, `${p.why}: position/lap row too short to read (${L.topbar.h}px)`);
    assert.ok(L.item.w >= 34, `${p.why}: item slot too small to read (${L.item.w}px)`);
    assert.ok(L.minimap.w >= 80 && L.minimap.h >= 56, `${p.why}: minimap too small to use`);
    assert.ok(L.speed.w >= 40, `${p.why}: speed ring too small`);
  }
});

test('the layout scales with the pane rather than with a fixed base', () => {
  const small = hudLayout(640, 360), big = hudLayout(2560, 1440);
  assert.ok(big.u > small.u, 'the HUD unit must grow with the pane');
  assert.ok(small.u >= 4 && big.u <= 60, 'the unit must stay clamped');
  // proportions must be similar, so a small window is not "the same HUD, clipped"
  for (const k of ['topbar', 'item', 'speed', 'minimap']) {
    const a = small[k].w / 640, b = big[k].w / 2560;
    assert.ok(Math.abs(a - b) < 0.03, `${k}: proportion differs (${a.toFixed(3)} vs ${b.toFixed(3)})`);
  }
});

test('the middle of the pane is always free — nothing may sit over the kart', () => {
  for (const p of panes) {
    const L = hudLayout(p.w, p.h);
    const cx0 = p.w * 0.32, cx1 = p.w * 0.68, cy0 = p.h * 0.28, cy1 = p.h * 0.72;
    const centre = { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
    for (const b of hudBoxes(L)) {
      assert.ok(!overlaps(b, centre), `${p.why}: ${b.name} intrudes on the centre of the view: ${JSON.stringify(b)}`);
    }
  }
});

test('the unit is derived from the smaller side, so a split half is not oversized', () => {
  const uHalf = hudUnit(1920, 540);
  assert.ok(uHalf <= 1920 / 26 && uHalf <= 540 / 26 + 1e-9, 'unit must come from the pane height');
  const L = hudLayout(1920, 540);
  assert.ok(L.topbar.y + L.topbar.h < 540 * 0.35, 'top row must not eat a third of a half pane');
});
