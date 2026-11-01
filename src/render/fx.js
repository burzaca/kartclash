// fx.js — pooled particle system (one InstancedMesh per effect type, free lists, zero allocation
// in update). Additive glow for boosts/sparks/hits, opaque for dust and confetti.
// API per docs/INTERFACES.md §4: burst / trail / ring / confetti / update / reset / dispose.
//
// PM note: rewritten during integration. The first version indexed instanceMatrix with .at(idx)
// (not a three.js API) and never wrote matrices back, left instanceColor null, kept every mesh
// visible=false, and did not track particle positions at all — particles could not move or render.
// Position/velocity now live in the state arrays and each frame composes the instance matrix.

const POOL = 1500;

export function createFX(THREE, scene) {
  const tmpMat = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpScl = new THREE.Vector3(1, 1, 1);
  const tmpEuler = new THREE.Euler();
  const tmpCol = new THREE.Color();

  function makePool(geo, opts) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: opts.opacity ?? 1,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, POOL);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, tmpCol.setRGB(1, 1, 1));   // allocates instanceColor
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    tmpMat.makeScale(0, 0, 0);                     // every instance hidden until spawned
    for (let i = 0; i < POOL; i++) mesh.setMatrixAt(i, tmpMat);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false; mesh.receiveShadow = false;
    scene.add(mesh);

    const state = new Array(POOL);
    for (let i = 0; i < POOL; i++) {
      state[i] = {
        life: 0, age: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
        size: 1, r0: 0, r1: 0, rx: 0, ry: 0, rz: 0, spin: 0,
        r: 1, g: 1, b: 1, fade: 1, grav: 0, drag: 0,
      };
    }
    return {
      mesh, mat, state,
      free: Array.from({ length: POOL }, (_, i) => POOL - 1 - i),
      active: [],
      kind: opts.kind,
    };
  }

  const burstGeo = new THREE.IcosahedronGeometry(1, 1);            // scaled per instance
  const trailGeo = new THREE.IcosahedronGeometry(1, 0);
  const ringGeo = new THREE.TorusGeometry(1, 0.09, 10, 48);
  ringGeo.rotateX(-Math.PI / 2);                                   // lie flat on the ground
  const confettiGeo = new THREE.BoxGeometry(1, 1, 1);

  const burst = makePool(burstGeo, { additive: true, kind: 'burst' });
  const trail = makePool(trailGeo, { additive: true, kind: 'trail' });
  const ring = makePool(ringGeo, { additive: true, kind: 'ring' });
  const confetti = makePool(confettiGeo, { additive: false, kind: 'confetti' });

  function take(p) {
    if (p.free.length === 0) return -1;
    const i = p.free.pop();
    p.active.push(i);
    return i;
  }
  function release(p, i) {
    const at = p.active.indexOf(i);
    if (at >= 0) { p.active[at] = p.active[p.active.length - 1]; p.active.pop(); }
    p.free.push(i);
    p.state[i].life = 0;
    tmpMat.makeScale(0, 0, 0);
    p.mesh.setMatrixAt(i, tmpMat);
  }
  function tint(s, hex) { tmpCol.setHex(hex); s.r = tmpCol.r; s.g = tmpCol.g; s.b = tmpCol.b; }
  function write(p, i, s, scale, spinX = 0, spinY = 0, spinZ = 0) {
    tmpPos.set(s.px, s.py, s.pz);
    tmpEuler.set(spinX, spinY, spinZ);
    tmpQuat.setFromEuler(tmpEuler);
    tmpScl.setScalar(Math.max(0, scale));
    tmpMat.compose(tmpPos, tmpQuat, tmpScl);
    p.mesh.setMatrixAt(i, tmpMat);
    const f = s.fade;
    p.mesh.setColorAt(i, tmpCol.setRGB(s.r * f, s.g * f, s.b * f));
  }

  // ---------------------------------------------------------------- spawn
  function burstSpawn(x, y, z, { color = 0xffffff, count = 12, speed = 6, life = 0.6, size = 0.35, gravity = -8, spread = 1 } = {}) {
    for (let n = 0; n < count; n++) {
      const i = take(burst);
      if (i < 0) return;
      const s = burst.state[i];
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = speed * (0.75 + Math.random() * 0.5);
      const dx = Math.sin(phi) * Math.cos(theta), dy = Math.cos(phi), dz = Math.sin(phi) * Math.sin(theta);
      s.px = x + dx * 0.15 * spread; s.py = y + dy * 0.15 * spread; s.pz = z + dz * 0.15 * spread;
      s.vx = dx * sp; s.vy = dy * sp; s.vz = dz * sp;
      s.size = size * (0.55 + Math.random() * 0.5);
      s.life = life * (0.8 + Math.random() * 0.4);
      s.age = 0; s.grav = gravity; s.drag = 1.6; s.fade = 1;
      tint(s, color);
      write(burst, i, s, s.size);
    }
  }

  function trailSpawn(x, y, z, { color = 0xffff00, life = 0.35, size = 0.3, vx = 0, vy = 0, vz = 0 } = {}) {
    const i = take(trail);
    if (i < 0) return;
    const s = trail.state[i];
    s.px = x; s.py = y; s.pz = z;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.size = size * (0.8 + Math.random() * 0.4);
    s.life = life; s.age = 0; s.grav = -1.5; s.drag = 2.2; s.fade = 1;
    tint(s, color);
    write(trail, i, s, s.size);
  }

  function ringSpawn(x, y, z, { color = 0xffd700, r0 = 0.5, r1 = 4, life = 0.5 } = {}) {
    const i = take(ring);
    if (i < 0) return;
    const s = ring.state[i];
    s.px = x; s.py = y; s.pz = z;
    s.r0 = r0; s.r1 = r1; s.life = life; s.age = 0; s.grav = 0; s.drag = 0; s.fade = 1;
    tint(s, color);
    write(ring, i, s, r0);
  }

  function confettiSpawn(x, y, z, count = 30) {
    for (let n = 0; n < count; n++) {
      const i = take(confetti);
      if (i < 0) return;
      const s = confetti.state[i];
      const a = Math.random() * Math.PI * 2;
      s.px = x + Math.cos(a) * Math.random() * 1.2;
      s.py = y + Math.random() * 0.6;
      s.pz = z + Math.sin(a) * Math.random() * 1.2;
      s.vx = Math.cos(a) * (1.5 + Math.random() * 2.5);
      s.vy = 3.5 + Math.random() * 3.5;
      s.vz = Math.sin(a) * (1.5 + Math.random() * 2.5);
      s.size = 0.07 + Math.random() * 0.05;
      s.life = 1.6 + Math.random() * 1.2;
      s.age = 0; s.grav = -9.5; s.drag = 0.4; s.fade = 1;
      s.rx = Math.random() * 6; s.ry = Math.random() * 6; s.rz = Math.random() * 6;
      s.spin = 4 + Math.random() * 8;
      tmpCol.setHSL(Math.random(), 0.85, 0.55);
      s.r = tmpCol.r; s.g = tmpCol.g; s.b = tmpCol.b;
      write(confetti, i, s, s.size, s.rx, s.ry, s.rz);
    }
  }

  // ---------------------------------------------------------------- step
  function stepPool(p, dt) {
    const arr = p.active;
    if (arr.length === 0) return;
    for (let n = arr.length - 1; n >= 0; n--) {
      const i = arr[n];
      const s = p.state[i];
      s.age += dt;
      if (s.age >= s.life) { release(p, i); continue; }
      const t = s.age / s.life;

      s.vy += s.grav * dt;
      const d = Math.max(0, 1 - s.drag * dt);
      s.vx *= d; s.vz *= d; s.vy *= d;
      s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;

      let scale;
      if (p.kind === 'ring') {
        scale = s.r0 + (s.r1 - s.r0) * Math.min(1, t * 1.25);
        s.fade = Math.max(0, 1 - t);
      } else if (p.kind === 'confetti') {
        scale = s.size;
        s.rx += s.spin * dt; s.ry += s.spin * 0.7 * dt; s.rz += s.spin * 0.4 * dt;
        s.fade = t > 0.65 ? (1 - t) / 0.35 : 1;
        write(p, i, s, scale, s.rx, s.ry, s.rz);
        continue;
      } else {
        scale = s.size * (1 - t * (p.kind === 'trail' ? 0.85 : 0.55));
        s.fade = 1 - t;
      }
      write(p, i, s, scale);
    }
    p.mesh.instanceMatrix.needsUpdate = true;
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  }

  function update(dt) {
    stepPool(burst, dt);
    stepPool(trail, dt);
    stepPool(ring, dt);
    stepPool(confetti, dt);
  }

  function resetPool(p) {
    for (const i of p.active) { p.state[i].life = 0; tmpMat.makeScale(0, 0, 0); p.mesh.setMatrixAt(i, tmpMat); }
    p.active.length = 0;
    p.free = Array.from({ length: POOL }, (_, i) => POOL - 1 - i);
    p.mesh.instanceMatrix.needsUpdate = true;
  }
  function reset() { resetPool(burst); resetPool(trail); resetPool(ring); resetPool(confetti); }

  function dispose() {
    for (const p of [burst, trail, ring, confetti]) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
      p.mesh.dispose();
    }
  }

  return {
    burst: burstSpawn, trail: trailSpawn, ring: ringSpawn, confetti: confettiSpawn,
    update, reset, dispose,
    counts: () => ({ burst: burst.active.length, trail: trail.active.length, ring: ring.active.length, confetti: confetti.active.length }),
    pools: { burst, trail, ring, confetti },
  };
}
