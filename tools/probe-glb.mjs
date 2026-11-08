// Run the camera-framing probe with the REAL GLB kart model (not the procedural fallback):
// warm the kart cache through a node file fetcher, then import the probe in-process.
import * as T from '../vendor/three.module.js';
import fs from 'fs';
const km = await import('../src/render/kartModel.js');
const fetchImpl = async (u) => { const p = decodeURIComponent(new URL(u).pathname); const buf = fs.readFileSync(p);
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }; };
await km.loadKartModels(T, fetchImpl);
await import('./probe-camera.js');
