// tests/hud_dom.test.js — the HUD code path itself, driven through a minimal DOM stub.
// Why: the layout module being correct is not enough. This proves createHUD/setViewport/update
// actually APPLY those rectangles to the elements (no overlapping boxes in the real code path),
// and that a held item is DRAWN AND NAMED — the bug behind "we cannot see what we get from a
// pickup" was the slot painting a coloured disc in the player's own colour for every item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHUD } from '../src/ui/hud.js';
import { hudLayout, overlaps } from '../src/ui/hudLayout.js';
import { ITEM, ITEM_NAME } from '../src/config.js';

// ---- minimal DOM ------------------------------------------------------
class El {
  constructor(tag, ns) { this.tagName = tag; this.ns = ns || null; this.children = []; this.attrs = {}; this.dataset = {}; this._text = ''; this._html = ''; }
  get style() { if (!this._style) { const s = {}; Object.defineProperty(s, 'setProperty', { value: (k, v) => { s[k] = String(v); }, enumerable: false }); this._style = s; } return this._style; }
  get classList() {
    if (!this._cls) { const set = new Set(); this._cls = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => { if (on === undefined) on = !set.has(c); if (on) set.add(c); else set.delete(c); return on; } }; }
    return this._cls;
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  // the module assigns `el.className = 'kc-item'` — the stub must treat that as a class list,
  // otherwise the tests cannot find the elements the real code created
  set className(v) { this._cn = String(v); for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList.add(c); }
  get className() { return this._cn || ''; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  getContext() { return new Proxy({}, { get: () => () => ({}) }); }
}
global.document = { createElement: (t) => new El(t), createElementNS: (ns, t) => new El(t, ns) };

// ---- find the HUD elements the module created ------------------------
function flatten(node, out = []) { out.push(node); for (const c of node.children) flatten(c, out); return out; }
function byClass(root, cls) { return flatten(root).filter((n) => n._cls && n._cls.contains(cls)); }

function makeHUD(w, h) {
  const root = new El('div');
  const specs = [{ id: 0, name: 'P1', spec: { color: 0xd8232a, maxSpeed: 30 }, human: true },
                 { id: 1, name: 'P2', spec: { color: 0x2fa84f, maxSpeed: 30 }, human: true }];
  const hud = createHUD(root, specs, { players: 2 });
  hud.setViewport(0, { x: 0, y: 0, w, h });
  hud.setViewport(1, { x: 0, y: 0, w, h });
  return { root, hud };
}

const num = (style, key) => parseFloat(style[key]);
function rect(el) {
  const s = el.style;
  return { x: num(s, 'left'), y: num(s, 'top'), w: num(s, 'width'), h: num(s, 'height') };
}

function kartRow(id, i, over) {
  return Object.assign({
    id, isPlayer: true, viewport: { i }, place: 1, lap: 0, item: ITEM.NONE, count: 0,
    speed: 0, bestLap: Infinity, lapTimes: [], gapToLeader: 0, offRoad: false, star: false,
    spec: { color: id === 0 ? 0xd8232a : 0x2fa84f, maxSpeed: 30 },
    name: `P${i + 1}`,
  }, over);
}
const view = (k0, k1) => ({ karts: [k0, k1], phase: 'racing', time: 42.5, laps: 3 });

// ---- the tests -------------------------------------------------------
for (const [w, h] of [[1280, 720], [960, 540], [900, 300]]) {
  test(`the applied element rectangles match the layout and never overlap (${w}x${h})`, () => {
    const { root } = makeHUD(w, h);
    const L = hudLayout(w, h);
    const badges = byClass(root, 'kc-badge');
    assert.equal(badges.length, 2, 'each pane must have its own position badge');
    for (const badge of badges) {
      const r = rect(badge);
      assert.ok(Math.abs(r.x - L.topbar.x) < 1 && Math.abs(r.y - L.topbar.y) < 1, `badge moved to ${JSON.stringify(r)}, layout says ${JSON.stringify(L.topbar)}`);
    }
    // what matters: the badge and the lap counter are two boxes on one row, not stacked on each other
    const laps = byClass(root, 'kc-lap');
    for (let i = 0; i < 2; i++) {
      assert.ok(!overlaps(rect(badges[i]), rect(laps[i])), `pane ${i}: badge overlaps lap counter`);
    }
    const items = byClass(root, 'kc-item');
    const speeds = byClass(root, 'kc-speed');
    for (let i = 0; i < 2; i++) {
      assert.ok(!overlaps(rect(items[i]), rect(badges[i])), `pane ${i}: item slot overlaps the top bar`);
      assert.ok(!overlaps(rect(items[i]), rect(speeds[i])), `pane ${i}: item slot overlaps the speed ring`);
    }
  });
}

test('a held item is drawn as its own icon AND named (was: a coloured disc in the player colour)', () => {
  const { root, hud } = makeHUD(1280, 720);
  const itemBoxes = byClass(root, 'kc-item');
  const names = byClass(root, 'kc-itemname');

  for (const id of [ITEM.MUSHROOM, ITEM.GREEN_SHELL, ITEM.RED_SHELL, ITEM.BANANA, ITEM.LIGHTNING, ITEM.STAR, ITEM.FAKE_ITEM, ITEM.TRIPLE_MUSHROOM]) {
    hud.update(view(kartRow(0, 0, { item: id, count: id === ITEM.TRIPLE_MUSHROOM ? 3 : 1 }), kartRow(1, 1, {})));
    const svg = itemBoxes[0].children.find((c) => c.tagName === 'svg' || c.ns);
    assert.ok(svg, 'the item slot has no SVG layer to draw into');
    assert.ok(svg.children.length >= 1, `item ${ITEM_NAME[id]} drew no shapes in the slot`);
    assert.equal(names[0].textContent, ITEM_NAME[id], `the slot does not name the item (${ITEM_NAME[id]})`);
  }

  // the panes are independent: P2 holding nothing must not copy P1's item
  hud.update(view(kartRow(0, 0, { item: ITEM.STAR, count: 1 }), kartRow(1, 1, { item: ITEM.NONE, count: 0 })));
  assert.equal(names[1].textContent, '', 'pane 2 shows an item that its own kart is not holding');
});

test('the readouts say what a player expects: 4th/6th, the lap you are ON, own times per pane', () => {
  const { root, hud } = makeHUD(1280, 720);
  const badges = byClass(root, 'kc-badge');
  const laps = byClass(root, 'kc-lap');
  const stands = byClass(root, 'kc-standings');

  hud.update(view(
    kartRow(0, 0, { place: 4, lap: 0, bestLap: 44.2, lapTimes: [44.2], gapToLeader: 3.2 }),
    kartRow(1, 1, { place: 6, lap: 2, bestLap: 47.9, lapTimes: [47.9, 46.4], gapToLeader: 11.7 })));

  assert.equal(badges[0].textContent, '4th');
  assert.equal(badges[1].textContent, '6th');
  assert.equal(laps[0].textContent, '1/3', 'lap counter must show the lap you are on, not laps completed');
  assert.equal(laps[1].textContent, '3/3');
  assert.match(stands[0].textContent, /BEHIND LEADER/, 'pane 1 must show its own gap');
  assert.match(stands[1].textContent, /BEHIND LEADER/);
  assert.notEqual(stands[0].textContent, stands[1].textContent, 'both panes show identical text — one is showing the other player');
});

test('the final results stay on screen after the flag', () => {
  // they used to be written into the live standings strip and read fields main.js never sends,
  // so the end screen showed names with blank times and vanished on the next frame
  const { root, hud } = makeHUD(1280, 720);
  hud.results([
    { name: 'BOLTS', isPlayer: false, timeOrGap: '1:31.56', bestLap: '44.27' },
    { name: 'P1', isPlayer: true, timeOrGap: '+2.31', bestLap: '45.10' },
  ]);
  const panels = byClass(root, 'kc-results');
  assert.equal(panels.length, 2, 'each pane needs its own results panel');
  assert.match(panels[0].textContent, /1st\s+BOLTS\s+1:31\.56/, 'results lost the finishing time');
  assert.match(panels[0].textContent, /2nd\s+P1\s+\+2\.31.*YOU/, 'results do not mark the human racers');
  hud.update(view(kartRow(0, 0, {}), kartRow(1, 1, {})));
  assert.match(panels[0].textContent, /FINAL RESULTS/, 'the live HUD overwrote the results panel');
  hud.hideResults();
  assert.equal(panels[0].style.display, 'none');
});

test('the countdown banner no longer overwrites the position badge', () => {
  const { root, hud } = makeHUD(1280, 720);
  const badges = byClass(root, 'kc-badge');
  const banners = byClass(root, 'kc-banner');
  hud.banner('3', null, 500);
  assert.ok(banners.length === 2, 'no banner layer exists in each pane');
  assert.equal(banners[0].textContent, '3');
  assert.ok(!badges[0].textContent.includes('3'), 'the countdown was written into the position badge again');
});
