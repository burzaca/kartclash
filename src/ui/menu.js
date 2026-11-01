// menu.js - title screen / pause / controls overlay for Kart Clash
// -------------------------------------------------
// Exported API (section 5):
//   createMenu(root, opts) → menu
//   menu.showTitle(info)          // info = {title,subtitle,tracks:[{name,selected}],players:[{name,keys,color}]}
//   menu.hide()
//   menu.showPause()
//   menu.hidePause()
//   menu.showControls()
//   menu.hideControls()
//   menu.onAction(cb)             // cb('start'|'p1only'|'restart'|'resume'|'quit')
//
// DOM: one root container, CSS injected via a single <style> tag,
//   all elements class-prefixed `kc-`, pointer-events:none.
//   Display type from system-ui stack, diagonal colour bands, glow,
//   focus ring, player colours. No external fonts/images/frameworks.
//
// ----------------------------------------------------------------------
import { KEYMAP_LABEL, ITEM, ITEM_NAME, ITEM_DESC } from '../config.js';

export function createMenu(root, opts) {
  // ---- injected single stylesheet ------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    /* --- root: centred card, scrollable if the window is short ---- */
    .kc-menu {
      position: relative; width: 100%; height: 100%; background: #111; color: #eee;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      overflow: auto; padding: 1rem 0; box-sizing: border-box;
      pointer-events: auto;  /* #ui is pointer-events:none; without this no button is clickable */
    }

    /* --- title / subtitle ---------------------------------------- */
    .kc-title {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: max(28px, calc(var(--kc-scale) * 2.4rem));
      font-weight: 900;
      text-align: center;
      margin: 0.3rem 0;
      text-shadow: 0 0 8px var(--kc-glow-color, #fff);
    }
    .kc-subtitle {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: max(12px, calc(var(--kc-scale) * 0.95rem));
      text-align: center;
      margin-bottom: 0.6rem;
      opacity: 0.85;
    }

    /* --- track name ---------------------------------------------- */
    .kc-track {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: max(12px, calc(var(--kc-scale) * 0.9rem));
      text-align: center;
      margin-bottom: 0.5rem;
      color: #ffd76a;
    }

    /* --- control map display ------------------------------------ */
    .kc-control {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: max(11px, calc(var(--kc-scale) * 0.8rem));
      text-align: center;
      margin-bottom: 0.5rem;
    }
    .kc-control span { display: inline-block; margin-right: 0.7rem; }

    /* --- what each pickup does: a first-time player should not have to guess -- */
    .kc-legend {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 0.7rem;
      max-width: min(94vw, 60rem);
      margin: 0.3rem auto 0.7rem;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: max(11px, calc(var(--kc-scale) * 0.8rem));
      line-height: 1.35;
    }
    .kc-legend b { font-weight: 700; color: #fff; white-space: nowrap; }
    .kc-legend i { font-style: normal; color: #b9c2cc; }

    /* --- buttons ------------------------------------------------- */
    .kc-btn {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: calc(var(--kc-scale) * 1rem);
      font-weight: 600;
      padding: calc(var(--kc-scale) * 0.6rem) calc(var(--kc-scale) * 1.2rem);
      margin: calc(var(--kc-scale) * 0.4rem) 0;
      border: none;
      border-radius: calc(var(--kc-scale) * 0.5rem);
      background: var(--kc-btn-bg, #222);
      color: #fff;
      cursor: pointer;
      text-align: center;
      transition: background 0.15s, transform 0.05s;
      outline: none;
    }
    .kc-btn:focus-visible {
      background: var(--kc-btn-focus-bg, #444);
      outline: 2px solid var(--kc-focus-color, #00bfff);
    }
    .kc-btn:hover { background: var(--kc-btn-hover-bg, #333); }
    .kc-btn:active { transform: scale(0.98); }

    /* --- overlay dimming (pause/controls) ----------------------- */
    .kc-overlay {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.6); pointer-events: auto;
    }

    /* --- focus ring for whole menu ------------------------------ */
    .kc-menu:focus-visible { outline: 3px solid var(--kc-focus-color, #00bfff); outline-offset: 4px; }
  `;
  root.appendChild(style);

  // ---- root container ------------------------------------------------
  const menuRoot = document.createElement('div');
  menuRoot.className = 'kc-menu';
  root.appendChild(menuRoot);

  // The stylesheet sizes everything from --kc-scale. It was never assigned, so every calc()
  // fell back to the browser default and the title screen rendered unstyled.
  const applyScale = () => {
    const s = Math.min(1.35, Math.max(0.6, Math.min(window.innerWidth, window.innerHeight) / 900));
    menuRoot.style.setProperty('--kc-scale', String(s.toFixed(3)));
  };
  applyScale();
  window.addEventListener('resize', applyScale);

  // ---- shared vars ---------------------------------------------------
  let selectedIdx = 0;                // index among visible buttons
  let visibleMode = 'title';         // 'title'|'pause'|'controls'
  let flashTimer = null;

  // ---- build the initial title DOM -----------------------------------
  function buildTitle(info) {
    // clear any previous content
    menuRoot.innerHTML = '';

    const title = document.createElement('h1');
    title.className = 'kc-title';
    title.textContent = info.title || 'KART CLASH';
    menuRoot.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'kc-subtitle';
    subtitle.textContent = info.subtitle || 'GOLD CUP -- MUSHROOM CIRCUIT';
    menuRoot.appendChild(subtitle);

    // track name
    const trackDiv = document.createElement('div');
    trackDiv.className = 'kc-track';
    // assume first track or selected one
    const first = info.tracks?.[0];
    trackDiv.textContent = first ? `Track: ${first.name}` : 'Track: --';
    menuRoot.appendChild(trackDiv);

    // player control maps (both players)
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'kc-control';
    info.players.forEach((p, pi) => {
      const km = KEYMAP_LABEL[p.keys] || KEYMAP_LABEL.arrows; // fallback
      const span = document.createElement('span');
      span.textContent = `${p.name}: ↑${km.up} ↓${km.down} ←${km.left} →${km.right} drift${km.drift} use${km.use}`;
      controlsDiv.appendChild(span);
    });
    menuRoot.appendChild(controlsDiv);

    // what the pickups do — built from config so the legend can never drift from the real items
    const legend = document.createElement('div');
    legend.className = 'kc-legend';
    for (const id of [ITEM.MUSHROOM, ITEM.GREEN_SHELL, ITEM.RED_SHELL, ITEM.BANANA, ITEM.FAKE_ITEM, ITEM.LIGHTNING, ITEM.STAR]) {
      const name = document.createElement('b');
      name.textContent = ITEM_NAME[id];
      const desc = document.createElement('i');
      desc.textContent = ITEM_DESC[id] || '';
      legend.appendChild(name);
      legend.appendChild(desc);
    }
    const useHint = document.createElement('b');
    useHint.textContent = 'USING AN ITEM';
    const hintText = document.createElement('i');
    hintText.textContent = 'Drive over a glowing box to take an item, then press your USE key to fire it. Press during the countdown to launch a mushroom early.';
    legend.appendChild(useHint);
    legend.appendChild(hintText);
    menuRoot.appendChild(legend);

    // button container
    const btnGrp = document.createElement('div');
    btnGrp.style.display = 'flex';
    btnGrp.style.flexDirection = 'column';
    btnGrp.style.alignItems = 'center';
    btnGrp.style.gap = 'calc(var(--kc-scale) * 0.8rem)';

    const btnStart2P = document.createElement('button');
    btnStart2P.className = 'kc-btn';
    btnStart2P.textContent = 'Start 2P Race';
    btnStart2P.dataset.action = 'start';
    btnGrp.appendChild(btnStart2P);

    const btnStart1P = document.createElement('button');
    btnStart1P.className = 'kc-btn';
    btnStart1P.textContent = 'Start 1P Race';
    btnStart1P.dataset.action = 'p1only';
    btnGrp.appendChild(btnStart1P);

    const btnSwitch = document.createElement('button');
    btnSwitch.className = 'kc-btn';
    btnSwitch.textContent = 'Switch Track';
    btnSwitch.dataset.action = 'switch';
    btnGrp.appendChild(btnSwitch);

    const btnRestart = document.createElement('button');
    btnRestart.className = 'kc-btn';
    btnRestart.textContent = 'Restart';
    btnRestart.dataset.action = 'restart';
    btnGrp.appendChild(btnRestart);

    menuRoot.appendChild(btnGrp);

    // initial selection
    selectedIdx = 0;
    btnStart2P.focus();
  }

  // ---- build pause overlay -------------------------------------------
  function buildPause() {
    menuRoot.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.className = 'kc-overlay';
    menuRoot.appendChild(overlay);

    const title = document.createElement('h1');
    title.className = 'kc-title';
    title.textContent = 'PAUSED';
    overlay.appendChild(title);

    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'kc-btn';
    resumeBtn.textContent = 'Resume';
    resumeBtn.dataset.action = 'resume';
    overlay.appendChild(resumeBtn);

    const quitBtn = document.createElement('button');
    quitBtn.className = 'kc-btn';
    quitBtn.textContent = 'Quit to Title';
    quitBtn.dataset.action = 'quit';
    overlay.appendChild(quitBtn);

    selectedIdx = 0;
    resumeBtn.focus();
  }

  // ---- build controls overlay ----------------------------------------
  function buildControls() {
    menuRoot.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.className = 'kc-overlay';
    menuRoot.appendChild(overlay);

    const title = document.createElement('h1');
    title.className = 'kc-title';
    title.textContent = 'CONTROLS';
    overlay.appendChild(title);

    const text = document.createElement('p');
    text.style.fontSize = 'calc(var(--kc-scale) * 0.9rem)';
    text.textContent = [
      'Player 1 (WASD):',
      '  ↑ accelerate / W',
      '  ↓ brake / S',
      '  ← left / A',
      '  → right / D',
      '  Shift drift / Left Shift',
      '  Space use item / Space',
      '',
      'Player 2 (Arrows):',
      '  ↑ accelerate / ↑',
      '  ↓ brake / ↓',
      '  ← left / ←',
      '  → right →',
      '  Period drift / .',
      '  Slash use / /',
      '',
      'Enter / Start Race',
      '  R restart',
      '  P pause'
    ].join('\n');
    overlay.appendChild(text);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'kc-btn';
    closeBtn.textContent = 'Close';
    closeBtn.dataset.action = 'close';
    overlay.appendChild(closeBtn);

    selectedIdx = 0;
    closeBtn.focus();
  }

  // ---- public API ----------------------------------------------------
  const menu = {
    // showTitle(info) - display the title screen
    showTitle(info) {
      visibleMode = 'title';
      buildTitle(info);
      selectedIdx = 0;
      // ensure focus is on first button
      const firstBtn = menuRoot.querySelector('.kc-btn');
      if (firstBtn) firstBtn.focus();
    },

    // hide - remove the menu entirely
    hide() {
      menuRoot.innerHTML = '';
      visibleMode = 'title';
    },

    // showPause - pause overlay
    showPause() {
      visibleMode = 'pause';
      buildPause();
      const resumeBtn = menuRoot.querySelector('.kc-btn');
      if (resumeBtn) resumeBtn.focus();
    },

    // hidePause - get rid of pause overlay (caller usually shows title again)
    hidePause() {
      menu.hide();
    },

    // showControls - controls overlay
    showControls() {
      visibleMode = 'controls';
      buildControls();
      const closeBtn = menuRoot.querySelector('.kc-btn');
      if (closeBtn) closeBtn.focus();
    },

    // hideControls - remove controls overlay
    hideControls() {
      menu.hide();
    },

    // onAction(cb) - register a callback that receives the action string
    onAction(cb) {
      // bind keydown handling on the document; cb receives the chosen action
      function handler(e) {
        // allow navigation only while a mode is active
        if (visibleMode !== 'title' && visibleMode !== 'pause' && visibleMode !== 'controls') return;

        // arrow / WASD move selection
        let step = 0;
        if (['ArrowUp','KeyW','ArrowDown','KeyS'].includes(e.code)) {
          step = (e.code === 'ArrowUp' || e.code === 'KeyW') ? -1 : 1;
        } else if (e.key === 'Enter') {
          // activate selected button
          const btns = menuRoot.querySelectorAll('.kc-btn');
          if (btns[selectedIdx]) {
            const action = btns[selectedIdx].dataset.action;
            cb(action);
            // after action we return to title (or keep current mode)
            if (action === 'start' || action === 'resume' || action === 'quit') {
              menu.hide();
            }
          }
          return;
        }
        if (step !== 0) {
          const btns = menuRoot.querySelectorAll('.kc-btn');
          if (btns.length === 0) return;
          selectedIdx = (selectedIdx + step + btns.length) % btns.length;
          btns[selectedIdx].focus();
        }
      }
      document.addEventListener('keydown', handler);
      // return a teardown function so the caller can clean up
      return () => document.removeEventListener('keydown', handler);
    }
  };

  // initialise - by default show the title screen with default info
  const defaultInfo = {
    title: 'KART CLASH',
    subtitle: 'GOLD CUP -- MUSHROOM CIRCUIT',
    tracks: [{ name: 'Mushroom Circuit', selected: true }],
    players: [
      { name: 'P1', keys: 'wasd', color: 0xd8232a },
      { name: 'P2', keys: 'arrows', color: 0x1c86d1 }
    ]
  };
  menu.showTitle(defaultInfo);

  return menu;
}
