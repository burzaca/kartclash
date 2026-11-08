// kartModel.js — kart/driver model builder + per-frame updater
// All parts face local +Z (nose/driver face forward). Orientation is fixed:
//   group.rotation.y = Math.PI / 2 - kart.heading
// so a world-forward vector (cos h, 0, sin h) maps to local +Z.
// No flatShading anywhere; high segment counts; all parts cast/receive shadow.
// kart within ~2.2 m radius, ~1.6 m tall.

// ===================================================================== GLB go-kart (v3 §9)
// One CC0 kart (pixor.art), vendored; every racer gets its own repainted clone.
const KART_GLB = '../../vendor/assets/karts/pixor.glb';
// Longest horizontal extent. §9 asked 2.05 (lathe length), but pixor is narrower (w/l 0.70 vs the
// lathe's 0.91): at 2.05 the chase cam read it 18-25% vs the lathe's 21-29%. 2.35 measured back to parity.
export const KART_LEN = 2.35;
export const DRIVER_H = 1.15;   // driver's total height (matches the old kart silhouette)
let kartCache = null, kartLoading = null;

// Which body the next kart will get — surfaced in the corner stamp so a player and I can
// agree on whether the GLB actually loaded on their machine.
export function modelSource() { return kartCache ? 'glb' : 'lathe'; }

// Parsed material name -> spec colour, or null to keep the parsed colour (Dark iron, Rubber).
export function repaintFor(name, spec) {
  return name === 'Green paint' ? spec.color : name === 'Steel' ? spec.trim : null;
}

// Measured box -> uniform scale (longest horizontal side = len) and the offset (scaled frame)
// that centres it on x/z and puts its lowest point on y=0.
export function fitTransform(min, max, len = KART_LEN) {
  const s = len / Math.max(max.x - min.x, max.z - min.z);
  return { scale: s, offset: { x: -(min.x + max.x) / 2 * s, y: -min.y * s, z: -(min.z + max.z) / 2 * s } };
}

// Driver box height -> scale to h; position that puts his pelvis point (driver frame) on the seat point.
export function seatTransform(minY, maxY, pelvis, seat, h = DRIVER_H) {
  const s = h / (maxY - minY);
  return { scale: s, position: { x: seat.x - pelvis.x * s, y: seat.y - pelvis.y * s, z: seat.z - pelvis.z * s } };
}

// Fetch + parse the GLB once (browser: same-origin vendored file). main.js kicks this off before
// building karts; buildKartModel falls back to the lathe kart while it is unresolved or failed.
export function loadKartModels(THREE, fetchImpl = globalThis.fetch) {
  if (kartCache) return Promise.resolve(kartCache);
  if (kartLoading) return kartLoading;
  kartLoading = (async () => {
    const { GLTFLoader } = await import('../../vendor/addons/GLTFLoader.js');
    const r = await fetchImpl(new URL(KART_GLB, import.meta.url).href);
    if (!r.ok) throw new Error(`kart asset: HTTP ${r.status}`);
    const gltf = await new GLTFLoader().parseAsync(await r.arrayBuffer(), '');
    return (kartCache = gltf.scene);
  })().catch((e) => { kartLoading = null; throw e; });
  return kartLoading;
}

// Each Kart_wheels_* node is one mesh holding BOTH wheels of an axle: split it per side into a
// steer pivot (at that wheel's centre) + spinner, so the pair can steer and roll about the axle.
function splitWheels(THREE, kart) {
  const wheels = [], spinners = [];
  for (const name of ['Kart_wheels_front', 'Kart_wheels_back']) {
    const grp = kart.getObjectByName(name);
    if (!grp) continue;
    const meshes = [];
    grp.traverse((o) => { if (o.isMesh) meshes.push(o); });
    grp.updateMatrixWorld(true);
    const toGrp = new THREE.Matrix4().copy(grp.matrixWorld).invert();
    for (const side of [-1, 1]) {
      const halves = meshes.map((m) => {
        const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(toGrp, m.matrixWorld));
        const idx = g.index.array, x = g.attributes.position, keep = [];   // shortcut: assumes indexed geometry (pixor.glb is), add a toNonIndexed path for other kart files
        for (let t = 0; t < idx.length; t += 3) if ((x.getX(idx[t]) + x.getX(idx[t + 1]) + x.getX(idx[t + 2])) * side > 0) keep.push(idx[t], idx[t + 1], idx[t + 2]);
        const half = new THREE.Mesh(g.setIndex(keep).toNonIndexed(), m.material);
        half.geometry.computeBoundingBox();
        half.castShadow = true; half.receiveShadow = true;
        return half;
      });
      const box = new THREE.Box3();
      for (const h of halves) box.union(h.geometry.boundingBox);
      const c = box.getCenter(new THREE.Vector3());
      const pivot = new THREE.Group(), spinner = new THREE.Group();
      pivot.position.copy(c);
      pivot.userData.front = name === 'Kart_wheels_front';
      pivot.userData.yaw = 0;
      for (const h of halves) { h.geometry.translate(-c.x, -c.y, -c.z); spinner.add(h); }
      pivot.add(spinner); grp.add(pivot);
      wheels.push(pivot); spinners.push(spinner);
    }
    for (const m of meshes) m.removeFromParent();
  }
  return { wheels, spinners };
}

function buildGlbKart(THREE, spec, scene) {
  const group = new THREE.Group();
  group.userData.three = THREE;
  const rig = new THREE.Group(), kart = scene.clone(true), paint = [];
  kart.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();   // own materials per racer
    const c = repaintFor(o.material.name, spec);
    if (c != null) o.material.color.set(c);
    if (o.material.name === 'Green paint') paint.push(o.material);
    o.castShadow = true; o.receiveShadow = true;
  });
  const { wheels, spinners } = splitWheels(THREE, kart);
  rig.add(kart); group.add(rig);

  kart.updateMatrixWorld(true);
  const kb = new THREE.Box3().setFromObject(kart), fit = fitTransform(kb.min, kb.max);
  kart.scale.setScalar(fit.scale);
  kart.position.set(fit.offset.x, fit.offset.y, fit.offset.z);
  group.updateMatrixWorld(true);

  // driver: hips on the seat's top face, scaled to DRIVER_H (measured, not guessed)
  const { driver, helmet, visor, legs } = buildDriver(THREE, spec);
  driver.updateMatrixWorld(true);
  const db = new THREE.Box3().setFromObject(driver), lb = new THREE.Box3();
  for (const l of legs) lb.union(new THREE.Box3().setFromObject(l));
  const seatObj = kart.getObjectByName('Kart_seat');
  const sb = seatObj ? new THREE.Box3().setFromObject(seatObj) : kb.clone().applyMatrix4(kart.matrixWorld);
  const lc = lb.getCenter(new THREE.Vector3()), sc = sb.getCenter(new THREE.Vector3());
  const st = seatTransform(db.min.y, db.max.y, { x: lc.x, y: lb.max.y, z: lc.z }, { x: sc.x, y: sb.max.y, z: sc.z });
  driver.scale.setScalar(st.scale);
  driver.position.set(st.position.x, st.position.y, st.position.z);
  rig.add(driver);

  group.userData.parts = { body: kart, chassis: null, wheels, wheelSpinners: spinners, spinAxis: 'x',
    driver, helmet, visor, exhaust: [], flame: [], shield: null, spark: null, shadowBlob: null,
    rig, paint, model: 'pixor', fit: fit.scale };
  return group;
}

// Turbo flame look: drift tier colours, length 0.4 + tier*0.5 m, full length while boosting.
export const FLAME_COLORS = [0x35a7ff, 0xff9a1f, 0xff3bd4];
export function flameLook(kart, boostTier = 1) {
  const t = kart.drift.on && kart.drift.tier >= 0 ? Math.min(2, kart.drift.tier) : -1;
  if (kart.boost.time > 0) return { on: true, len: 1.4, tier: t >= 0 ? t : boostTier };
  if (t >= 0) return { on: true, len: 0.4 + t * 0.5, tier: t };
  return { on: false, len: 0, tier: -1 };
}

// Effect parts (shield, turbo flames, spark, airborne shadow) sized from the measured body box.
function addEffects(THREE, group) {
  const parts = group.userData.parts;
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(parts.rig), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());

  const shield = new THREE.Mesh(new THREE.SphereGeometry(0.5 * Math.hypot(size.x, size.z) * 0.85, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0xffff00, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0, emissive: 0xffff00, emissiveIntensity: 0 }));
  shield.position.copy(mid); shield.visible = false;
  group.add(shield); parts.shield = shield;

  // turbo flames: unit-length additive cones pointing -Z (scale.z = length), white-hot inner core
  const additive = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flameGeo = new THREE.ConeGeometry(0.2, 1, 16).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
  for (const side of [-1, 1]) {
    const flame = new THREE.Mesh(flameGeo, additive(FLAME_COLORS[0], 0.85));
    const core = new THREE.Mesh(flameGeo, additive(0xffffff, 0.7));
    core.scale.set(0.45, 0.45, 0.6);
    flame.add(core);
    flame.position.set(side * size.x * 0.28, box.min.y + Math.min(0.45, size.y * 0.3), box.min.z + 0.05);
    flame.visible = false;
    group.add(flame); parts.flame.push(flame);
  }

  const spark = new THREE.Mesh(new THREE.IcosahedronGeometry(0.10, 2), new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.1, metalness: 0.5, transparent: true, opacity: 0.7, emissive: 0xffffff, emissiveIntensity: 2.0 }));
  spark.position.set(0, 0.1, box.min.z); spark.visible = false;
  group.add(spark); parts.spark = spark;

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.5, 24), new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.3, transparent: true }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.02, 0);
  shadow.scale.setScalar(Math.max(0.2, Math.min(1.2, size.x / 3.0)));
  shadow.userData.base = shadow.scale.x;
  shadow.visible = false;
  group.add(shadow); parts.shadowBlob = shadow;
  return group;
}

// idx kept for API compatibility (one model for all racers). Lathe kart until/unless the GLB loads.
export function buildKartModel(THREE, spec, idx) {
  return addEffects(THREE, kartCache ? buildGlbKart(THREE, spec, kartCache) : buildLatheKart(THREE, spec));
}

// Driver (torso, arms, legs, belts, helmet, visor) — shared by the lathe and GLB karts.
// Returns the legs too: the GLB kart seats him by his hips (top of the legs).
function buildDriver(THREE, spec) {
  const { trim, skin, helmet } = spec;
  const matTrim = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.5, metalness: 0.5 });
  const matSkin = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7, metalness: 0.2 });
  const matHelmet = new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.3, metalness: 0.1 });
  const legs = [];
  const driverGroup = new THREE.Group();

  // Torso lathe profile
  const torsoPoints = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    torsoPoints.push(new THREE.Vector2(0.62 * (1 - t * 0.30), 1.25 * (1 - t * 0.40)));
  }
  const torsoGeo = new THREE.LatheGeometry(torsoPoints, 24);
  const torsoMesh = new THREE.Mesh(torsoGeo, matSkin);
  torsoMesh.castShadow = true;
  torsoMesh.receiveShadow = true;
  torsoMesh.position.set(0, 0.65, 0.75);
  driverGroup.add(torsoMesh);

  // Arms at sides
  for (let side of [-1, 1]) {
    const armGroup = new THREE.Group();
    armGroup.position.set(side * 0.36, 0.42, 0.85);

    const uaGeo = new THREE.BoxGeometry(0.11, 0.46, 0.11);
    const uaMesh = new THREE.Mesh(uaGeo, matSkin);
    uaMesh.castShadow = true;
    uaMesh.receiveShadow = true;
    armGroup.add(uaMesh);

    const elbowGeo = new THREE.SphereGeometry(0.13, 16, 16);
    const elbowMesh = new THREE.Mesh(elbowGeo, matSkin);
    elbowMesh.position.set(0, -0.46, 0);
    elbowMesh.castShadow = true;
    elbowMesh.receiveShadow = true;
    armGroup.add(elbowMesh);

    const laGeo = new THREE.BoxGeometry(0.09, 0.42, 0.09);
    const laMesh = new THREE.Mesh(laGeo, matSkin);
    laMesh.position.set(0, -0.42, 0);
    laMesh.castShadow = true;
    laMesh.receiveShadow = true;
    armGroup.add(laMesh);

    driverGroup.add(armGroup);
  }

  // Legs onto footwell
  for (let side of [-1, 1]) {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * 0.26, 0.22, 1.05);

    const thighGeo = new THREE.BoxGeometry(0.13, 0.56, 0.13);
    const thighMesh = new THREE.Mesh(thighGeo, matSkin);
    thighMesh.castShadow = true;
    thighMesh.receiveShadow = true;
    legGroup.add(thighMesh);

    const kneeGeo = new THREE.SphereGeometry(0.15, 16, 16);
    const kneeMesh = new THREE.Mesh(kneeGeo, matSkin);
    kneeMesh.position.set(0, -0.56, 0);
    kneeMesh.castShadow = true;
    kneeMesh.receiveShadow = true;
    legGroup.add(kneeMesh);

    const shinGeo = new THREE.BoxGeometry(0.11, 0.52, 0.11);
    const shinMesh = new THREE.Mesh(shinGeo, matSkin);
    shinMesh.position.set(0, -0.52, 0);
    shinMesh.castShadow = true;
    shinMesh.receiveShadow = true;
    legGroup.add(shinMesh);

    driverGroup.add(legGroup);
    legs.push(legGroup);
  }

  // Seat belt straps (trim-colour boxes over torso)
  for (let side of [-1, 1]) {
    const beltGeo = new THREE.BoxGeometry(0.06, 0.9, 0.05);
    const beltMesh = new THREE.Mesh(beltGeo, matTrim);
    beltMesh.castShadow = true;
    beltMesh.receiveShadow = true;
    beltMesh.position.set(side * 0.14, 0.65, 0.75);
    driverGroup.add(beltMesh);
  }

  // Helmet: curved lathe profile
  const helmetPoints = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    helmetPoints.push(new THREE.Vector2(0.96 * (1 - t * 0.18), 1.05 + t * 0.25));
  }
  const helmetGeo = new THREE.LatheGeometry(helmetPoints, 24);
  const helmetMesh = new THREE.Mesh(helmetGeo, matHelmet);
  helmetMesh.castShadow = true;
  helmetMesh.receiveShadow = true;
  helmetMesh.position.set(0, 0.72, 0.95);
  driverGroup.add(helmetMesh);

  // Visor stripe: flat plane across face (trim colour)
  const visorGeo = new THREE.PlaneGeometry(1.10, 0.09);
  const visorMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.4, metalness: 0.3 });
  const visorMesh = new THREE.Mesh(visorGeo, visorMat);
  visorMesh.castShadow = true;
  visorMesh.receiveShadow = true;
  visorMesh.position.set(0, 0.67, 1.02);
  visorMesh.rotation.x = -0.18;
  driverGroup.add(visorMesh);

  return { driver: driverGroup, helmet: helmetMesh, visor: visorMesh, legs };
}

function buildLatheKart(THREE, spec) {
  const group = new THREE.Group();
  group.userData.three = THREE;   // updateKartModel has no THREE parameter (see INTERFACES §4)

  const { color, trim } = spec;
  const matBody = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.4 });
  const matTrim = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.5, metalness: 0.5 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.3, metalness: 0.8 });
  const matHub = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.9 });

  // ----- Body: tapered lathe profile -----
  const bodyPoints = [];
  const bodyW = 1.6, bodyH = 0.85, bodyL = 2.05;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    bodyPoints.push(new THREE.Vector2(bodyW * (1 - t * 0.30), bodyH * (1 - t * 0.20)));
  }
  const bodyGeo = new THREE.LatheGeometry(bodyPoints, 32);
  const bodyMesh = new THREE.Mesh(bodyGeo, [matBody, matTrim]);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.position.set(0, 0.45, 0);
  bodyMesh.rotation.y = Math.PI;
  group.add(bodyMesh);
  group.userData.parts = { body: bodyMesh, chassis: null, wheels: [], driver: null,
    helmet: null, visor: null, exhaust: [], flame: [], shield: null, spark: null,
    shadowBlob: null };

  // ----- Chassis: tapered rounded box underneath -----
  const chassisGeo = new THREE.BoxGeometry(1.4, 0.30, 1.9);
  const chassisMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.7, metalness: 0.4 });
  const chassisMesh = new THREE.Mesh(chassisGeo, chassisMat);
  chassisMesh.castShadow = true;
  chassisMesh.receiveShadow = true;
  chassisMesh.position.set(0, 0.15, 0.25);
  group.add(chassisMesh);
  group.userData.parts.chassis = chassisMesh;

  // ----- Number plate on nose (trim) -----
  const plateGeo = new THREE.BoxGeometry(0.18, 0.06, 0.05);
  const plateMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.5, metalness: 0.5 });
  const plateMesh = new THREE.Mesh(plateGeo, plateMat);
  plateMesh.castShadow = true;
  plateMesh.receiveShadow = true;
  plateMesh.position.set(1.05, 0.45, 0);
  group.add(plateMesh);

  // ----- Spoiler on back (trim) -----
  const spoilerGeo = new THREE.BoxGeometry(1.3, 0.07, 0.30);
  const spoilerMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.5, metalness: 0.6 });
  const spoilerMesh = new THREE.Mesh(spoilerGeo, spoilerMat);
  spoilerMesh.castShadow = true;
  spoilerMesh.receiveShadow = true;
  spoilerMesh.position.set(0, 0.65, -1.0);
  group.add(spoilerMesh);

  // ----- Wheels: steer pivot + rolling spinner (tyre torus, hub, spokes) -----
  // The kart is authored nose-at-+Z, so a wheel axle runs along local X. TorusGeometry lies in
  // the XY plane with its hole along Z, so the pivot yaws +90° to bring that hole onto X, and a
  // spinner child does the rolling. Indices 0,1 sit at +Z = the nose = the steered pair.
  const WHEEL_YAW = Math.PI / 2;
  const wheelSpec = [
    { x: -0.62, z: 0.86, front: true }, { x: 0.62, z: 0.86, front: true },
    { x: -0.62, z: -0.86, front: false }, { x: 0.62, z: -0.86, front: false },
  ];
  group.userData.parts.wheelSpinners = [];
  const tyreGeo = new THREE.TorusGeometry(0.24, 0.11, 16, 32);
  const hubGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.30, 16);
  const spokeGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.34, 8);
  for (let i = 0; i < 4; i++) {
    const ws = wheelSpec[i];
    const pivot = new THREE.Group();
    pivot.position.set(ws.x, 0.35, ws.z);
    pivot.rotation.y = WHEEL_YAW;
    pivot.userData.front = ws.front;
    pivot.userData.yaw = WHEEL_YAW;

    const spinner = new THREE.Group();
    pivot.add(spinner);
    group.userData.parts.wheelSpinners.push(spinner);

    const tyre = new THREE.Mesh(tyreGeo, matDark);
    tyre.castShadow = true;
    tyre.receiveShadow = true;
    spinner.add(tyre);

    const hub = new THREE.Mesh(hubGeo, matHub);
    hub.rotation.x = Math.PI / 2;      // cylinder axis Y -> axle Z, which the pivot maps onto X
    hub.castShadow = true;
    spinner.add(hub);

    for (let s = 0; s < 4; s++) {
      const spoke = new THREE.Mesh(spokeGeo, matHub);
      spoke.rotation.z = (s * Math.PI) / 4;
      spoke.castShadow = true;
      spinner.add(spoke);
    }

    group.add(pivot);
    group.userData.parts.wheels.push(pivot);
  }

  // ----- Driver group (shared helper) + lathe-only steering wheel and exhausts -----
  const { driver: driverGroup, helmet: helmetMesh, visor: visorMesh } = buildDriver(THREE, spec);
  group.userData.parts.helmet = helmetMesh;
  group.userData.parts.visor = visorMesh;

  // Steering wheel
  const wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.08, 32);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.3, metalness: 0.8 });
  const wheelMesh = new THREE.Mesh(wheelGeo, wheelMat);
  wheelMesh.castShadow = true;
  wheelMesh.receiveShadow = true;
  wheelMesh.position.set(0, 0.80, 1.25);
  wheelMesh.rotation.z = Math.PI / 2;
  driverGroup.add(wheelMesh);

  // Exhaust pipes
  for (let side of [-1, 1]) {
    const exhaustGeo = new THREE.CylinderGeometry(0.10, 0.10, 0.60, 16);
    const exhaustMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.4, metalness: 0.6 });
    const exhaustMesh = new THREE.Mesh(exhaustGeo, exhaustMat);
    exhaustMesh.castShadow = true;
    exhaustMesh.receiveShadow = true;
    exhaustMesh.position.set(side * 0.55, 0.40, 1.35);
    exhaustMesh.rotation.x = Math.PI / 2;
    driverGroup.add(exhaustMesh);
    group.userData.parts.exhaust.push(exhaustMesh);
  }

  group.add(driverGroup);
  group.userData.parts.driver = driverGroup;
  group.userData.parts.paint = [matBody];

  // ----- ground contact and scale: measured, not guessed --------------------------------
  // The physics puts kart.pos.y exactly on the road surface and frames the kart with a chase
  // camera, so the model must (a) occupy a believable go-kart footprint and (b) rest its
  // wheels at y = 0. Effect parts are added afterwards (addEffects), outside the rig.
  const rig = new THREE.Group();
  for (const child of group.children.slice()) rig.add(child);
  group.add(rig);
  group.userData.parts.rig = rig;

  const parts = group.userData.parts;
  group.updateMatrixWorld(true);
  const bodyBox = new THREE.Box3().setFromObject(rig), piece = new THREE.Box3();
  const dim = new THREE.Vector3();
  bodyBox.getSize(dim);
  if (isFinite(dim.x) && dim.x > 0.2 && dim.z > 0.2) {
    const s = Math.min(1.95 / dim.x, 3.0 / dim.z, 1.6 / dim.y);
    if (isFinite(s) && s > 0.15 && s < 3) rig.scale.setScalar(s);
  }
  group.updateMatrixWorld(true);

  const wheelBox = new THREE.Box3();
  for (const w of parts.wheels) { piece.setFromObject(w); wheelBox.union(piece); }
  if (isFinite(wheelBox.min.y) && Math.abs(wheelBox.min.y) < 4) rig.position.y = -wheelBox.min.y;
  return group;
}

export function updateKartModel(group, kart, dt) {
  const parts = group.userData.parts;
  const THREE = group.userData.three;

  // Wheels: roll the spinners about the axle, steer the two front pivots.
  // kart.wheelSpin is an accumulated angle from the physics — assign it, never integrate it twice.
  const spin = kart.wheelSpin;
  parts.wheels.forEach((pivot) => {
    if (pivot.userData.front) pivot.rotation.y = pivot.userData.yaw + kart.steerVis;
  });
  if (parts.wheelSpinners) parts.wheelSpinners.forEach((sp) => { sp.rotation[parts.spinAxis || 'z'] = spin; });

  // Body lean (roll) + pitch from hop
  group.rotation.z = kart.lean;
  group.rotation.x = kart.air.vy * 0.3;

  // Fixed orientation formula (must not change): nose at +Z
  group.rotation.y = Math.PI / 2 - kart.heading;

  // World position + height
  group.position.set(kart.pos.x, kart.pos.y, kart.pos.z);

  // Boost shield
  const boostTime = kart.boost.time;
  const shield = parts.shield;
  const shieldMat = shield.material;
  if (boostTime > 0) {
    shieldMat.opacity = Math.min(0.45, boostTime * 0.3);
    shieldMat.emissiveIntensity = Math.min(1.5, boostTime * 0.6);
    shield.visible = true;
  } else {
    shield.visible = false;
    shieldMat.opacity = 0.0;
    shieldMat.emissiveIntensity = 0.0;
  }

  // Turbo flames: tier colour while charging a drift, full length while boosting (§8)
  const look = flameLook(kart, group.userData.boostTier ?? 1);
  if (kart.drift.on && kart.drift.tier >= 0) group.userData.boostTier = Math.min(2, kart.drift.tier);
  else if (!look.on) group.userData.boostTier = 1;   // a plain mushroom/pad boost burns orange
  parts.flame.forEach((flame) => {
    flame.visible = look.on;
    if (!look.on) return;
    const flick = 0.85 + Math.random() * 0.3;
    flame.scale.set(flick, flick, look.len * (0.8 + Math.random() * 0.4));
    flame.material.color.setHex(FLAME_COLORS[look.tier]);
    flame.material.opacity = 0.7 + Math.random() * 0.25;
  });

  // Drift spark (colour per tier)
  const spark = parts.spark;
  if (kart.drift.tier > 0) {
    spark.visible = true;
    spark.scale.setScalar(0.45 + kart.drift.tier * 0.35);
    const sMat = spark.material;
    sMat.emissiveIntensity = Math.max(0.0, 2.0 - kart.drift.time * 1.5);
  } else {
    spark.visible = false;
  }

  // Star rainbow aura on shield
  if (kart.star > 0) {
    const hue = (Date.now() * 0.001) % 1;
    const c = new THREE.Color().setHSL(hue, 0.8, 0.5);
    shieldMat.color.copy(c);
    shieldMat.emissive.copy(c);
    shieldMat.opacity = 0.25 + Math.sin(Date.now() * 0.005) * 0.15;
    shield.visible = true;
  }

  // Cloud invisibility -> paint transparency
  const paintMats = parts.paint || [];
  for (const m of paintMats) { m.opacity = kart.invisible > 0 ? 0.25 : 1.0; m.transparent = kart.invisible > 0; }

  // Spin-out wobble
  if (kart.spin > 0) {
    group.rotation.z += Math.sin(Date.now() * 0.020) * 0.10;
    group.rotation.x += Math.cos(Date.now() * 0.015) * 0.10;
  }

  // Shrink scale
  group.scale.setScalar(kart.shrunk > 0 ? 0.85 : 1.0);

  // Hit flash emissive pulse
  if (kart.hitFlash > 0) {
    const intensity = Math.min(1.0, kart.hitFlash * 5.0);
    for (const m of paintMats) { m.emissive.setHex(0xff0000).multiplyScalar(intensity); m.emissiveIntensity = intensity; }
  }

  // Shadow blob under airborne kart
  const shadow = parts.shadowBlob;
  if (kart.air.y > 0.3) {
    shadow.visible = true;
    shadow.scale.setScalar((shadow.userData.base || 1) * (1.0 + kart.air.y * 2.0));
    shadow.material.opacity = Math.max(0.0, 0.3 - kart.air.y * 0.15);
  } else {
    shadow.visible = false;
  }

  // Front wheel steering update (persist per frame)
  if (!parts.model && parts.wheels.length >= 2) {   // lathe pivots only; on GLB pivots z would be camber
    parts.wheels[0].rotation.z = kart.steerVis * 0.8;
    parts.wheels[1].rotation.z = kart.steerVis * 0.8;
  }
}

export function buildItemProps(THREE) {
  const matMushroomCap = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.4, metalness: 0.3 });
  const matMushroomStem = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 });
  const matGreenShell = new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 0.3, metalness: 0.7 });
  const matRedShell = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.3, metalness: 0.7 });
  const matHeatTail = new THREE.MeshStandardMaterial({ color: 0xff6600, roughness: 0.2, metalness: 0.9 });
  const matBanana = new THREE.MeshStandardMaterial({ color: 0xffff00, roughness: 0.5, metalness: 0.2 });
  const matPeel = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.1 });
  const matCloud = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8, metalness: 0.1 });
  const matLightning = new THREE.MeshStandardMaterial({ color: 0x00ffff, roughness: 0.3, metalness: 0.7 });
  const matStarCenter = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.9 });

  return {
    // The item box on the road. It used to be a 0.15 m cube while the pickup radius is 1.9 m —
    // you collected things you could barely see. Drawn to match what it actually collects:
    // a ~1.5 m glowing crate with an edge outline and a bright core, so it reads from a distance.
    itemBox: (() => {
      const g = new THREE.Group();
      const S = 1.5;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x1b6f8c, roughness: 0.25, metalness: 0.35,
        emissive: 0x2fb8e6, emissiveIntensity: 0.55, transparent: true, opacity: 0.9,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(S, S, S), mat);
      mesh.castShadow = true;
      g.add(mesh);
      // hard edge outline: the thing that makes a translucent crate readable against a bright track
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(S, S, S)),
        new THREE.LineBasicMaterial({ color: 0xd8f6ff })
      );
      g.add(edges);
      // bright core, so it still reads when the crate edge-on
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(S * 0.30, 1),
        new THREE.MeshBasicMaterial({ color: 0xfff4b0 })
      );
      g.add(core);
      return g;
    })(),

    // Fresh held item beside driver
    itemMesh: (itemId) => {
      const group = new THREE.Group();

      switch (itemId) {
        case 1: { // MUSHROOM
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.50, 16), matMushroomStem);
          stem.castShadow = true; stem.receiveShadow = true;
          group.add(stem);
          const cap = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 16), matMushroomCap);
          cap.position.y = 0.25; cap.castShadow = true; cap.receiveShadow = true;
          group.add(cap);
          break;
        }
        case 3: { // GREEN SHELL
          const shell = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 24), matGreenShell);
          shell.castShadow = true; shell.receiveShadow = true;
          group.add(shell);
          const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.8, 16),
            new THREE.MeshStandardMaterial({ color: 0x008800, roughness: 0.4, metalness: 0.8 }));
          tail.position.x = -0.4; tail.castShadow = true; tail.receiveShadow = true;
          group.add(tail);
          break;
        }
        case 5: { // RED SHELL (heat-seeking look: extra tail cone)
          const shell = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 24), matRedShell);
          shell.castShadow = true; shell.receiveShadow = true;
          group.add(shell);
          const heat = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.10, 24, 12), matHeatTail);
          heat.position.z = -0.3; heat.rotation.x = Math.PI / 2;
          heat.castShadow = true; heat.receiveShadow = true;
          group.add(heat);
          break;
        }
        case 7: { // BANANA
          const banana = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 16), matBanana);
          banana.castShadow = true; banana.receiveShadow = true;
          group.add(banana);
          const peel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.15, 0.22), matPeel);
          peel.position.z = 0.36; peel.castShadow = true; peel.receiveShadow = true;
          group.add(peel);
          break;
        }
        case 8.5: { // CLOUD / FAKE ITEM
          const cloud = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 24), matCloud);
          cloud.castShadow = true; cloud.receiveShadow = true;
          group.add(cloud);
          const inner = new THREE.Mesh(new THREE.SphereGeometry(0.36, 24, 24),
            new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.1 }));
          inner.position.y = 0.12; inner.castShadow = true; inner.receiveShadow = true;
          group.add(inner);
          break;
        }
        case 9: { // LIGHTNING
          const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.32, 0.10), matLightning);
          bolt.castShadow = true; bolt.receiveShadow = true;
          group.add(bolt);
          const b1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.05), matLightning);
          b1.position.y = 0.16; b1.position.x = 0.14; b1.castShadow = true; b1.receiveShadow = true;
          group.add(b1);
          const b2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.20, 0.05), matLightning);
          b2.position.y = 0.16; b2.position.x = -0.14; b2.castShadow = true; b2.receiveShadow = true;
          group.add(b2);
          break;
        }
        case 10: { // STAR (spikes + bright center)
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            const spike = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.42, 0.10),
              matStarCenter);
            spike.position.x = Math.cos(a) * 0.62;
            spike.position.z = Math.sin(a) * 0.62;
            spike.castShadow = true; spike.receiveShadow = true;
            group.add(spike);
          }
          const center = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16),
            new THREE.MeshStandardMaterial({ color: 0xffff00, roughness: 0.4, metalness: 0.8 }));
          center.castShadow = true; center.receiveShadow = true;
          group.add(center);
          break;
        }
      }
      return group;
    },

    // Live effect mesh positioned at origin, sized to effect.radius
    effectMesh: (effect) => {
      const group = new THREE.Group();

      switch (effect.kind) {
        case 'shell': {
          // a green shell, not a green ball: domed body, belt, and the spikes that make it read
          const shell = new THREE.Mesh(new THREE.SphereGeometry(effect.radius, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
            new THREE.MeshStandardMaterial({ color: 0x2ecf3f, roughness: 0.35, metalness: 0.3, side: THREE.DoubleSide }));
          shell.rotation.x = Math.PI;              // dome opens downward
          shell.castShadow = true; shell.receiveShadow = true;
          group.add(shell);
          const cap = new THREE.Mesh(new THREE.SphereGeometry(effect.radius * 0.98, 20, 8, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.38),
            new THREE.MeshStandardMaterial({ color: 0x1b7a26, roughness: 0.5 }));
          cap.rotation.x = Math.PI;
          group.add(cap);
          const belt = new THREE.Mesh(new THREE.TorusGeometry(effect.radius * 0.96, effect.radius * 0.10, 8, 20),
            new THREE.MeshStandardMaterial({ color: 0xf2e9c9, roughness: 0.5 }));
          belt.rotation.x = Math.PI / 2;
          group.add(belt);
          for (let s = 0; s < 6; s++) {
            const spike = new THREE.Mesh(new THREE.ConeGeometry(effect.radius * 0.16, effect.radius * 0.55, 6),
              new THREE.MeshStandardMaterial({ color: 0xf2e9c9, roughness: 0.5 }));
            const a = (s / 6) * Math.PI * 2;
            spike.position.set(Math.cos(a) * effect.radius * 0.9, 0, Math.sin(a) * effect.radius * 0.9);
            spike.rotation.z = -Math.PI / 2; spike.rotation.y = -a;   // cone axis -> outward
            group.add(spike);
          }
          break;
        }
        case 'banana': {
          // the hit radius is 1.3 m but this used to draw a fixed 0.3 m flat disc — players got
          // "stunned by an invisible something". Draw at the real size, banana-shaped.
          const R = Math.max(0.35, effect.radius || 0.3);
          const mesh = new THREE.Mesh(new THREE.TorusGeometry(R * 0.9, R * 0.26, 10, 20, Math.PI * 1.15),
            new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.45, metalness: 0.05 }));
          mesh.rotation.x = -Math.PI / 2;              // crescent lies flat
          mesh.position.y = -R * 0.75;                 // sit on the road, not at the hit-center
          mesh.castShadow = true; mesh.receiveShadow = true;
          group.add(mesh);
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.10, R * 0.12, R * 0.35, 6),
            new THREE.MeshStandardMaterial({ color: 0x6b4a1f, roughness: 0.7 }));
          stem.position.set(R * 0.55, -R * 0.55, 0);
          group.add(stem);
          break;
        }
        case 'zap': {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2),
            new THREE.MeshStandardMaterial({ color: 0x00ffff, roughness: 0.3, metalness: 0.7 }));
          mesh.castShadow = true; mesh.receiveShadow = true;
          group.add(mesh);
          break;
        }
        case 'cloud': {
          const mesh = new THREE.Mesh(new THREE.SphereGeometry(effect.radius, 24, 24),
            new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8, metalness: 0.1 }));
          mesh.castShadow = true; mesh.receiveShadow = true;
          group.add(mesh);
          break;
        }
        case 'starburst': {
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3),
            new THREE.MeshStandardMaterial({ color: 0xffff00, roughness: 0.5, metalness: 0.5 }));
          mesh.castShadow = true; mesh.receiveShadow = true;
          group.add(mesh);
          break;
        }
      }
      return group;
    }
  };
}

export function setHeldItem(THREE, group, itemId, count) {
  const parts = group.userData.parts;

  // Remove any previously held item meshes tracked here
  Object.keys(parts).forEach((key) => {
    if (key.startsWith('heldItem')) {
      group.remove(parts[key]);
      delete parts[key];
    }
  });

  if (itemId === 0 || count <= 0) return;

  // Build fresh held item meshes (source builds them at origin, sized small)
  const items = buildItemProps(THREE);
  const itemGroup = new THREE.Group();

  for (let i = 0; i < Math.min(count, 3); i++) {
    const mesh = items.itemMesh(itemId).clone();
    mesh.scale.setScalar(0.45);
    mesh.position.set(i * 0.28 - 0.28, 0.60, 1.10);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    itemGroup.add(mesh);
  }

  itemGroup.rotation.y = Math.PI;
  parts.heldItem = itemGroup;
  group.add(itemGroup);
}
