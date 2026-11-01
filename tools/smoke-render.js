// tools/smoke-render.js — headless verification of the render modules: they must actually build
// geometry (no stubs), never throw, and never use flat shading. Real three.js, no WebGL context.
import * as THREE from '../vendor/three.module.js';  // vendored: the tools run with no node_modules
import { PLAYERS, AI_DRIVERS, ITEM, TRACKS } from '../src/config.js';
import { buildKartModel, updateKartModel, buildItemProps, setHeldItem } from '../src/render/kartModel.js';
import { createFX } from '../src/render/fx.js';
import { createKart } from '../src/core/kart.js';

function audit(root, label, errors) {
  let meshes = 0, tris = 0, flat = 0, missingPos = 0;
  const mats = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    meshes++;
    const g = o.geometry;
    if (!g || !g.getAttribute('position')) { missingPos++; return; }
    const idx = g.getAttribute('index');
    tris += idx ? idx.count / 3 : g.getAttribute('position').count / 3;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) { if (!m) continue; mats.add(m.type); if (m.flatShading) flat++; }
  });
  if (missingPos) errors.push(`${label}: ${missingPos} meshes with no position attribute`);
  if (flat) errors.push(`${label}: ${flat} flat-shaded materials (toy look)`);
  if (meshes === 0) errors.push(`${label}: built ZERO meshes`);
  return { label, meshes, tris: Math.round(tris), materials: [...mats].join(',') };
}

export async function renderSmoke() {
  const errors = [], report = [];
  const scene = new THREE.Scene();

  // ---------- kart models: one per racer spec, then a frame of animation ----------
  const animatedKart = (spec) => {
    const k = createKart(0, spec, true);
    k.speed = 25; k.wheelSpin = 3; k.steerVis = 0.3; k.lean = 0.2;
    k.boost.time = 1; k.fx.boost = 1; k.drift.on = true; k.drift.tier = 2; k.fx.spark = 2;
    k.air.y = 0.6; k.spin = 0.5; k.shrunk = 1; k.invisible = 1; k.star = 1; k.hitFlash = 0.4;
    return k;
  };
  for (const spec of PLAYERS.concat(AI_DRIVERS)) {
    let g;
    try { g = buildKartModel(THREE, spec); } catch (e) { errors.push(`buildKartModel(${spec.name}) threw: ${e.message}`); continue; }
    if (!g || !g.isObject3D) { errors.push(`buildKartModel(${spec.name}) returned no Object3D`); continue; }
    const parts = (g.userData && g.userData.parts) || null;
    if (!parts) errors.push(`buildKartModel(${spec.name}): no userData.parts handle table`);
    else if (!parts.wheels || parts.wheels.length !== 4) errors.push(`${spec.name}: wheels must be 4, got ${parts.wheels ? parts.wheels.length : 'none'}`);
    try { updateKartModel(g, animatedKart(spec), 1 / 60); } catch (e) { errors.push(`updateKartModel(${spec.name}) threw: ${e.message}`); }
    try { setHeldItem(THREE, g, ITEM.MUSHROOM, 1); setHeldItem(THREE, g, 0, 0); } catch (e) { errors.push(`setHeldItem(${spec.name}) threw: ${e.message}`); }

    // ground contact + silhouette size: the physics puts the kart origin on the road surface,
    // so the wheels must rest at y=0 and the kart must fit the chase-camera framing.
    const wheelBox = new THREE.Box3(), piece = new THREE.Box3();
    for (const w of (g.userData.parts && g.userData.parts.wheels) || []) { piece.setFromObject(w); wheelBox.union(piece); }
    if (isFinite(wheelBox.min.y) && Math.abs(wheelBox.min.y) > 0.06) {
      errors.push(`${spec.name}: wheels rest at y=${wheelBox.min.y.toFixed(3)} — must sit at ~0`);
    }
    const rig = g.userData.parts.rig || g;
    const effectParts = new Set([g.userData.parts.shadowBlob, g.userData.parts.spark, g.userData.parts.shield].filter(Boolean));
    for (const f of g.userData.parts.flame || []) effectParts.add(f);
    const bodyBox = new THREE.Box3(), bodyPiece = new THREE.Box3();
    g.updateMatrixWorld(true);
    for (const c of rig.children) { if (effectParts.has(c)) continue; bodyPiece.setFromObject(c); bodyBox.union(bodyPiece); }
    const size = new THREE.Vector3(); bodyBox.getSize(size);
    if (size.x > 2.3 || size.z > 3.6 || size.y > 1.9) {
      errors.push(`${spec.name}: kart silhouette too big: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`);
    }
    if (size.x < 0.8 || size.z < 1.4) errors.push(`${spec.name}: kart silhouette too small: ${size.x.toFixed(2)} x ${size.z.toFixed(2)}`);
    report.push(audit(g, `kart:${spec.name} ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}m`, errors));
    scene.add(g);
  }

  // ---------- item + effect props ----------
  let props;
  try { props = buildItemProps(THREE); } catch (e) { errors.push(`buildItemProps threw: ${e.message}`); }
  if (props) {
    if (!props.itemBox || !props.itemBox.isObject3D) errors.push('props.itemBox missing');
    else report.push(audit(props.itemBox, 'props:itemBox', errors));
    for (const id of [ITEM.MUSHROOM, ITEM.GREEN_SHELL, ITEM.RED_SHELL, ITEM.BANANA, ITEM.FAKE_ITEM, ITEM.LIGHTNING, ITEM.STAR]) {
      try { const m = props.itemMesh(id); if (!m || !m.isObject3D) errors.push(`itemMesh(${id}) returned nothing`); }
      catch (e) { errors.push(`itemMesh(${id}) threw: ${e.message}`); }
    }
    for (const kind of ['shell', 'banana', 'zap', 'cloud', 'starburst']) {
      try {
        const m = props.effectMesh({ kind, item: ITEM.GREEN_SHELL, radius: 1 });
        if (!m || !m.isObject3D) errors.push(`effectMesh(${kind}) returned nothing`);
      } catch (e) { errors.push(`effectMesh(${kind}) threw: ${e.message}`); }
    }
  }

  // ---------- particle pool ----------
  let fx;
  try { fx = createFX(THREE, scene); } catch (e) { errors.push(`createFX threw: ${e.message}`); }
  if (fx) {
    for (const fn of ['burst', 'trail', 'ring', 'confetti', 'update', 'reset', 'dispose']) {
      if (typeof fx[fn] !== 'function') errors.push(`fx.${fn} missing`);
    }
    try {
      for (let i = 0; i < 400; i++) {
        fx.burst(i, 1, 0, { color: 0xff0000, count: 6 });
        if (i % 3 === 0) fx.trail(i, 1, 0, { color: 0x00ff00 });
        if (i % 7 === 0) fx.ring(i, 1, 0, {});
        fx.update(1 / 60);
      }
      fx.confetti(0, 2, 0, 40);
      fx.update(1 / 60);
    } catch (e) { errors.push(`fx storm threw: ${e.message}`); }
    let inst = 0, cap = 0;
    scene.traverse((o) => { if (o.isInstancedMesh) { inst++; cap += o.instanceMatrix ? o.instanceMatrix.count : 0; } });
    if (!inst) errors.push('fx created no InstancedMesh (particles must be pooled)');
    if (cap && cap < 1200) errors.push(`fx instance capacity too small: ${cap}`);
    report.push({ label: 'fx-pool', meshes: inst, tris: cap, materials: 'pooled' });
    if (typeof fx.dispose === 'function') fx.dispose();
  }

  // ---------- track geometry, once the track module exists ----------
  let trackMod = null, meshMod = null;
  try { trackMod = await import('../src/core/track.js'); meshMod = await import('../src/render/trackMesh.js'); }
  catch (e) { if (!/Cannot find module/.test(String(e.message))) errors.push('track modules failed to load: ' + e.message); }
  if (trackMod && meshMod && trackMod.buildTrack && meshMod.buildTrackScene) {
    for (const def of TRACKS) {
      let track, sc;
      try { track = trackMod.buildTrack(def); } catch (e) { errors.push(`buildTrack(${def.id}) threw: ${e.message}`); continue; }
      try { sc = meshMod.buildTrackScene(THREE, track, def.theme); } catch (e) { errors.push(`buildTrackScene(${def.id}) threw: ${e.message}`); continue; }
      if (!sc || !sc.group || !sc.group.isObject3D) { errors.push(`buildTrackScene(${def.id}): no .group returned`); continue; }
      report.push(audit(sc.group, `track:${def.id}`, errors));
    }
  } else {
    report.push({ label: 'track:SKIPPED (module not present yet)', meshes: 0, tris: 0, materials: '-' });
  }

  return { errors, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { errors, report } = await renderSmoke();
  for (const r of report) {
    console.log(`${String(r.meshes).padStart(5)} meshes  ${String(r.tris).padStart(8)} tris  ${r.label}` + (r.materials && r.materials !== '-' ? `  [${r.materials}]` : ''));
  }
  if (errors.length) { console.error('\nRENDER SMOKE FAIL:\n  ' + errors.join('\n  ')); process.exit(1); }
  console.log('\nRENDER SMOKE OK');
}
