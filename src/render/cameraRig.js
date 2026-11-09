/* cameraRig.js — chase-camera math for one or more split-screen viewports. (PM-owned)
 * Receives THREE as a parameter so the math can be probed headlessly (see tools/probe-camera.js):
 * what matters is not "does it look nice" but "is the local kart inside its half of the screen,
 * at a sane size, with the road ahead in frame" — all of which are computable from the matrices. */
import { CAM, KART } from '../config.js';
import { clamp, damp, lerp } from '../foundation.js';

const KARTREF = KART.maxSpeed;

export function createCameraRig(THREE) {
  // The chase distance is the one camera number players disagree about, so it is a setting —
  // and per-player now: each viewport chases with its OWN preset (P1 presses C, P2 presses M).
  let presetFor = [];
  let poseFor = [];
  let defaultPreset = 'normal';   // inherited by cameras created after setPreset (stored prefs)
  const resolvePose = (name) => {
    const p = (CAM.presets || {})[name];
    return p ? { back: p.back, up: p.up, lead: p.lead } : { back: CAM.back, up: CAM.up, lead: CAM.lead };
  };

  const rig = {
    cams: [],
    states: [],

    setPreset(name) {
      const valid = CAM.presets && CAM.presets[name] ? name : 'normal';
      defaultPreset = valid;
      for (let i = 0; i < rig.cams.length; i++) rig.setPresetFor(i, valid);
      return valid;
    },
    setPresetFor(i, name) {
      const valid = CAM.presets && CAM.presets[name] ? name : 'normal';
      presetFor[i] = valid; poseFor[i] = resolvePose(valid);
      return valid;
    },
    presetName(i = 0) { return presetFor[i] || 'normal'; },
    nextPreset(i = 0) { return rig.nextPresetFor(i); },
    nextPresetFor(i) {
      const order = CAM.presetOrder || ['normal'];
      const next = order[(order.indexOf(rig.presetName(i)) + 1) % order.length];
      rig.setPresetFor(i, next);
      return next;
    },
    presetLabel(name) {
      const labels = { close: 'CLOSE (behind the kart)', normal: 'NORMAL', far: 'FAR (see more of the track)' };
      return labels[name] || name;
    },

    addCamera() {
      const cam = new THREE.PerspectiveCamera(CAM.fov, 1, CAM.near, CAM.far);
      rig.cams.push(cam);
      if (!poseFor[rig.cams.length - 1]) rig.setPresetFor(rig.cams.length - 1, defaultPreset);
      rig.states.push({ pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false, shake: 0, fov: CAM.fov, yaw: 0, h: 0 });
      return cam;
    },

    reset() { rig.cams.length = 0; rig.states.length = 0; presetFor = []; poseFor = []; },

    // One camera per viewport, each following the kart named by kartIds[i].
    // `vp` gives that camera's aspect + whether it is a half-height (split) view.
    update(dt, karts, track, kartIds, vps) {
      for (let i = 0; i < rig.cams.length; i++) {
        const k = karts.find((c) => c.id === (kartIds[i] ?? i));
        if (!k) continue;
        const cam = rig.cams[i], st = rig.states[i], pose = poseFor[i];
        const spd = clamp(Math.abs(k.speed) / KARTREF, 0, 1);

        // Yaw-smoothed RIGID follow: the camera sits at an EXACT chase distance behind a
        // smoothed heading. Position damping (the old design) lagged behind the kart by
        // speed/rate — metres at racing speed — and players read exactly that as "the
        // camera falls back at speed". Smoothing the heading keeps turns cinematic with
        // zero distance lag. Enforced by tools/probe-camera.js.
        if (!st.init) { st.yaw = k.heading; st.h = k.pos.y + pose.up; st.look.set(k.pos.x, k.pos.y + 1.2, k.pos.z); st.init = true; }
        let arc = k.heading - st.yaw;
        while (arc > Math.PI) arc -= 2 * Math.PI;
        while (arc < -Math.PI) arc += 2 * Math.PI;
        st.yaw += arc * (1 - Math.exp(-CAM.yawRate * dt));
        const fx = Math.cos(st.yaw), fz = Math.sin(st.yaw);

        // Distance stays near-constant at any speed (player ask); pulls are deliberately tiny.
        // A kart that was just rammed or spun is momentarily slow right in front of the camera —
        // without a pull this reads as 'the kart fills the screen' (probe --cam=close, 38.4%, 2026-11-09).
        const hit = k.hitFlash > 0 || k.spin > 0 ? CAM.hitPull : 0;
        // crawling (after a wall, mid-air landing, any near-stop): back off so the kart never
        // fills the frame while it is barely moving — framing is about SPEED, not distance drift
        const crawl = Math.max(0, 1 - Math.abs(k.speed) / CAM.crawlSpeed) * CAM.crawlPull;
        const back = pose.back + spd * CAM.speedPull + (k.boost.time > 0 ? CAM.boostPull : 0) + hit + crawl;
        const up = pose.up + spd * CAM.upPull;
        const px = k.pos.x - fx * back, pz = k.pos.z - fz * back;
        const wantH = track.surfaceY(px, pz) + up + k.air.y * 0.55;
        st.h = damp(st.h, wantH, 6, dt);          // only height is smoothed (terrain bumps)
        st.pos.set(px, st.h, pz);

        const lx = k.pos.x + fx * pose.lead, lz = k.pos.z + fz * pose.lead;
        const ly = k.pos.y + 1.2 + k.air.y * 0.4;
        const rate = CAM.followRate;
        st.look.x = damp(st.look.x, lx, rate * 1.6, dt);
        st.look.y = damp(st.look.y, ly, rate * 1.6, dt);
        st.look.z = damp(st.look.z, lz, rate * 1.6, dt);

        st.shake = Math.max(0, st.shake - dt * CAM.shakeDecay);
        if (k.fx.shake > 0) { st.shake = Math.max(st.shake, k.fx.shake); k.fx.shake = 0; }
        if (st.shake > 0) {
          const s = st.shake * 0.35;
          st.pos.x += (Math.random() - 0.5) * s;
          st.pos.y += (Math.random() - 0.5) * s;
        }

        // Speed kick: the field widens and the fov opens up under boost.
        const wantFov = lerp(CAM.fov, CAM.fovBoost, clamp(spd * CAM.fovSpeed + (k.boost.time > 0 ? 0.55 : 0), 0, 1));
        st.fov = damp(st.fov, wantFov, 3, dt);

        cam.position.set(st.pos.x, st.pos.y, st.pos.z);
        cam.lookAt(st.look.x, st.look.y, st.look.z);
        cam.fov = st.fov;
        cam.userData.fov = st.fov;
        if (vps && vps[i]) cam.aspect = vps[i].w / Math.max(1, vps[i].h);
        cam.updateProjectionMatrix();
      }
    },

    // Named review poses for screenshots; derived from the live pose of a kart.
    fixedShot(kart, name) {
      const cam = rig.cams[0] || rig.addCamera();
      const st = rig.states[0];
      const fx = Math.cos(kart.heading), fz = Math.sin(kart.heading);
      const P = (ox, oy, oz, lx = 0, ly = 1, lz = 0) => {
        st.pos.set(kart.pos.x + fx * ox - fz * oz, kart.pos.y + oy, kart.pos.z + fz * ox + fx * oz);
        st.look.set(kart.pos.x + fx * lx - fz * lz, kart.pos.y + ly, kart.pos.z + fx * lx + fz * lz);
      };
      if (name === 'kart') P(-4.5, 2.0, 3.2, -1.5, 0.8, 1.0);
      else if (name === 'front') P(5.5, 1.6, 0, -4, 0.8, 0);
      else if (name === 'aerial') P(-14, 30, 0, 0, 0, 6);
      else if (name === 'drift') P(-6.5, 2.4, 5.5, -2, 0.6, 2);
      else P(-pose.back, pose.up, 0, pose.lead, 1.2, 0);
      cam.position.copy(st.pos);
      cam.lookAt(st.look);
      cam.fov = CAM.fov;
      cam.updateProjectionMatrix();
      return cam;
    },
  };
  return rig;
}
