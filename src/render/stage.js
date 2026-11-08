// stage.js — renderer, sky, sun, shadow follow. The look contract lives here. (PM-owned)
// Receives THREE as a parameter; no import of three in this file.
import { RENDER, CAM } from '../config.js';

export function createStage(THREE, canvas, opts = {}) {
  // preserveDrawingBuffer stays ON: some macOS display paths (observed: external screen at dpr=1,
  // Safari+Firefox+Chrome alike) never composite a non-preserved WebGL canvas — draws execute
  // (411 calls, no GL errors) but the screen stays black. Cost: one blit per frame.
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER.exposure;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(RENDER.fogColor, 1);

  const scene = new THREE.Scene();
  // browsers on macOS (Safari/Firefox) can discard a WebGL context at any time; without
  // preventDefault the canvas stays black forever. preventDefault lets the browser restore it,
  // and WebGLRenderer reinitialises on 'webglcontextrestored' on its own.
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('WebGL context lost — the browser will try to restore it'); });
  scene.fog = new THREE.Fog(RENDER.fogColor, RENDER.fogNear, RENDER.fogFar);

  // ---------- sky dome: gradient + sun disc, no textures ----------
  const skyUniforms = {
    top: { value: new THREE.Color(RENDER.skyTop) },
    mid: { value: new THREE.Color(RENDER.skyMid) },
    bot: { value: new THREE.Color(RENDER.skyBottom) },
    sunDir: { value: new THREE.Vector3(1, 0.4, 0).normalize() },
    sunTint: { value: new THREE.Color(0xfff3d0) },
  };
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 top, mid, bot, sunTint; uniform vec3 sunDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(bot, mid, smoothstep(0.45, 0.62, h));
        c = mix(c, top, smoothstep(0.60, 0.98, h));
        float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += sunTint * pow(d, 220.0) * 2.2;           // disc
        c += sunTint * pow(d, 12.0) * 0.30;           // glow
        c += sunTint * pow(d, 2.0) * 0.05;            // wide haze
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(RENDER.fogFar * 1.2, 32, 24), skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0xbcd8f5, 0x4a6b32, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0d4, 2.6);
  const az = RENDER.sunAzimuth, el = RENDER.sunElevation;
  const dir = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
  sun.position.copy(dir).multiplyScalar(160);
  sun.castShadow = true;
  sun.shadow.mapSize.set(RENDER.shadowMap, RENDER.shadowMap);
  const span = RENDER.shadowSpan;
  sun.shadow.camera.left = -span; sun.shadow.camera.right = span;
  sun.shadow.camera.top = span; sun.shadow.camera.bottom = -span;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 420;
  sun.shadow.bias = -0.0007;
  sun.shadow.normalBias = 0.035;
  sun.target.position.set(0, 0, 0);
  scene.add(sun); scene.add(sun.target);

  const rim = new THREE.DirectionalLight(0x7fb8ff, 0.45);
  rim.position.set(-dir.x * 120, 90, -dir.z * 120);
  scene.add(rim);

  const stage = {
    renderer, scene, sky, skyUniforms, sun, hemi, rim,
    _w: 0, _h: 0,

    resize(w, h, dprCap = 2) {
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      stage._w = w; stage._h = h;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);   // CSS size stays under the page's control
    },

    // shadows are the most expensive thing here; weak machines and software renderers can drop them
    setShadows(on) {
      renderer.shadowMap.enabled = !!on;
      sun.castShadow = !!on;
      scene.traverse((o) => { if (o.isMesh && o.userData.shadowMatters !== false) o.material.needsUpdate = true; });
    },

    // keep the shadow camera centred on the action
    followLight(x, z, y = 0) {
      sun.target.position.set(x, y, z);
      sun.position.set(x + dir.x * 160, y + dir.y * 160, z + dir.z * 160);
      sun.target.updateMatrixWorld();
      sky.position.set(x, 0, z);
    },

    // scissored viewport render — this is what makes split screen possible
    renderView(camera, x, y, w, h) {
      renderer.setScissorTest(true);
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      camera.aspect = Math.max(0.2, w / h);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    },

    clear() { renderer.setScissorTest(false); renderer.setViewport(0, 0, stage._w, stage._h); renderer.clear(); },
    dispose() { renderer.dispose(); },
  };
  return stage;
}

// Shared material helpers so every module shades consistently (no flat shading, ever).
export function material(THREE, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff,
    roughness: opts.roughness ?? 0.72,
    metalness: opts.metalness ?? 0.05,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    flatShading: false,
    vertexColors: !!opts.vertexColors,
    side: opts.side ?? THREE.FrontSide,
  });
  return m;
}
