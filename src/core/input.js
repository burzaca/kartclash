// input.js — keyboard controllers for 1–2 local players (+ inert controllers for CPU racers).
// PURE at import time: no DOM access until attach() is called with a target.
// Contract: docs/INTERFACES.md §2.

import { KEYMAP } from '../config.js';

const ACTIONS = ['up', 'down', 'left', 'right', 'drift', 'use'];

function defaultKeys(i) { return i === 0 ? 'wasd' : 'arrows'; }

function makeController(spec, index) {
  const human = !!(spec && spec.human);
  const keys = (spec && spec.keys) || (human ? defaultKeys(index) : null);
  const map = keys && KEYMAP[keys] ? { ...KEYMAP[keys] } : {};
  // reverse lookup: e.code -> action
  const codeToAction = {};
  for (const a of ACTIONS) if (map[a]) codeToAction[map[a]] = a;

  const state = { up: false, down: false, left: false, right: false, drift: false, use: false };
  let usePending = false;     // edge latch: set on false->true of `use`, consumed by intent()
  let target = null;
  let onDown = null, onUp = null, onBlur = null;

  const ctrl = {
    human, keys, map, state,

    press(action) {
      if (!(action in state)) return;
      if (action === 'use' && !state.use) usePending = true;
      state[action] = true;
    },

    release(action) {
      if (!(action in state)) return;
      state[action] = false;
    },

    releaseAll() { for (const a of ACTIONS) state[a] = false; },

    attach(t = (typeof window !== 'undefined' ? window : null)) {
      if (!t || !t.addEventListener || !human) return ctrl;
      ctrl.detach();
      target = t;
      onDown = (e) => {
        const a = codeToAction[e.code];
        if (!a) return;
        if (e.preventDefault) e.preventDefault();      // arrows/space must not scroll the page
        if (e.repeat && state[a]) return;              // auto-repeat never re-fires the use edge
        ctrl.press(a);
      };
      onUp = (e) => {
        const a = codeToAction[e.code];
        if (!a) return;
        if (e.preventDefault) e.preventDefault();
        ctrl.release(a);
      };
      onBlur = () => ctrl.releaseAll();                // no stuck keys after alt-tab
      t.addEventListener('keydown', onDown);
      t.addEventListener('keyup', onUp);
      t.addEventListener('blur', onBlur);
      return ctrl;
    },

    detach() {
      if (target && target.removeEventListener) {
        target.removeEventListener('keydown', onDown);
        target.removeEventListener('keyup', onUp);
        target.removeEventListener('blur', onBlur);
      }
      target = null; onDown = onUp = onBlur = null;
      return ctrl;
    },

    // throttle/steer in -1..1; steer +1 = right (heading increases, see kart.js)
    // use is an EDGE: true exactly once per press, even if intent() is polled late.
    intent() {
      const use = usePending;
      usePending = false;
      return {
        throttle: (state.up ? 1 : 0) - (state.down ? 1 : 0),
        steer: (state.right ? 1 : 0) - (state.left ? 1 : 0),
        drift: state.drift,
        use,
      };
    },
  };
  return ctrl;
}

// specs[i] = { human: bool, keys: 'wasd'|'arrows' }
export function createControllers(count, specs = []) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(makeController(specs[i] || { human: false }, i));
  return out;
}
