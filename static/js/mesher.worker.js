// Chunk mesher + lighting worker.
//
// Keeps its own copy of the loaded world (worldstore.js), runs the coloured
// flood-fill lighting (lighting.js) and builds the culled-face chunk meshes,
// so none of that heavy work runs on the main (render) thread. The main
// thread only streams chunk data and edits in, and gets ready-made typed
// arrays back.
//
// Messages in:
//   {type:'init', dims:{CX,CY,CZ}, materials:[{id,color,translucent,
//     emissive,action}]}
//   {type:'clear', epoch}                 scene switch: drop everything
//   {type:'load', cx, cz, sections:[{sy,data}], subs:[[x,y,z,s,mat]]}
//   {type:'unload', cx, cz}
//   {type:'edits', base:Int32Array(x,y,z,id)*, subs:[[x,y,z,s,id]]}
//   {type:'focus', x, z}                  player position, for priorities
// Messages out:
//   {type:'mesh', epoch, cx, cz, geometry|null, lamps, faucets}
//   {type:'idle', epoch}                  nothing left to mesh

import { createWorldStore, chunkKey } from './worldstore.js';
import { createLightEngine } from './lighting.js';

let store = null;
let light = null;
let materials = [];
let epoch = 0;
let focus = { x: 0, z: 0 };

const lightDirty = new Set();   // chunk keys whose light must be recomputed
const meshDirty = new Set();    // chunk keys to re-mesh
const urgent = new Set();       // subset of meshDirty touched by edits
let timer = null;

// Light-level (0..15) to brightness (0..255), Minecraft-ish response curve.
const LIGHT_CURVE = Array.from({ length: 16 },
  (_, i) => Math.round(Math.pow(i / 15, 1.6) * 255));

const FACES = [
  { dir: [1, 0, 0], corners: [[1,1,1],[1,0,1],[1,1,0],[1,0,0]], shade: 0.80 },
  { dir: [-1,0, 0], corners: [[0,1,0],[0,0,0],[0,1,1],[0,0,1]], shade: 0.80 },
  { dir: [0, 1, 0], corners: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]], shade: 1.00 },
  { dir: [0,-1, 0], corners: [[0,0,0],[1,0,0],[0,0,1],[1,0,1]], shade: 0.55 },
  { dir: [0, 0, 1], corners: [[1,1,1],[0,1,1],[1,0,1],[0,0,1]], shade: 0.72 },
  { dir: [0, 0,-1], corners: [[0,1,0],[1,1,0],[0,0,0],[1,0,0]], shade: 0.72 },
];

const matColor = [];
function materialRGB(id) {
  let c = matColor[id];
  if (!c) {
    const hex = materials[id] ? materials[id].color : '#ff00ff';
    c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16),
         parseInt(hex.slice(5, 7), 16)];
    matColor[id] = c;
  }
  return c;
}

// Deterministic per-voxel jitter in [0.90, 1.10] (granite speckle).
function voxelJitter(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return 0.90 + ((h >>> 16) & 0xff) / 255 * 0.20;
}

// Growable typed-array builder.
class Buf {
  constructor(Type, n = 4096) { this.a = new Type(n); this.n = 0; this.T = Type; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) this.grow();
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  grow() {
    const b = new this.T(this.a.length * 2);
    b.set(this.a);
    this.a = b;
  }
  done() { return this.a.slice(0, this.n); }
}

function buildMesh(chunk) {
  const { CX, CZ, LAYER, NS } = store;
  const pos = new Buf(Float32Array), nrm = new Buf(Int8Array),
        col = new Buf(Uint8Array), sky = new Buf(Uint8Array),
        blk = new Buf(Uint8Array);
  let idx = new Uint32Array(8192), ni = 0;
  let verts = 0;
  const ox = chunk.cx * CX, oz = chunk.cz * CZ;

  const emitFace = (face, bx, by, bz, size, rgb, jitter, lv) => {
    const skyR = LIGHT_CURVE[(lv >> 20) & 15], skyG = LIGHT_CURVE[(lv >> 16) & 15],
          skyB = LIGHT_CURVE[(lv >> 12) & 15];
    const bR = LIGHT_CURVE[(lv >> 8) & 15], bG = LIGHT_CURVE[(lv >> 4) & 15],
          bB = LIGHT_CURVE[lv & 15];
    const s = face.shade * jitter;
    const r = Math.min(255, rgb[0] * s), g = Math.min(255, rgb[1] * s),
          b = Math.min(255, rgb[2] * s);
    for (const c of face.corners) {
      pos.push3(bx + c[0] * size, by + c[1] * size, bz + c[2] * size);
      nrm.push3(face.dir[0] * 127, face.dir[1] * 127, face.dir[2] * 127);
      col.push3(r, g, b);
      sky.push3(skyR, skyG, skyB);
      blk.push3(bR, bG, bB);
    }
    if (ni + 6 > idx.length) {
      const bigger = new Uint32Array(idx.length * 2);
      bigger.set(idx);
      idx = bigger;
    }
    idx[ni++] = verts; idx[ni++] = verts + 1; idx[ni++] = verts + 2;
    idx[ni++] = verts + 2; idx[ni++] = verts + 1; idx[ni++] = verts + 3;
    verts += 4;
  };

  // Base grid: full 1000 mm voxels with neighbour face culling. Collect
  // lamps and faucets for the main thread while scanning.
  const lamps = [], faucets = [];
  for (let si = 0; si < NS; si++) {
    const sec = chunk.sections[si];
    if (!sec) continue;
    for (let i = 0; i < sec.length; i++) {
      const matId = sec[i];
      if (!matId) continue;
      const lx = i % CX, lz = ((i / CX) | 0) % CZ, ly = (i / LAYER) | 0;
      const y = si * 16 + ly;
      const wx = ox + lx, wz = oz + lz;
      const action = materials[matId] && materials[matId].action;
      if (action === 'lamp') lamps.push({ x: wx, y, z: wz });
      else if (action === 'faucet') faucets.push({ x: wx, y, z: wz, id: matId });
      const rgb = materialRGB(matId);
      const jitter = voxelJitter(wx, y, wz);
      for (const face of FACES) {
        const nx = lx + face.dir[0], ny = y + face.dir[1], nz = lz + face.dir[2];
        const occupied = (nx >= 0 && nx < CX && nz >= 0 && nz < CZ)
          ? (ny >= 0 && ny < store.CY && store.localVoxel(chunk, nx, ny, nz))
          : store.getVoxel(ox + nx, ny, oz + nz);
        if (occupied) continue;
        // Baked light: sample the air cell the face looks into.
        emitFace(face, wx, y, wz, 1, rgb, jitter,
                 light.lightAt(ox + nx, ny, oz + nz));
      }
    }
  }

  // Sub-voxel overlay (positions in mm), lit by their containing 1 m cell.
  for (const sv of chunk.sub.values()) {
    const lv = light.lightAt(Math.floor(sv.x / 1000), Math.floor(sv.y / 1000),
                             Math.floor(sv.z / 1000));
    const rgb = materialRGB(sv.mat);
    const jitter = voxelJitter(sv.x / 10 | 0, sv.y / 10 | 0, sv.z / 10 | 0);
    for (const face of FACES) {
      emitFace(face, sv.x / 1000, sv.y / 1000, sv.z / 1000, sv.s / 1000,
               rgb, jitter, lv);
    }
  }

  if (!verts) return { geometry: null, lamps, faucets };
  const indices = verts <= 65536 ? Uint16Array.from(idx.subarray(0, ni))
    : idx.slice(0, ni);
  return {
    geometry: {
      positions: pos.done(), normals: nrm.done(), colors: col.done(),
      sky: sky.done(), block: blk.done(), indices,
    },
    lamps, faucets,
  };
}

function schedule(delay = 8) {
  if (timer) return;
  timer = setTimeout(process, delay);
}

function distSq(key) {
  const [cx, cz] = key.split(',').map(Number);
  const dx = (cx + 0.5) * store.CX - focus.x, dz = (cz + 0.5) * store.CZ - focus.z;
  return dx * dx + dz * dz;
}

function meshAndPost(key) {
  meshDirty.delete(key);
  urgent.delete(key);
  const chunk = store.chunks.get(key);
  if (!chunk) return;
  const { geometry, lamps, faucets } = buildMesh(chunk);
  const transfer = geometry ? Object.values(geometry).map((a) => a.buffer) : [];
  postMessage({ type: 'mesh', epoch, cx: chunk.cx, cz: chunk.cz,
                geometry, lamps, faucets }, transfer);
}

function process() {
  timer = null;
  if (urgent.size && lightDirty.size) {
    // Show an edit right away with the current light (only the faces next
    // to the changed cell are briefly off), then relight and re-mesh.
    for (const key of [...urgent]) meshAndPost(key);
  }
  if (lightDirty.size) {
    const keys = [...lightDirty];
    lightDirty.clear();
    for (const chunk of light.relightAround(keys)) {
      meshDirty.add(chunkKey(chunk.cx, chunk.cz));
    }
  }
  // Mesh in short slices so new edits/loads are picked up promptly:
  // chunks touched by edits first, then nearest to the player.
  const start = performance.now();
  const order = [...meshDirty].sort((a, b) =>
    (urgent.has(b) - urgent.has(a)) || (distSq(a) - distSq(b)));
  for (const key of order) {
    if (performance.now() - start > 12) break;
    meshAndPost(key);
  }
  if (meshDirty.size || lightDirty.size) schedule(0);
  else postMessage({ type: 'idle', epoch });
}

// A base cell changed: its chunk (and a bordering neighbour, whose culled
// faces depend on it) needs a new mesh; light around it must be redone.
function touchCell(x, z, isUrgent) {
  const cx = Math.floor(x / store.CX), cz = Math.floor(z / store.CZ);
  const key = chunkKey(cx, cz);
  lightDirty.add(key);
  meshDirty.add(key);
  if (isUrgent) urgent.add(key);
  const lx = x - cx * store.CX, lz = z - cz * store.CZ;
  const nb = [];
  if (lx === 0) nb.push(chunkKey(cx - 1, cz));
  if (lx === store.CX - 1) nb.push(chunkKey(cx + 1, cz));
  if (lz === 0) nb.push(chunkKey(cx, cz - 1));
  if (lz === store.CZ - 1) nb.push(chunkKey(cx, cz + 1));
  for (const k of nb) {
    if (!store.chunks.has(k)) continue;
    meshDirty.add(k);
    if (isUrgent) urgent.add(k);
  }
}

onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      store = createWorldStore(msg.dims);
      materials = [];
      for (const m of msg.materials) materials[m.id] = m;
      light = createLightEngine({ store, materials });
      break;
    case 'clear':
      epoch = msg.epoch;
      store.chunks.clear();
      lightDirty.clear();
      meshDirty.clear();
      urgent.clear();
      light.reset();
      break;
    case 'focus':
      focus = { x: msg.x, z: msg.z };
      break;
    case 'load': {
      const chunk = store.makeChunk(msg.cx, msg.cz, msg.sections, msg.subs);
      const key = chunkKey(msg.cx, msg.cz);
      store.chunks.set(key, chunk);
      lightDirty.add(key);
      meshDirty.add(key);
      // Neighbours' border faces toward this chunk must be re-culled.
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = chunkKey(msg.cx + dx, msg.cz + dz);
        if (store.chunks.has(k)) meshDirty.add(k);
      }
      schedule(30); // batch bursts of streamed chunks into one relight
      break;
    }
    case 'unload':
      store.chunks.delete(chunkKey(msg.cx, msg.cz));
      break;
    case 'edits': {
      const b = msg.base;
      for (let i = 0; i < b.length; i += 4) {
        if (store.setVoxel(b[i], b[i + 1], b[i + 2], b[i + 3])) {
          touchCell(b[i], b[i + 2], true);
        }
      }
      for (const [x, y, z, s, id] of msg.subs) {
        const chunk = store.setSub(x, y, z, s, id);
        if (chunk) touchCell(Math.floor(x / 1000), Math.floor(z / 1000), true);
      }
      schedule(0);
      break;
    }
  }
};
