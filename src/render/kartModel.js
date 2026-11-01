// kartModel.js — kart/driver model builder + per-frame updater
// All parts face local +Z (nose/driver face forward). Orientation is fixed:
//   group.rotation.y = Math.PI / 2 - kart.heading
// so a world-forward vector (cos h, 0, sin h) maps to local +Z.
// No flatShading anywhere; high segment counts; all parts cast/receive shadow.
// kart within ~2.2 m radius, ~1.6 m tall.

export function buildKartModel(THREE, spec) {
  const group = new THREE.Group();
  group.userData.three = THREE;   // updateKartModel has no THREE parameter (see INTERFACES §4)

  const { color, trim, skin, helmet } = spec;
  const matBody = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.4 });
  const matTrim = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.5, metalness: 0.5 });
  const matSkin = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7, metalness: 0.2 });
  const matHelmet = new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.3, metalness: 0.1 });
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

  // ----- Driver group: lathe torso + arms + legs + helmet + visor + wheel -----
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
  group.userData.parts.helmet = helmetMesh;

  // Visor stripe: flat plane across face (trim colour)
  const visorGeo = new THREE.PlaneGeometry(1.10, 0.09);
  const visorMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.4, metalness: 0.3 });
  const visorMesh = new THREE.Mesh(visorGeo, visorMat);
  visorMesh.castShadow = true;
  visorMesh.receiveShadow = true;
  visorMesh.position.set(0, 0.67, 1.02);
  visorMesh.rotation.x = -0.18;
  driverGroup.add(visorMesh);
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

  // ----- Boost shield (inactive until boost/star) -----
  const shieldGeo = new THREE.SphereGeometry(1.85, 24, 24);
  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0xffff00, roughness: 0.1, metalness: 0.8,
    transparent: true, opacity: 0.0,
    emissive: 0xffff00, emissiveIntensity: 0.0
  });
  const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
  shieldMesh.castShadow = false;
  shieldMesh.receiveShadow = false;
  shieldMesh.visible = false;
  group.add(shieldMesh);
  group.userData.parts.shield = shieldMesh;

  // ----- Boost flame pair (under rear bumper) -----
  for (let side of [-1, 1]) {
    const flameGeo = new THREE.ConeGeometry(0.28, 0.85, 16);
    const flameMat = new THREE.MeshStandardMaterial({
      color: 0xff6600, roughness: 0.2, metalness: 0.7,
      transparent: true, opacity: 0.0,
      emissive: 0xff3300, emissiveIntensity: 0.0
    });
    const flameMesh = new THREE.Mesh(flameGeo, flameMat);
    flameMesh.castShadow = true;
    flameMesh.receiveShadow = true;
    flameMesh.position.set(side * 0.65, 0.24, -1.15);
    flameMesh.rotation.x = -Math.PI / 2;
    flameMesh.visible = false;
    group.add(flameMesh);
    group.userData.parts.flame.push(flameMesh);
  }

  // ----- Drift spark -----
  const sparkGeo = new THREE.IcosahedronGeometry(0.10, 2);
  const sparkMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.1, metalness: 0.5,
    transparent: true, opacity: 0.7, emissive: 0xffffff, emissiveIntensity: 2.0
  });
  const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
  sparkMesh.castShadow = false;
  sparkMesh.receiveShadow = false;
  sparkMesh.visible = false;
  group.add(sparkMesh);
  group.userData.parts.spark = sparkMesh;

  // ----- Shadow blob (air time) -----
  const shadowGeo = new THREE.CircleGeometry(1.5, 24);
  const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0.3, transparent: true });
  const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
  shadowMesh.castShadow = false;
  shadowMesh.receiveShadow = false;
  shadowMesh.position.set(0, 0.01, 0);
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.visible = false;
  group.add(shadowMesh);
  group.userData.parts.shadowBlob = shadowMesh;

  // ----- ground contact and scale: measured, not guessed --------------------------------
  // The physics puts kart.pos.y exactly on the road surface and frames the kart with a chase
  // camera, so the model must (a) occupy a believable go-kart footprint and (b) rest its
  // wheels at y = 0. Both are computed from the built geometry: effect parts (shield, flame,
  // spark, shadow blob) are excluded from the silhouette measurement on purpose.
  const rig = new THREE.Group();
  for (const child of group.children.slice()) {
    if (child === shadowMesh) continue;
    rig.add(child);
  }
  group.add(rig);
  group.userData.parts.rig = rig;

  const parts = group.userData.parts;
  const effects = new Set([parts.shadowBlob, parts.spark, parts.shield].filter(Boolean));
  for (const f of parts.flame || []) effects.add(f);

  group.updateMatrixWorld(true);
  const bodyBox = new THREE.Box3(), piece = new THREE.Box3();
  for (const child of rig.children) {
    if (effects.has(child)) continue;
    piece.setFromObject(child);
    bodyBox.union(piece);
  }
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

  // the fake ground shadow follows the kart's real footprint
  const blobScale = Math.max(0.2, Math.min(1.2, (dim.x * (rig.scale.x || 1)) / 3.0));
  shadowMesh.scale.setScalar(blobScale);
  shadowMesh.position.set(0, 0.02, 0);

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
  if (parts.wheelSpinners) parts.wheelSpinners.forEach((sp, i) => { sp.rotation.z = spin; });

  // Body lean (roll) + pitch from hop
  group.rotation.z = kart.lean;
  group.rotation.x = kart.air.vy * 0.3;

  // Fixed orientation formula (must not change): nose at +Z
  group.rotation.y = Math.PI / 2 - kart.heading;

  // World position + height
  group.position.set(kart.pos.x, kart.pos.y, kart.pos.z);

  // Boost shield & flame
  const boostTime = kart.boost.time;
  const shield = parts.shield;
  const shieldMat = shield.material;
  if (boostTime > 0) {
    shieldMat.opacity = Math.min(0.45, boostTime * 0.3);
    shieldMat.emissiveIntensity = Math.min(1.5, boostTime * 0.6);
    shield.visible = true;
    parts.flame.forEach((flame) => {
      const fmat = flame.material;
      flame.visible = true;
      flame.scale.y = 0.8 + Math.min(2.0, boostTime * 1.5);
      fmat.opacity = Math.min(0.8, boostTime * 0.4);
      fmat.emissiveIntensity = Math.min(1.2, boostTime * 0.7);
    });
  } else {
    shield.visible = false;
    shieldMat.opacity = 0.0;
    shieldMat.emissiveIntensity = 0.0;
    parts.flame.forEach((flame) => { flame.visible = false; });
  }

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

  // Cloud invisibility -> body transparency
  const bodyMat = parts.body.material;
  bodyMat[0].opacity = kart.invisible > 0 ? 0.25 : 1.0;
  bodyMat[0].transparent = kart.invisible > 0;

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
    bodyMat[0].emissive = new THREE.Color(0xff0000).multiplyScalar(intensity);
    bodyMat[0].emissiveIntensity = intensity;
  }

  // Shadow blob under airborne kart
  const shadow = parts.shadowBlob;
  if (kart.air.y > 0.3) {
    shadow.visible = true;
    shadow.scale.setScalar(1.0 + kart.air.y * 2.0);
    shadow.material.opacity = Math.max(0.0, 0.3 - kart.air.y * 0.15);
  } else {
    shadow.visible = false;
  }

  // Front wheel steering update (persist per frame)
  if (parts.wheels.length >= 2) {
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
    // Rotatable question-mark style box
    itemBox: (() => {
      const geo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffff00, roughness: 0.3, metalness: 0.8,
        emissive: 0xffff00, emissiveIntensity: 0.2 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
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
          const mesh = new THREE.Mesh(new THREE.SphereGeometry(effect.radius, 24, 24),
            new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 0.3, metalness: 0.7 }));
          mesh.castShadow = true; mesh.receiveShadow = true;
          group.add(mesh);
          break;
        }
        case 'banana': {
          const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 16),
            new THREE.MeshStandardMaterial({ color: 0xffff00, roughness: 0.5, metalness: 0.2 }));
          mesh.castShadow = true; mesh.receiveShadow = true;
          group.add(mesh);
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
