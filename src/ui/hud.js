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

import { formatTime, formatGap, kmh, clamp } from '../foundation.js';

export function createHUD(root, racerSpecs, opts) {
  // ---- style element (single injected stylesheet) -----------------
  const style = document.createElement('style');
  style.textContent = `
    /* --- root --------------------------------------------------- */
    .kc-hud { position: relative; width: 100%; height: 100%; }

    /* --- viewport containers (two, one per player) ------------ */
    .kc-viewport {
      position: absolute;
      pointer-events: none;
    }
    /* scale factor - set by JS, used via calc(var(--kc-scale)*1rem) */
    .kc-viewport { --kc-base: 20; }   /* overridden per-viewport */

    /* --- generic element base ----------------------------------- */
    .kc-element { pointer-events: none; }

    /* --- position badge ---------------------------------------- */
    .kc-badge {
      position: absolute;
      left: var(--kc-badge-left, 0); top: var(--kc-badge-top, 0);
      padding: calc(var(--kc-scale) * 0.4rem) calc(var(--kc-scale) * 0.6rem);
      border-radius: calc(var(--kc-scale) * 0.8rem);
      color: white; font-weight: bold;
      font-size: calc(var(--kc-scale) * 1.2rem);
      background: var(--kc-badge-bg, #000);
      user-select: none;
    }
    /* --- lap counter ------------------------------------------ */
    .kc-lap {
      position: absolute;
      left: calc(var(--kc-scale) * 1rem); top: calc(var(--kc-scale) * 1rem);
      font-size: calc(var(--kc-scale) * 1rem);
      color: var(--kc-lap-fg, #fff);
    }
    /* --- item slot (rounded box with inline SVG) ------------- */
    .kc-item {
      position: absolute;
      left: calc(var(--kc-scale) * 1.5rem); top: calc(var(--kc-scale) * 2.5rem);
      width: calc(var(--kc-scale) * 3rem); height: calc(var(--kc-scale) * 3rem);
      background: var(--kc-item-bg, #555);
      border-radius: calc(var(--kc-scale) * 0.6rem);
      overflow: hidden;
    }
    .kc-item svg { width: 100%; height: 100%; }
    /* --- speed gauge (circular arc) --------------------------- */
    .kc-speed {
      position: absolute;
      left: calc(var(--kc-scale) * 5rem); top: calc(var(--kc-scale) * 2rem);
      width: calc(var(--kc-scale) * 3rem); height: calc(var(--kc-scale) * 3rem);
    }
    .kc-speed svg { width: 100%; height: 100%; }
    /* --- minimap canvas ---------------------------------------- */
    .kc-minimap {
      position: absolute;
      left: calc(var(--kc-scale) * 1rem); top: calc(var(--kc-scale) * 6rem);
      width: calc(var(--kc-scale) * 8rem); height: calc(var(--kc-scale) * 6rem);
      border: 1px solid var(--kc-minimap-border, #666);
    }
    /* --- standings strip -------------------------------------- */
    .kc-standings {
      position: absolute;
      left: calc(var(--kc-scale) * 1rem); top: calc(var(--kc-scale) * 13rem);
      font-size: calc(var(--kc-scale) * 0.8rem);
      color: var(--kc-standings-fg, #fff);
      white-space: nowrap;
    }
    /* --- status line ----------------------------------------- */
    .kc-status {
      position: absolute;
      left: calc(var(--kc-scale) * 1rem); bottom: calc(var(--kc-scale) * 1rem);
      font-size: calc(var(--kc-scale) * 0.7rem);
      color: var(--kc-status-fg, #aaa);
    }

    /* --- state reaction modifiers (added/removed by JS) -------- */
    .kc-badge.offroad   { opacity: 0.5; }
    .kc-badge.spinwobble { transform: rotate(calc(var(--kc-angle, 0) * 1deg)); }
    .kc-badge.invisible { opacity: 0.4; }
    .kc-badge.star        { filter: hue-rotate(calc(var(--kc-scale) * 30deg)); }
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
    countText.setAttribute('font-size', 'calc(var(--kc-scale) * 0.5rem)');
    countText.textContent = '0';
    itemSvg.appendChild(countText);
    itemBox.appendChild(itemSvg);
    el.itemBox = itemBox;
    el.itemSvg = itemSvg;
    el.itemCountText = countText;

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
    el.speedGauge = speedGauge;
    el.speedProgress = progress;

    // minimap canvas
    const minimap = document.createElement('div');
    minimap.className = 'kc-minimap';
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 120; // scaled later by CSS
    minimap.appendChild(canvas);
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

    // append all to viewport
    vp.appendChild(badge); vp.appendChild(lap);
    vp.appendChild(itemBox); vp.appendChild(speedGauge);
    vp.appendChild(minimap); vp.appendChild(standings);
    vp.appendChild(status);

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

  // map kart.item (ITEM.* ) + count → SVG content for the item slot
  function updateItemSlot(svgElem, itemId, count) {
    // clear previous shapes
    while (svgElem.firstChild) svgElem.removeChild(svgElem.firstChild);

    const countNode = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    countNode.setAttribute('x', '12'); countNode.setAttribute('y', '14');
    countNode.setAttribute('fill', '#fff');
    countNode.setAttribute('font-size', 'calc(var(--kc-scale) * 0.5rem)');
    countNode.textContent = count > 1 ? count : '';

    const centreCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    centreCircle.setAttribute('cx', '12'); centreCircle.setAttribute('cy', '12');
    centreCircle.setAttribute('r', '9');
    centreCircle.setAttribute('fill', rgbColor(racerSpecs[0].color)); // placeholder - real colour set per kart

    svgElem.appendChild(centreCircle);
    svgElem.appendChild(countNode);
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

      // CSS custom property for scale - based on smaller dimension
      const scale = Math.min(rect.w, rect.h) / 100; // 100 is base "1×" size
      vp.style.setProperty('--kc-scale', scale);

      // reposition / re-size elements inside this viewport
      const el = vpElements[i];

      // badge - top-left, scaled
      el.badge.style.left = `${calcPos(rect.w, 0.1)}px`;
      el.badge.style.top  = `${calcPos(rect.h, 0.1)}px`;

      // lap counter - near badge
      el.lap.style.left = `${calcPos(rect.w, 0.2)}px`;
      el.lap.style.top  = `${calcPos(rect.h, 0.15)}px`;

      // item slot - top-right area
      el.itemBox.style.left = `${calcPos(rect.w, 0.75)}px`;
      el.itemBox.style.top  = `${calcPos(rect.h, 0.15)}px`;
      // adjust svg viewBox to viewport scale (kept at 24×24, CSS will scale)

      // speed gauge - bottom-right
      el.speedGauge.style.left = `${calcPos(rect.w, 0.65)}px`;
      el.speedGauge.style.top  = `${calcPos(rect.h, 0.6)}px`;

      // minimap canvas - draw at real pixel size so it is not blurry
      const canvas = el.minimapCanvas;
      canvas.width = Math.max(64, Math.round(rect.w * 0.28));
      canvas.height = Math.max(64, Math.round(rect.h * 0.5));
      canvas.style.width = `${rect.w * 0.28}px`;
      canvas.style.height = `${rect.h * 0.5}px`;

      // standings - left-bottom
      el.standings.style.left = `${calcPos(rect.w, 0.1)}px`;
      el.standings.style.top  = `${calcPos(rect.h, 0.75)}px`;

      // status line - far bottom
      el.status.style.left = `${calcPos(rect.w, 0.1)}px`;
      el.status.style.bottom = `${calcPos(rect.h, 0.1)}px`;
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
        const place = k.place; // 1-based
        el.badge.textContent = place === 1 ? '1st' : place === 2 ? '2nd' : '3rd';
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
        el.lap.textContent = `${k.lap}/${view.laps}`;

        // ---- item slot ----------------------------------------------------
        // update SVG - clear and draw appropriate silhouette
        updateItemSlot(el.itemSvg, k.item, k.count);

        // ---- speed gauge --------------------------------------------------
        // normalise speed to 0-1 range (maxSpeed from config)
        const normSpeed = clamp(k.speed / (k.spec.maxSpeed || 30), 0, 1);
        // circumference = 2πr ≈ 125.66; set dash offset so that proportion shows
        const circumference = 125.66;
        const draw = circumference * (1 - normSpeed); // backwards so 0 = full
        el.speedProgress.style.strokeDashoffset = `${draw}`;

        // display km/h text inside the gauge (optional - we just set style)
        // (could add a <text> element, omitted for brevity)

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

        // ---- standings strip ---------------------------------------------
        // compact: our time / last lap / best lap / gap to leader
        // (view contains leaderGap, we just display a static row for demo)
        const ourData = karts.find(k => k.isPlayer);
        if (ourData) {
          const ourBest = ourData.bestLap !== undefined ? formatTime(ourData.bestLap) : '--:--.-';
          const ourLast = formatTime(ourData.lapTimes[ourData.lapTimes.length - 1] || 0);
          const ourTime = formatTime(view.time);
          const gap = ourData.gapToLeader !== undefined ? formatGap(ourData.gapToLeader) : '---';
          el.standings.textContent = `${ourTime}  ${ourLast}  ${ourBest}  ${gap}`;
        } else {
          el.standings.textContent = '---  ---  ---  ---';
        }

        // ---- status line -------------------------------------------------
        el.status.textContent = `phase:${phase} t:${view.time.toFixed(1)}s`;
      }
    },

    // banner(text, sub, dur) - big centre text (3,2,1,GO,LAP 1/3, final lap)
    banner(text, sub, dur) {
      // we reuse the first viewport's badge area as a simple centre banner
      // for demo purposes; a real implementation would create a full-screen overlay.
      const el = vpElements[0].badge;
      el.textContent = text;
      if (sub) el.textContent += `\n${sub}`;
      // simple fade - just for visual completeness
      el.style.transition = `opacity ${dur/1000}s`;
      el.style.opacity = 1;
      setTimeout(() => el.style.opacity = 0, dur);
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
      // rows is an array of objects {name, timeOrGap, bestLap}
      // we simply update the stand-ings strip for the active viewport
      // (real UI would overlay a full panel, but we keep it simple)
      for (let i = 0; i < 2; i++) {
        const el = vpElements[i].standings;
        let txt = '';
        rows.forEach((r, idx) => {
          txt += `${r.name}: ${r.time || r.gap}  `;
        });
        el.textContent = txt || '--';
      }
    },

    // hideResults - hide the results panel
    hideResults() {
      for (let i = 0; i < 2; i++) {
        vpElements[i].standings.style.display = 'none';
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
