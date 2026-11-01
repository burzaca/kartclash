// tests/menu_dom.test.js — "there is no menu, no way to figure out how to use the pickups".
// The title screen did render, but it was unstyled (a --kc-scale custom property that was never
// assigned), unclickable (its container sat under #ui's pointer-events:none), and it explained
// nothing about items. These tests keep all three from coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMenu } from '../src/ui/menu.js';
import { ITEM, ITEM_NAME, ITEM_DESC, ITEM_TABLE, ITEM_TRIPLE, KEYMAP_LABEL } from '../src/config.js';
import { El, installDom, byClass, text } from './dom_stub.js';

installDom(1440, 900);

const info = {
  title: 'KART CLASH', subtitle: 'GOLD CUP',
  tracks: [{ name: 'MUSHROOM CIRCUIT', selected: true }, { name: 'SHELL COAST', selected: false }],
  players: [{ name: 'P1', keys: 'wasd', color: 0xd8232a }, { name: 'P2', keys: 'arrows', color: 0x2fa84f }],
};

function menu() {
  const root = new El('div');
  const m = createMenu(root, {});
  return { root, m };
}

test('the title screen explains every item that can actually appear', () => {
  const { root, m } = menu();
  m.showTitle(info);
  const legend = byClass(root, 'kc-legend');
  assert.equal(legend.length, 1, 'no item legend on the title screen');
  const body = text(legend[0]);
  // every item that any position table can actually hand out must be explained
  const sellable = new Set();
  for (const table of ITEM_TABLE) for (const e of table) if (e.w > 0) sellable.add(e.id);
  assert.ok(sellable.size >= 6, 'the item tables look empty — this test is no longer testing anything');
  for (const id of sellable) {
    const base = ITEM_TRIPLE[id] !== undefined ? ITEM_TRIPLE[id] : id;
    if (!ITEM_NAME[base]) continue;
    assert.ok(body.includes(ITEM_NAME[base]), `the legend never names ${ITEM_NAME[base]} (id ${id})`);
    assert.ok(body.includes(ITEM_DESC[base]), `the legend names ${ITEM_NAME[base]} but never explains it`);
  }
  assert.match(body, /USE/, 'the legend never says which key fires an item');
});

test('the title screen shows both players their own keys', () => {
  const { root, m } = menu();
  m.showTitle(info);
  const controls = text(byClass(root, 'kc-control')[0]);
  const p1 = KEYMAP_LABEL.wasd, p2 = KEYMAP_LABEL.arrows;
  assert.ok(controls.includes('P1') && controls.includes(p1.use), 'player 1 has no key map on screen');
  assert.ok(controls.includes('P2') && controls.includes(p2.use), 'player 2 has no key map on screen');
});

test('the title offers the modes that exist, and each button says which action it triggers', () => {
  const { root, m } = menu();
  m.showTitle(info);
  const btns = byClass(root, 'kc-btn');
  const actions = btns.map((b) => b.dataset.action);
  assert.ok(actions.includes('start'), 'no 2-player start');
  assert.ok(actions.includes('p1only'), 'no single-player start');
  assert.ok(actions.includes('switch') || actions.includes('next'), 'no way to change track');
  assert.ok(actions.includes('restart'), 'no restart');
});

test('the menu scale is actually set (its stylesheet sizes everything from it)', () => {
  const { root, m } = menu();
  m.showTitle(info);
  const menuEl = byClass(root, 'kc-menu')[0];
  const s = parseFloat(menuEl.style['--kc-scale']);
  assert.ok(s >= 0.6 && s <= 1.35, `--kc-scale was ${menuEl.style['--kc-scale']}`);
});

test('the pause screen repeats the keys and offers a way back to the title', () => {
  const { root, m } = menu();
  m.showTitle(info);
  m.showPause();
  const controls = byClass(root, 'kc-control');
  assert.ok(controls.length >= 1, 'the pause screen shows no key map');
  assert.match(text(controls[0]), /use item/i, 'the pause key map does not say which key uses an item');
  const actions = byClass(root, 'kc-btn').map((b) => b.dataset.action);
  assert.ok(actions.includes('resume'), 'cannot resume');
  assert.ok(actions.includes('quit'), 'cannot get back to the title');
});
