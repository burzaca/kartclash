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
import { KEYMAP_LABEL } from '../config.js';

export function createMenu(root, opts) {
  // ---- injected single stylesheet ------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    /* --- root --------------------------------------------------- */
    .kc-menu { position: relative; width: 100%; height: 100%; background: #111; color: #eee; }

    /* --- title / subtitle ---------------------------------------- */
    .kc-title {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: calc(var(--kc-scale) * 4rem);
      font-weight: 900;
      text-align: center;
      margin: calc(var(--kc-scale) * 2rem) 0;
      text-shadow: 0 0 8px var(--kc-glow-color, #fff);
    }
    .kc-subtitle {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: calc(var(--kc-scale) * 1.5rem);
      text-align: center;
      margin-bottom: calc(var(--kc-scale) * 3rem);
    }

    /* --- track name ---------------------------------------------- */
    .kc-track {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: calc(var(--kc-scale) * 1.2rem);
      text-align: center;
      margin-bottom: calc(var(--kc-scale) * 2rem);
    }

    /* --- control map display ------------------------------------ */
    .kc-control {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: calc(var(--kc-scale) * 0.9rem);
    }
    .kc-control span { display: inline-block; margin-right: calc(var(--kc-scale) * 0.5rem); }

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
