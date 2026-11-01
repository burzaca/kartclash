/* cameraRig.js — chase-camera math for one or more split-screen viewports. (PM-owned)
 * Receives THREE as a parameter so the math can be probed headlessly (see tools/probe-camera.js):
 * what matters is not "does it look nice" but "is the local kart inside its half of the screen,
 * at a sane size, with the road ahead in frame" — all of which are computable from the matrices. */
import { CAM, KART } from '../config.js';
import { clamp, damp, lerp } from '../foundation.js';

const KARTREF = KART.maxSpeed;

export function createCameraRig(THREE) {
  const rig = {
    cams: [],
    states: [],

    addCamera() {
      const cam = new THREE.PerspectiveCamera(CAM.fov, 1, CAM.near, CAM.far);
      rig.cams.push(cam);
      rig.states.push({ pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false, shake: 0, fov: CAM.fov });
      return cam;
    },

    reset() { rig.cams.length = 0; rig.states.length = 0; },

    // One camera per viewport, each following the kart named by kartIds[i].
    // `vp` gives that camera's aspect + whether it is a half-height (split) view.
    update(dt, karts, track, kartIds, vps) {
      for (let i = 0; i < rig.cams.length; i++) {
        const k = karts.find((c) => c.id === (kartIds[i] ?? i));
        if (!k) continue;
        const cam = rig.cams[i], st = rig.states[i];

        const fx = Math.cos(k.heading), fz = Math.sin(k.heading);
        const spd = clamp(Math.abs(k.speed) / KARTREF, 0, 1);

        // Chase distance grows with speed: close and low when slow, back and high when fast.
        // That is what makes speed readable on screen; it is the single most important feel knob.
        const back = CAM.back + spd * 3.2 + (k.boost.time > 0 ? 1.2 : 0);
        const up = CAM.up + spd * 0.9;
        const px = k.pos.x - fx * back, pz = k.pos.z - fz * back;
        const py = track.surfaceY(px, pz) + up + k.air.y * 0.55;
        const lx = k.pos.x + fx * CAM.lead, lz = k.pos.z + fz * CAM.lead;
        const ly = k.pos.y + 1.2 + k.air.y * 0.4;

        if (!st.init) { st.pos.set(px, py, pz); st.look.set(lx, ly, lz); st.init = true; }
        const rate = CAM.followRate;
        st.pos.x = damp(st.pos.x, px, rate, dt);
        st.pos.y = damp(st.pos.y, py, rate * 1.3, dt);
        st.pos.z = damp(st.pos.z, pz, rate, dt);
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
      else P(-CAM.back, CAM.up, 0, CAM.lead, 1.2, 0);
      cam.position.copy(st.pos);
      cam.lookAt(st.look);
      cam.fov = CAM.fov;
      cam.updateProjectionMatrix();
      return cam;
    },
  };
  return rig;
}
