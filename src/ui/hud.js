// hud.js - split-screen HUD for Kart Clash
// -------------------------------------------------
// Exported API (section 5):
//   createHUD(root, racerSpecs, opts) → hud
//   hud.setTrack(plOrMinimap)          // {xs,zs,minX,maxX,minZ,maxZ,pts}
//   hud.setViewport(i, {x,y,w,h})      // px from canvas top
//   hud.update(view)                    // called each frame
//   hud.banner(text,sub,dur)
//   hud.flash(color)
//   hud.results(rows)
//   hud.hideResults()
//   hud.setStatus(text)
//   hud.dispose()
//
// DOM utils: one <style> element, two .kc-viewport containers,
//   each with its own set of .kc-* elements, all positioned absolutely
//   inside the viewport.  A CSS custom property `--kc-scale` is set by
//   setViewport() and used by the elements (no hard-coded full-screen px).
//   pointer-events: none on everything.  Class names prefixed `kc-`.

import { GAME, ITEM, ITEM_NAME, ITEM_TRIPLE, KART } from '../config.js';
import { formatTime, formatGap, kmh, clamp } from '../foundation.js';
import { hudLayout } from './hudLayout.js';

const KART_REF_SPEED = KART.maxSpeed;   // the speed the gauge is full at

export function createHUD(root, racerSpecs, opts) {
  // ---- style element (single injected stylesheet) -----------------
  // NOTE: this stylesheet only PAINTS the HUD. Every position and size comes from
  // src/ui/hudLayout.js as explicit pixels, because that is the only way the layout can be
  // unit-tested for overlap. (It used to size things with calc(var(--kc-scale)*rem) — a variable
  // that was never set, so the browser threw the sizes away and the chips piled up on each other.)
  const style = document.createElement('style');
  style.textContent = `
    .kc-hud { position: relative; width: 100%; height: 100%; }
    .kc-viewport { position: absolute; pointer-events: none; }

    .kc-badge, .kc-lap, .kc-standings, .kc-status {
      position: absolute;
      color: #fff;
      font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
      font-variant-numeric: tabular-nums;
      white-space: pre;
      text-shadow: 0 1px 3px rgba(0,0,0,0.85);
      user-select: none;
    }
    .kc-badge {
      background: var(--kc-badge-bg, #333);
      border: 1px solid rgba(255,255,255,0.35);
      border-radius: 8px;
      font-weight: 800;
      text-align: center;
      text-shadow: 0 1px 2px rgba(0,0,0,0.45);
    }
    .kc-lap {
      background: rgba(8,12,20,0.55);
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 8px;
      font-weight: 700;
      text-align: center;
    }
    .kc-item {
      position: absolute;
      background: rgba(8,12,20,0.62);
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 10px;
      overflow: hidden;
    }
    .kc-item.empty { border-style: dashed; border-color: rgba(255,255,255,0.25); }
    .kc-item svg { position: absolute; inset: 8% 8% 22%; width: 84%; height: 70%; }
    .kc-item .kc-itemname {
      position: absolute; left: 0; right: 0; bottom: 3px;
      text-align: center; color: #fff; font-weight: 700;
      font-family: ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.04em;
      text-shadow: 0 1px 2px rgba(0,0,0,0.9);
    }
    .kc-speed { position: absolute; }
    .kc-speed svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    .kc-speedtext {
      position: absolute; left: 0; right: 0; top: 34%;
      text-align: center; color: #fff; font-weight: 800;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    }
    .kc-speedtext small { display: block; font-size: 0.55em; font-weight: 600; opacity: 0.75; letter-spacing: 0.08em; }
    .kc-minimap {
      position: absolute;
      background: rgba(6,10,18,0.55);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 8px; overflow: hidden;
    }
    .kc-standings {
      background: rgba(8,12,20,0.5);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      line-height: 1.45;
    }
    .kc-status { opacity: 0.6; }

    /* --- end-of-race results panel: the centre is free while you drive, not after the flag -- */
    .kc-results {
      position: absolute; display: none; white-space: pre;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #fff; background: rgba(8,10,14,0.72); border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px; padding: 0.6em 0.9em; line-height: 1.5;
    }
    /* big centre text: the countdown, lap alerts */
    .kc-banner {
      position: absolute; left: 0; right: 0; top: 22%;
      text-align: center; pointer-events: none;
      font-family: ui-sans-serif, system-ui, sans-serif; font-weight: 900;
      color: #fff; text-shadow: 0 3px 14px rgba(0,0,0,0.85);
      opacity: 0; transition: opacity 0.15s;
    }
    .kc-banner .kc-banner-sub { display: block; font-size: 0.38em; font-weight: 700; opacity: 0.85; }
    .kc-banner.show { opacity: 1; }

    /* --- state reaction modifiers (added/removed by JS) -------- */
    .kc-badge.offroad   { opacity: 0.55; }
    .kc-badge.spinwobble { transform: rotate(calc(var(--kc-angle, 0) * 1deg)); }
    .kc-badge.invisible { opacity: 0.4; }
    .kc-badge.star        { filter: hue-rotate(45deg) saturate(1.4); }
  `;
  root.appendChild(style);

  // ---- root container -------------------------------------------------
  const hudRoot = document.createElement('div');
  hudRoot.className = 'kc-hud';
  root.appendChild(hudRoot);

  // ---- two viewports --------------------------------------------------
  const viewports = [];
  for (let i = 0; i < 2; i++) {
    const vp = document.createElement('div');
    vp.className = 'kc-viewport';
    vp.dataset.viewport = i;
    // initial size - will be overridden by setViewport
    vp.style.left = '0px'; vp.style.top = '0px';
    vp.style.width = '50%'; vp.style.height = '100%';
    hudRoot.appendChild(vp);
    viewports.push(vp);
  }

  // ---- per-viewport element pool (created once) ---------------------
  const vpElements = [{}, {}]; // vpElements[i] = map of element → dom node

  function initViewportElements(i) {
    const vp = viewports[i];
    const spec = racerSpecs[i];
    const el = {};

    // badge
    const badge = document.createElement('div');
    badge.className = 'kc-badge';
    badge.style.setProperty('--kc-badge-bg', rgbColor(spec.color));
    el.badge = badge;

    // lap counter
    const lap = document.createElement('div');
    lap.className = 'kc-lap';
    lap.textContent = '0/3';
    el.lap = lap;

    // item slot (box + svg)
    const itemBox = document.createElement('div');
    itemBox.className = 'kc-item';
    const itemSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    itemSvg.setAttribute('viewBox', '0 0 24 24');
    // generic placeholder - will be replaced per item type
    const placeholder = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    placeholder.setAttribute('cx', '12'); placeholder.setAttribute('cy', '12');
    placeholder.setAttribute('r', '9');
    placeholder.setAttribute('fill', rgbColor(spec.color));
    itemSvg.appendChild(placeholder);
    const countText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    countText.setAttribute('x', '12'); countText.setAttribute('y', '14');
    countText.setAttribute('fill', '#fff');
    countText.setAttribute('text-anchor', 'middle');
    countText.setAttribute('font-weight', '800');
    // sizes inside the 24x24 viewBox scale with the slot; the old calc(var(--kc-scale)…) was
    // never valid CSS, so the count rendered at the browser default size
    countText.setAttribute('font-size', '10');
    countText.textContent = '0';
    itemSvg.appendChild(countText);
    itemBox.appendChild(itemSvg);
    const itemName = document.createElement('div');
    itemName.className = 'kc-itemname';
    itemName.textContent = '';
    itemBox.appendChild(itemName);
    el.itemBox = itemBox;
    el.itemSvg = itemSvg;
    el.itemName = itemName;

    // speed gauge arc (svg circle + progress)
    const speedGauge = document.createElement('div');
    speedGauge.className = 'kc-speed';
    const speedSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    speedSvg.setAttribute('viewBox', '0 0 50 50');
    // outer track circle
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('cx', '25'); track.setAttribute('cy', '25'); track.setAttribute('r', '18');
    track.setAttribute('fill', 'none'); track.setAttribute('stroke', '#555');
    track.setAttribute('stroke-width', '3');
    speedSvg.appendChild(track);
    // progress arc (large circle, stroke-dasharray driven)
    const progress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    progress.setAttribute('cx', '25'); progress.setAttribute('cy', '25'); progress.setAttribute('r', '18');
    progress.setAttribute('fill', 'none');
    progress.setAttribute('stroke', rgbColor(spec.color));
    progress.setAttribute('stroke-width', '3');
    progress.setAttribute('stroke-linecap', 'round');
    // will be patched: stroke-dasharray = `${total} ${total}`; offset via stroke-dashoffset
    progress.style.strokeDasharray = '125.66 125.66'; // π*2*r ≈ 125.66
    progress.style.strokeDashoffset = '125.66'; // start fully open
    speedSvg.appendChild(progress);
    speedGauge.appendChild(speedSvg);
    // the number the ring was missing: a gauge you cannot read is decoration
    const speedText = document.createElement('div');
    speedText.className = 'kc-speedtext';
    speedText.innerHTML = '0<small>KM/H</small>';
    speedGauge.appendChild(speedText);
    el.speedText = speedText;
    el.speedGauge = speedGauge;
    el.speedProgress = progress;

    // minimap canvas
    const minimap = document.createElement('div');
    minimap.className = 'kc-minimap';
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120; // sized properly by setViewport
    minimap.appendChild(canvas);
    el.minimapBox = minimap;
    el.minimapCanvas = canvas;

    // standings strip
    const standings = document.createElement('div');
    standings.className = 'kc-standings';
    standings.textContent = '--:--.--  --:--.--  --:--.--  --:--.--';
    el.standings = standings;

    // status line
    const status = document.createElement('div');
    status.className = 'kc-status';
    status.textContent = '';
    el.status = status;

    // big centre banner (countdown, lap alerts) — banner() used to overwrite the position badge
    const banner = document.createElement('div');
    banner.className = 'kc-banner';
    el.banner = banner;

    // append all to viewport
    vp.appendChild(badge); vp.appendChild(lap);
    vp.appendChild(itemBox); vp.appendChild(speedGauge);
    vp.appendChild(minimap); vp.appendChild(standings);
    // end-of-race results panel (never written by update(), so it survives the finish line)
    const resultsEl = document.createElement('div');
    resultsEl.className = 'kc-results';
    resultsEl.style.display = 'none';
    el.resultsEl = resultsEl;

    vp.appendChild(status); vp.appendChild(banner); vp.appendChild(resultsEl);

    vpElements[i] = el;
  }

  initViewportElements(0);
  initViewportElements(1);

  // ---- shared helpers -------------------------------------------------
  function rgbColor(hex) {
    // hex like 0xd8232a → 'rgb(216,35,42)'
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    return `rgb(${r},${g},${b})`;
  }

  // map kart.item (ITEM.*) → an icon in the slot. It used to draw a disc in the player's OWN
  // colour for every item, which reads as "a green ball" and tells you nothing about what you
  // picked up. Each item now has its own silhouette, plus its name under the icon.
  // "1st/2nd/…": the old ternary chain could only ever print 1st, 2nd or 3rd, so with a field of
  // six everyone behind third looked identical.
  function ordinal(n) {
    const v = Math.max(1, Math.round(n || 1));
    if (v % 100 >= 11 && v % 100 <= 13) return `${v}th`;
    return `${v}` + ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function mk(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function drawItemIcon(svg, itemId, count) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const base = ITEM_TRIPLE[itemId] !== undefined ? ITEM_TRIPLE[itemId] : itemId;

    if (base === ITEM.MUSHROOM) {
      svg.appendChild(mk('rect', { x: 9, y: 12, width: 6, height: 8, rx: 2, fill: '#f3e6cc' }));
      svg.appendChild(mk('path', { d: 'M3 13 a9 8 0 0 1 18 0 z', fill: '#e02f3a' }));
      svg.appendChild(mk('circle', { cx: 8, cy: 9, r: 2.2, fill: '#fff' }));
      svg.appendChild(mk('circle', { cx: 15.5, cy: 8, r: 1.8, fill: '#fff' }));
    } else if (base === ITEM.GREEN_SHELL || base === ITEM.RED_SHELL) {
      const c = base === ITEM.RED_SHELL ? '#d8232a' : '#2fa84f';
      svg.appendChild(mk('circle', { cx: 12, cy: 13, r: 8, fill: c }));
      svg.appendChild(mk('circle', { cx: 12, cy: 13, r: 4.6, fill: '#f2e6cc' }));
      svg.appendChild(mk('circle', { cx: 12, cy: 13, r: 2.2, fill: c }));
      svg.appendChild(mk('circle', { cx: 12, cy: 4.6, r: 2.4, fill: '#f2e6cc' }));
    } else if (base === ITEM.BANANA) {
      svg.appendChild(mk('path', { d: 'M4 8 q1 11 12 12 q4 -1 4 -4 q-3 3 -8 1 Q7 15 6 9 Z', fill: '#ffd93b', stroke: '#c9a227', 'stroke-width': 0.6 }));
      svg.appendChild(mk('rect', { x: 3.4, y: 6.4, width: 2.4, height: 2.4, rx: 0.6, fill: '#7a5a12' }));
    } else if (base === ITEM.FAKE_ITEM) {
      for (const c of [[8, 15, 4.2], [15, 15, 4.2], [11.5, 11, 4.6]]) svg.appendChild(mk('circle', { cx: c[0], cy: c[1], r: c[2], fill: '#cfd6df' }));
      const q = mk('text', { x: 12, y: 15, 'text-anchor': 'middle', 'font-size': 8, 'font-weight': 800, fill: '#39424e' });
      q.textContent = '?';
      svg.appendChild(q);
    } else if (base === ITEM.LIGHTNING) {
      svg.appendChild(mk('polygon', { points: '13.5,1.5 5.5,13.5 10.5,13.5 8.5,22.5 18.5,8.5 12,8.5', fill: '#ffd23b', stroke: '#b8860b', 'stroke-width': 0.5 }));
    } else if (base === ITEM.STAR) {
      svg.appendChild(mk('polygon', { points: '12,2 14.6,9 22,9.4 16.2,14 18.2,21.4 12,17.3 5.8,21.4 7.8,14 2,9.4 9.4,9', fill: '#ffd84d', stroke: '#c9a227', 'stroke-width': 0.5 }));
    }

    if (count > 1) {
      const t = mk('text', { x: 12, y: 23, 'text-anchor': 'middle', 'font-size': 8, 'font-weight': 800, fill: '#fff', stroke: '#000', 'stroke-width': 0.5 });
      t.textContent = `x${count}`;
      svg.appendChild(t);
    }
  }

  // ---- public API -----------------------------------------------------
  let minimapData = null; // setTrack argument

  const hud = {
    // setTrack - receives minimap description from track worker
    setTrack(plOrMinimap) {
      minimapData = plOrMinimap; // {xs:[], zs:[], minX, maxX, minZ, maxZ, pts}
      // initial draw will happen on first update() when viewport size known
    },

    // setViewport(i, {x,y,w,h}) - px from top of canvas
    setViewport(i, rect) {
      const vp = viewports[i];
      vp.style.left = `${rect.x}px`;
      vp.style.top  = `${rect.y}px`;
      vp.style.width = `${rect.w}px`;
      vp.style.height = `${rect.h}px`;

      // Everything below is positioned from ONE pure function (src/ui/hudLayout.js) in pixels,
      // so tests can prove no element overlaps or leaves the pane at any window size.
      const el = vpElements[i];
      const L = hudLayout(rect.w, rect.h);
      const px = (n) => `${Math.round(n)}px`;
      const box = (node, b, fontSize) => {
        node.style.left = px(b.x); node.style.top = px(b.y);
        node.style.width = px(b.w); node.style.height = px(b.h);
        if (fontSize) node.style.fontSize = px(fontSize);
      };

      // top row: position badge, then the lap count to its right — one row, never stacked
      const badgeW = Math.round(L.topbar.w * 0.34);
      box(el.badge, { x: L.topbar.x, y: L.topbar.y, w: badgeW, h: L.topbar.h }, L.u * 1.5);
      el.badge.style.lineHeight = px(L.topbar.h);
      box(el.lap, { x: L.topbar.x + badgeW + L.u * 0.5, y: L.topbar.y, w: L.topbar.w - badgeW - L.u * 0.5, h: L.topbar.h }, L.u * 1.1);
      el.lap.style.lineHeight = px(L.topbar.h);

      box(el.itemBox, L.item);
      el.itemName.style.fontSize = px(Math.max(8, L.u * 0.62));
      box(el.speedGauge, L.speed);
      el.speedText.style.fontSize = px(L.u * 1.15);

      // minimap: CSS box from the layout, canvas bitmap at device pixels so it stays crisp
      box(el.minimapBox, L.minimap);
      const canvas = el.minimapCanvas;
      const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      canvas.width = Math.max(48, Math.round(L.minimap.w * dpr));
      canvas.height = Math.max(48, Math.round(L.minimap.h * dpr));
      canvas.style.width = px(L.minimap.w);
      canvas.style.height = px(L.minimap.h);
      el.mmDpr = dpr;

      box(el.standings, L.standings, L.u * 0.92);
      box(el.status, L.status, L.u * 0.82);
      el.status.style.lineHeight = px(L.status.h);
      // the debug readout is a harness tool, not part of the game's UI
      el.status.style.display = (opts && opts.debug) ? 'block' : 'none';

      el.banner.style.fontSize = px(L.u * 4.5);

      // the results card is centred — allowed, because it only appears after the flag
      const rw = Math.min(rect.w * 0.62, L.u * 26);
      const rh = L.u * 12;
      box(el.resultsEl, { x: (rect.w - rw) / 2, y: (rect.h - rh) / 2, w: rw, h: rh }, L.u * 1.0);
    },

    // helper to compute a percent-based pixel value
    // (kept tiny - no extra bundle)
    // calcPos(viewportDimension, percent) → pixel value
    // (exposed as a property for possible external use)
    // Not part of exported API - internal only.

    // update(view) - called every animation frame
    // view structure (as per section 5):
    //   { phase, time, laps, leaderGap, karts: [{id,name,spec,place,lap,laps,
    //     speed,item,count,star,invisible,shrunk,spin,offRoad,boost,
    //     finished,finishTime,bestLap,lapTimes,gapToLeader,isPlayer,
    //     viewport:{x,y,w,h}}] }
    update(view) {
      const karts = view.karts;
      const phase = view.phase;

      // ----- per-viewport processing ---------------------------------
      for (let i = 0; i < 2; i++) {
        const vp = viewports[i];
        const el = vpElements[i];
        const k = karts.find(k => k.isPlayer && k.viewport && k.viewport.i === i) ||
                  karts.find(k => !k.isPlayer && k.viewport && k.viewport.i === i) ||
                  karts[0]; // fallback - use first kart for demo

        // ---- position badge -------------------------------------------------
        el.badge.textContent = ordinal(k.place);
        el.badge.style.setProperty('--kc-badge-bg', rgbColor(k.spec.color));
        // state reactions
        if (k.offRoad) el.badge.classList.add('offroad');
        else          el.badge.classList.remove('offroad');

        if (k.spin) {
          // store angle for spin wobble; each frame we rotate a little
          el.badge.style.setProperty('--kc-angle', `${k.spin * 30}deg`);
          el.badge.classList.add('spinwobble');
        } else {
          el.badge.classList.remove('spinwobble');
        }

        if (k.invisible) el.badge.classList.add('invisible');
        else             el.badge.classList.remove('invisible');

        if (k.star) el.badge.classList.add('star');
        else        el.badge.classList.remove('star');

        // ---- lap counter --------------------------------------------------
        // k.lap counts COMPLETED laps; what a player wants is the lap they are on
        el.lap.textContent = `${Math.min(k.lap + 1, view.laps)}/${view.laps}`;

        // ---- item slot ----------------------------------------------------
        const held = k.item || 0;
        const sig = `${held}:${k.count || 0}`;
        if (el._itemSig !== sig) {
          el._itemSig = sig;
          drawItemIcon(el.itemSvg, held, k.count || 0);
          el.itemBox.classList.toggle('empty', !held);
          el.itemName.textContent = ITEM_NAME[held] || '';
        }

        // ---- speed gauge --------------------------------------------------
        const normSpeed = clamp(Math.abs(k.speed) / (k.spec.maxSpeed || KART_REF_SPEED), 0, 1);
        const circumference = 125.66;
        el.speedProgress.style.strokeDashoffset = `${circumference * (1 - normSpeed)}`;
        const kph = Math.round(kmh(k.speed));
        if (el._kph !== kph) { el._kph = kph; el.speedText.innerHTML = `${kph}<small>KM/H</small>`; }

        // ---- minimap ------------------------------------------------------
        const canvas = el.minimapCanvas;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(6,10,18,0.55)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const mm = minimapData;
        if (mm && Array.isArray(mm.xs) && mm.xs.length > 2 && Array.isArray(mm.zs)) {
          const minX = mm.minX, maxX = mm.maxX, minZ = mm.minZ, maxZ = mm.maxZ;
          const w = canvas.width - 6, h = canvas.height - 6;
          const sxOf = (x) => ((x - minX) / Math.max(1e-6, maxX - minX)) * w + 3;
          const szOf = (z) => ((z - minZ) / Math.max(1e-6, maxZ - minZ)) * h + 3;
          ctx.lineJoin = 'round';
          ctx.beginPath();
          for (let j = 0; j < mm.xs.length; j++) {
            const px = sxOf(mm.xs[j]), pz = szOf(mm.zs[j]);
            j === 0 ? ctx.moveTo(px, pz) : ctx.lineTo(px, pz);
          }
          ctx.closePath();
          ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 9; ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2; ctx.stroke();
          // start / finish tick
          const s0x = sxOf(mm.xs[0]), s0z = szOf(mm.zs[0]);
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(s0x - 4, s0z - 4); ctx.lineTo(s0x + 4, s0z + 4); ctx.stroke();
          // every racer from its real world position; this viewport's kart is the big one
          for (const r of karts) {
            if (!r.pos) continue;
            const cx = sxOf(r.pos.x), cy = szOf(r.pos.z);
            const me = r === k;
            const rr = me ? 5 : 3;
            ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
            ctx.fillStyle = rgbColor(r.spec ? r.spec.color : 0x888888);
            ctx.fill();
            if (me) {
              ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
              const hx = Math.cos(r.heading || 0), hz = Math.sin(r.heading || 0);
              ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + hx * (rr + 5), cy + hz * (rr + 5));
              ctx.stroke();
            }
          }
        }

        // ---- information block -------------------------------------------
        // This pane shows ITS OWN driver. It used to look player 1 up by id, so the bottom
        // half of the split screen showed the other player's times.
        const myBest = isFinite(k.bestLap) ? formatTime(k.bestLap) : '--:--.-';
        const laps = k.lapTimes || [];
        const myLast = laps.length ? formatTime(laps[laps.length - 1]) : '--:--.-';
        const gapTxt = k.place === 1 ? 'LEADING THE RACE' : `BEHIND LEADER  ${formatGap(k.gapToLeader || 0)}`;
        el.standings.textContent = [
          `TIME ${formatTime(view.time)}`,
          `LAST ${myLast}   BEST ${myBest}`,
          gapTxt,
        ].join('\n');

        // ---- status line -------------------------------------------------
        el.status.textContent = `phase:${phase} t:${view.time.toFixed(1)}s`;
      }
    },

    // banner(text, sub, dur) - big centre text (countdown, lap alerts)
    banner(text, sub, dur) {
      // This used to write into viewport 0's POSITION BADGE and then fade it out — which
      // destroyed the position display for player 1 after the countdown and showed nothing
      // useful in the second pane. It is now a real centred overlay in each pane.
      for (let i = 0; i < 2; i++) {
        const el = vpElements[i];
        el.banner.textContent = text || '';
        if (text && sub) {
          const s = document.createElement('span');
          s.className = 'kc-banner-sub';
          s.textContent = sub;
          el.banner.appendChild(s);
        }
        el.banner.classList.toggle('show', !!text);
        clearTimeout(el._bannerT);
        if (text) el._bannerT = setTimeout(() => el.banner.classList.remove('show'), dur || 900);
      }
    },

    // flash(color) - full-viewport colour flash
    flash(color) {
      // toggle a pseudo-element that fills the viewport
      for (let i = 0; i < 2; i++) {
        const vp = viewports[i];
        let pseudo = vp._flashPseudo;
        if (!pseudo) {
          pseudo = document.createElement('div');
          pseudo.style.position = 'absolute';
          pseudo.style.inset = '0';
          pseudo.style.background = `rgba(${color.slice(1)}, 0.4)`;
          pseudo.style.pointerEvents = 'none';
          pseudo.style.opacity = '0';
          pseudo.style.transition = 'opacity 0.1s';
          vp.appendChild(pseudo);
          vp._flashPseudo = pseudo;
        }
        pseudo.style.opacity = '1';
        setTimeout(() => { pseudo.style.opacity = '0'; }, 120);
      }
    },

    // results(rows) - designed standings panel (full-screen)
    results(rows) {
      // rows arrive in finishing order from standings(): {name, isPlayer, timeOrGap, bestLap}.
      // It used to read r.time/r.gap (which main.js never sends) and wrote the text into the
      // standings strip, where the next frame overwrote it — so the result screen showed blanks.
      const lines = ['FINAL RESULTS', ''];
      rows.forEach((r, idx) => {
        const you = r.isPlayer ? '  <= YOU' : '';
        lines.push(`${ordinal(idx + 1).padEnd(5)} ${String(r.name || '').padEnd(10)} ${String(r.timeOrGap || '').padEnd(10)} best ${r.bestLap || '--:--.-'}${you}`);
      });
      const text = lines.join('\n');
      for (let i = 0; i < 2; i++) {
        const el = vpElements[i];
        el.resultsEl.textContent = text;
        el.resultsEl.style.display = 'block';
      }
    },

    // hideResults - hide the results panel
    hideResults() {
      for (let i = 0; i < 2; i++) {
        vpElements[i].resultsEl.textContent = '';
        vpElements[i].resultsEl.style.display = 'none';
      }
    },

    // setStatus(text) - small debug/status line
    setStatus(text) {
      for (let i = 0; i < 2; i++) {
        vpElements[i].status.textContent = text;
      }
    },

    // dispose - clean up DOM events / remove elements
    dispose() {
      // remove style, viewports and all child elements
      hudRoot.remove();
      viewports.forEach(vp => vp.remove());
      style.remove();
    }
  };

  return hud;
}

// ----------------------------------------------------------------------
// tiny helper: pixel value from a percentage of dimension
function calcPos(dim, pct) {
  return `${dim * pct}px`;
}

// ----------------------------------------------------------------------
// getPointAtProgress - helper for minimap drawing (not exported)
function getPointAtProgress(minimapData, prog) {
  if (!minimapData) return null;
  const { xs, zs, minX, maxX, minZ, maxZ } = minimapData;
  const total = xs.length - 1;
  const idx = Math.min(total, Math.max(0, Math.floor(prog * total)));
  const local = prog * total - idx;
  const p0 = { x: xs[idx], z: zs[idx] };
  const p1 = { x: xs[idx + 1], z: zs[idx + 1] };
  const x = p0.x + (p1.x - p0.x) * local;
  const z = p0.z + (p1.z - p0.z) * local;
  return { x, z };
}
