import * as THREE from '/vendor/three.module.js';
import { createScreenManager } from '/js/screens.js';
import { createFluidSim } from '/js/fluids.js';

// ---------------------------------------------------------------------------
// Config & state
//
// All voxel sizes are integers measured in millimetres. The base terrain
// grid is made of default 1000 mm voxels; smaller voxels (down to 10 mm =
// 1 cm) live in a sparse per-chunk overlay. Mining a voxel with a smaller
// tool size carves it: the voxel is decomposed into the largest aligned
// sub-voxels that fill the remainder — i.e. voxels comprised of smaller
// voxels.
// ---------------------------------------------------------------------------
const LOAD_RADIUS = 3;          // chunks around the player to load
const UNLOAD_RADIUS = LOAD_RADIUS + 2;
const REACH = 8;                // block interaction distance (metres)
const FLY_SPEED = 12;
const SPRINT_MULT = 2.6;
const WALK_SPEED = 5.2;
const WALK_SPRINT_MULT = 1.8;
const GRAVITY = 24;             // m/s^2
const JUMP_VELOCITY = 8;        // ~1.3 m jump height
const TERMINAL_VELOCITY = 50;
const MM = 1000;                // mm per metre / per base grid cell

let CX = 16, CY = 64, CZ = 16;  // chunk dimensions (from backend config)

const state = {
  config: null,
  materials: [],                // by id (index 0 unused)
  scene: null,                  // active scene meta
  chunks: new Map(),            // "cx,cz" -> {cx, cz, data, sub:Map, mesh}
  pending: new Set(),           // chunk keys being fetched
  inventory: new Map(),         // matId -> stored count
  hotbar: [],                   // [{matId}]
  activeSlot: 0,
  sizesMm: [1000, 500, 100, 50, 10],  // integer mm, from backend config
  sizeIdx: 0,                   // selected placement/mining voxel size
  yaw: 0, pitch: 0,
  pos: new THREE.Vector3(),
  keys: new Set(),
  pointerLocked: false,
  started: false,
  target: null,                 // result of raycastVoxel()
  rev: 0,                       // last world revision seen from the backend
  lightGaze: null,              // cell key currently firing the light sensor
  pressureCell: null,           // cell key currently holding a pressure plate
  noclip: false,                // N toggles collision off for free flight
  mode: 'walk',                 // 'walk' (gravity) | 'fly'; double-tap Space
  vy: 0,                        // vertical velocity in walk mode (m/s)
  grounded: false,
};

let screenMgr = null;           // created once config is loaded
let fluidSim = null;

const toolSizeMm = () => state.sizesMm[state.sizeIdx];

// ---------------------------------------------------------------------------
// Three.js setup
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('app').appendChild(renderer.domElement);

const scene3 = new THREE.Scene();
scene3.background = new THREE.Color(0x87b5e0);
scene3.fog = new THREE.Fog(0x87b5e0, 40, 120);

const camera = new THREE.PerspectiveCamera(
  75, window.innerWidth / window.innerHeight, 0.05, 600);

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(0.45, 1, 0.3);
scene3.add(sun);
const ambientLight = new THREE.AmbientLight(0xbfd4ea, 0.9);
scene3.add(ambientLight);
const hemiLight = new THREE.HemisphereLight(0xcfe5ff, 0x6b6252, 0.5);
scene3.add(hemiLight);

// ---------------------------------------------------------------------------
// Day/night cycle. The backend owns the clock (GET/POST /api/time); the
// client renders a procedural sky from the apparent hour: sun + moon discs,
// stars at night, and sky/fog/light colours blended through dawn and dusk.
// ---------------------------------------------------------------------------
const timeState = { hours: 9, speed: 4, syncedAt: performance.now() };

function syncTime(t) {
  if (!t) return;
  timeState.hours = t.apparentHours;
  timeState.speed = t.speed;
  timeState.syncedAt = performance.now();
}

function apparentHours() {
  const elapsedH = (performance.now() - timeState.syncedAt) / 3600000;
  return ((timeState.hours + elapsedH * timeState.speed) % 24 + 24) % 24;
}

const SKY_DAY = new THREE.Color(0x87b5e0);
const SKY_NIGHT = new THREE.Color(0x0a0f22);
const SKY_DUSK = new THREE.Color(0xd97b4a);
const SUN_DAY = new THREE.Color(0xffffff);
const SUN_LOW = new THREE.Color(0xffb066);
const skyColor = new THREE.Color();

const sunMesh = new THREE.Mesh(
  new THREE.SphereGeometry(14, 20, 20),
  new THREE.MeshBasicMaterial({ color: 0xffdd88, fog: false }));
const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(9, 20, 20),
  new THREE.MeshBasicMaterial({ color: 0xd8e2f5, fog: false }));
scene3.add(sunMesh, moonMesh);

const stars = (() => {
  const positions = [];
  for (let i = 0; i < 900; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(400);
    if (v.y > -30) positions.push(v.x, v.y, v.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff, size: 1.7, sizeAttenuation: false,
    transparent: true, opacity: 0, fog: false });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene3.add(points);
  return points;
})();

const _sunDir = new THREE.Vector3();
let lastClockText = '';

function updateSky() {
  const h = apparentHours();
  const ang = (h - 6) / 24 * Math.PI * 2; // 06:00 sunrise, 18:00 sunset
  _sunDir.set(Math.cos(ang), Math.sin(ang), 0.3).normalize();
  const elev = _sunDir.y;
  const day = THREE.MathUtils.smoothstep(elev, -0.06, 0.18);
  const dusk = Math.max(0, 1 - Math.abs(elev) / 0.22);

  skyColor.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_DUSK, dusk * 0.5);
  scene3.background = skyColor;
  if (scene3.fog) scene3.fog.color.copy(skyColor);

  sun.position.copy(_sunDir);
  sun.intensity = 0.1 + 2.3 * day;
  sun.color.copy(SUN_DAY).lerp(SUN_LOW, dusk);
  ambientLight.intensity = 0.22 + 0.68 * day;
  hemiLight.intensity = 0.12 + 0.42 * day;

  sunMesh.position.copy(camera.position).addScaledVector(_sunDir, 380);
  moonMesh.position.copy(camera.position).addScaledVector(_sunDir, -380);
  stars.material.opacity = (1 - day) * 0.9;
  stars.position.copy(camera.position);
  stars.rotation.z = ang * 0.25;

  const clockEl = document.getElementById('clock');
  if (clockEl) {
    const hh = String(Math.floor(h)).padStart(2, '0');
    const mm = String(Math.floor((h % 1) * 60)).padStart(2, '0');
    const mode = state.noclip ? 'no-clip'
      : (state.mode === 'fly' ? 'fly' : 'walk');
    const text = `☀ ${hh}:${mm} · ${timeState.speed}× realtime · ${mode}`;
    if (text !== lastClockText) {
      lastClockText = text;
      clockEl.textContent = text;
    }
  }
}

const chunkMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

// Highlight wireframe for the targeted voxel (unit cube, scaled per target)
const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x111111 }));
highlight.visible = false;
scene3.add(highlight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Voxel access (base grid: 1000 mm cells addressed in cell units)
// ---------------------------------------------------------------------------
const chunkKey = (cx, cz) => `${cx},${cz}`;
const subKey = (x, y, z, s) => `${x},${y},${z},${s}`;

function chunkAtCell(wx, wz) {
  return state.chunks.get(
    chunkKey(Math.floor(wx / CX), Math.floor(wz / CZ)));
}

function getVoxel(wx, wy, wz) {
  if (wy < 0 || wy >= CY) return 0;
  const chunk = chunkAtCell(wx, wz);
  if (!chunk || !chunk.data) return 0;
  const lx = wx - Math.floor(wx / CX) * CX;
  const lz = wz - Math.floor(wz / CZ) * CZ;
  return chunk.data[lx + lz * CX + wy * CX * CZ];
}

function setVoxel(wx, wy, wz, matId, sync = true) {
  if (wy < 0 || wy >= CY) return false;
  const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
  const chunk = state.chunks.get(chunkKey(cx, cz));
  if (!chunk || !chunk.data) return false;
  const lx = wx - cx * CX, lz = wz - cz * CZ;
  chunk.data[lx + lz * CX + wy * CX * CZ] = matId;
  rebuildChunk(chunk);
  // Rebuild neighbours when editing a border voxel so culled faces update.
  if (lx === 0) rebuildChunkAt(cx - 1, cz);
  if (lx === CX - 1) rebuildChunkAt(cx + 1, cz);
  if (lz === 0) rebuildChunkAt(cx, cz - 1);
  if (lz === CZ - 1) rebuildChunkAt(cx, cz + 1);
  if (sync) pushEdit({ op: 'set', x: wx, y: wy, z: wz, id: matId });
  if (fluidSim) fluidSim.disturbBlock(wx, wy, wz);
  return true;
}

// Sub-voxels: sparse, keyed by mm-aligned origin + size. `rebuild` lets
// callers batch many changes into one mesh rebuild.
function chunkAtMm(xMm, zMm) {
  return state.chunks.get(chunkKey(
    Math.floor(xMm / (CX * MM)), Math.floor(zMm / (CZ * MM))));
}

function setSubVoxel(xMm, yMm, zMm, sizeMm, matId, rebuild = true,
                     sync = true) {
  const chunk = chunkAtMm(xMm, zMm);
  if (!chunk) return false;
  const key = subKey(xMm, yMm, zMm, sizeMm);
  if (matId === 0) chunk.sub.delete(key);
  else chunk.sub.set(key, { x: xMm, y: yMm, z: zMm, s: sizeMm, mat: matId });
  if (sync) pushEdit({ op: 'sub', x: xMm, y: yMm, z: zMm, s: sizeMm, id: matId });
  if (rebuild) rebuildChunk(chunk);
  if (fluidSim) fluidSim.disturbMm(xMm, yMm, zMm, sizeMm);
  return true;
}

// ---------------------------------------------------------------------------
// 50 mm cell queries for the fluid simulation. Chunks keep an occupancy set
// of sub-voxel-covered cells (built during meshing) so lookups stay O(1).
// ---------------------------------------------------------------------------
const CELLS_PER_BLOCK = 20;    // 1000 mm / 50 mm
const cellKey = (x, y, z) => `${x},${y},${z}`;

function isSolidCell(cx, cy, cz) {
  const bx = Math.floor(cx / CELLS_PER_BLOCK);
  const by = Math.floor(cy / CELLS_PER_BLOCK);
  const bz = Math.floor(cz / CELLS_PER_BLOCK);
  if (by < 0 || by >= CY) return false;
  if (getVoxel(bx, by, bz)) return true;
  const chunk = chunkAtCell(bx, bz);
  return !!(chunk && chunk.subCells && chunk.subCells.has(cellKey(cx, cy, cz)));
}

// Returns the block occupying a 50 mm cell:
// {kind:'base', x,y,z, id} or {kind:'sub', x,y,z,s (mm), id} or null.
function blockAtCell(cx, cy, cz) {
  const bx = Math.floor(cx / CELLS_PER_BLOCK);
  const by = Math.floor(cy / CELLS_PER_BLOCK);
  const bz = Math.floor(cz / CELLS_PER_BLOCK);
  const base = getVoxel(bx, by, bz);
  if (base) return { kind: 'base', x: bx, y: by, z: bz, id: base };
  const chunk = chunkAtCell(bx, bz);
  if (!chunk || !chunk.subCells ||
      !chunk.subCells.has(cellKey(cx, cy, cz))) return null;
  const xMm = cx * 50, yMm = cy * 50, zMm = cz * 50;
  for (const sv of chunk.sub.values()) {
    if (xMm >= sv.x && xMm < sv.x + sv.s &&
        yMm >= sv.y && yMm < sv.y + sv.s &&
        zMm >= sv.z && zMm < sv.z + sv.s) {
      return { kind: 'sub', x: sv.x, y: sv.y, z: sv.z, s: sv.s, id: sv.mat };
    }
  }
  return null;
}

function subExactAtCell(cx, cy, cz) {
  const chunk = chunkAtCell(Math.floor(cx / CELLS_PER_BLOCK),
                            Math.floor(cz / CELLS_PER_BLOCK));
  if (!chunk) return null;
  return chunk.sub.get(subKey(cx * 50, cy * 50, cz * 50, 50)) || null;
}

function loadedFaucets() {
  const out = [];
  for (const chunk of state.chunks.values()) {
    if (chunk.faucets) out.push(...chunk.faucets);
  }
  return out;
}

function rebuildChunkAt(cx, cz) {
  const chunk = state.chunks.get(chunkKey(cx, cz));
  if (chunk && chunk.data) rebuildChunk(chunk);
}

// ---------------------------------------------------------------------------
// Voxel decomposition ("comprised of smaller voxels")
//
// Removing a small region from a bigger voxel decomposes the remainder into
// the largest aligned voxels possible, following the size chain
// 1000 -> 500 -> 100 -> 50 -> 10 mm (each divides the previous).
// ---------------------------------------------------------------------------
function decompose(ox, oy, oz, size, tx, ty, tz, ts, out) {
  if (size === ts) return; // this is exactly the removed cell
  const next = state.sizesMm[state.sizesMm.indexOf(size) + 1];
  const n = size / next;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        const x0 = ox + i * next, y0 = oy + j * next, z0 = oz + k * next;
        if (tx >= x0 && tx < x0 + next &&
            ty >= y0 && ty < y0 + next &&
            tz >= z0 && tz < z0 + next) {
          decompose(x0, y0, z0, next, tx, ty, tz, ts, out);
        } else {
          out.push([x0, y0, z0, next]);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Meshing: culled cube faces for the base grid plus boxes for sub-voxels,
// vertex-coloured per material with a per-voxel brightness jitter (this is
// what makes granite look speckled).
// ---------------------------------------------------------------------------
const FACES = [
  { dir: [1, 0, 0], corners: [[1,1,1],[1,0,1],[1,1,0],[1,0,0]], shade: 0.80 },
  { dir: [-1,0, 0], corners: [[0,1,0],[0,0,0],[0,1,1],[0,0,1]], shade: 0.80 },
  { dir: [0, 1, 0], corners: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]], shade: 1.00 },
  { dir: [0,-1, 0], corners: [[0,0,0],[1,0,0],[0,0,1],[1,0,1]], shade: 0.55 },
  { dir: [0, 0, 1], corners: [[1,1,1],[0,1,1],[1,0,1],[0,0,1]], shade: 0.72 },
  { dir: [0, 0,-1], corners: [[0,1,0],[1,1,0],[0,0,0],[1,0,0]], shade: 0.72 },
];

const matColorCache = [];
function materialRGB(matId) {
  let c = matColorCache[matId];
  if (!c) {
    const hex = state.materials[matId] ? state.materials[matId].color : '#ff00ff';
    c = [parseInt(hex.slice(1, 3), 16) / 255,
         parseInt(hex.slice(3, 5), 16) / 255,
         parseInt(hex.slice(5, 7), 16) / 255];
    matColorCache[matId] = c;
  }
  return c;
}

// Deterministic per-voxel jitter in [0.90, 1.10]
function voxelJitter(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return 0.90 + ((h >>> 16) & 0xff) / 255 * 0.20;
}

function rebuildChunk(chunk) {
  const positions = [], normals = [], colors = [], indices = [];
  const ox = chunk.cx * CX, oz = chunk.cz * CZ;
  const layer = CX * CZ;

  const emitBox = (bx, by, bz, size, matId, jitter, cullFn) => {
    const rgb = materialRGB(matId);
    for (const face of FACES) {
      if (cullFn && cullFn(face)) continue;
      const base = positions.length / 3;
      for (const c of face.corners) {
        positions.push(bx + c[0] * size, by + c[1] * size, bz + c[2] * size);
        normals.push(...face.dir);
        const s = face.shade * jitter;
        colors.push(
          Math.min(1, rgb[0] * s),
          Math.min(1, rgb[1] * s),
          Math.min(1, rgb[2] * s));
      }
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
  };

  // Base grid: full 1000 mm voxels with neighbour face culling. While we
  // scan, collect lamps and fluid faucets for the light/fluid systems.
  chunk.lamps = [];
  chunk.faucets = [];
  for (let y = 0; y < CY; y++) {
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const matId = chunk.data[x + z * CX + y * layer];
        if (!matId) continue;
        const wx = ox + x, wz = oz + z;
        const action = state.materials[matId] && state.materials[matId].action;
        if (action === 'lamp') chunk.lamps.push({ x: wx, y, z: wz });
        else if (action === 'faucet') {
          chunk.faucets.push({ x: wx, y, z: wz, id: matId });
        }
        emitBox(wx, y, wz, 1, matId, voxelJitter(wx, y, wz),
          (face) => getVoxel(wx + face.dir[0], y + face.dir[1],
                             wz + face.dir[2]) !== 0);
      }
    }
  }

  // Sub-voxel overlay: smaller variable-size voxels (positions in mm).
  // Also refresh the 50 mm occupancy set used by the fluid simulation.
  chunk.subCells = new Set();
  for (const sv of chunk.sub.values()) {
    emitBox(sv.x / MM, sv.y / MM, sv.z / MM, sv.s / MM, sv.mat,
      voxelJitter(sv.x / 10 | 0, sv.y / 10 | 0, sv.z / 10 | 0), null);
    const n = sv.s / 50;
    const cx0 = sv.x / 50, cy0 = sv.y / 50, cz0 = sv.z / 50;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n; k++) {
          chunk.subCells.add(cellKey(cx0 + i, cy0 + j, cz0 + k));
        }
      }
    }
  }

  if (chunk.mesh) {
    scene3.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.mesh = null;
  }
  if (!positions.length) return;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  chunk.mesh = new THREE.Mesh(geo, chunkMaterial);
  chunk.mesh.frustumCulled = true;
  scene3.add(chunk.mesh);
}

// ---------------------------------------------------------------------------
// Chunk streaming from the Python backend
// ---------------------------------------------------------------------------
let fetchesInFlight = 0;

function decodeVoxels(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Uint16Array(bytes.buffer);
}

async function fetchChunk(cx, cz) {
  const key = chunkKey(cx, cz);
  state.pending.add(key);
  fetchesInFlight++;
  try {
    const res = await fetch(
      `/api/chunk?scene=${state.scene.name}&cx=${cx}&cz=${cz}`);
    if (!res.ok) throw new Error(`chunk ${key}: HTTP ${res.status}`);
    const payload = await res.json();
    if (payload.scene !== state.scene.name) return; // scene switched mid-fetch
    const sub = new Map();
    for (const [x, y, z, s, mat] of payload.subvoxels || []) {
      sub.set(subKey(x, y, z, s), { x, y, z, s, mat });
    }
    const chunk = { cx, cz, data: decodeVoxels(payload.voxels), sub, mesh: null };
    state.chunks.set(key, chunk);
    rebuildChunk(chunk);
    // Refresh neighbours so their border faces get culled/created correctly.
    rebuildChunkAt(cx - 1, cz);
    rebuildChunkAt(cx + 1, cz);
    rebuildChunkAt(cx, cz - 1);
    rebuildChunkAt(cx, cz + 1);
  } catch (err) {
    console.error(err);
  } finally {
    state.pending.delete(key);
    fetchesInFlight--;
  }
}

function updateChunks() {
  if (!state.scene) return;
  const pcx = Math.floor(state.pos.x / CX);
  const pcz = Math.floor(state.pos.z / CZ);

  // Unload far chunks
  for (const [key, chunk] of state.chunks) {
    if (Math.abs(chunk.cx - pcx) > UNLOAD_RADIUS ||
        Math.abs(chunk.cz - pcz) > UNLOAD_RADIUS) {
      if (chunk.mesh) {
        scene3.remove(chunk.mesh);
        chunk.mesh.geometry.dispose();
      }
      state.chunks.delete(key);
    }
  }

  // Queue nearby chunks, closest first, limited concurrency
  const wanted = [];
  for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
    for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
      const cx = pcx + dx, cz = pcz + dz;
      const key = chunkKey(cx, cz);
      if (!state.chunks.has(key) && !state.pending.has(key)) {
        wanted.push({ cx, cz, d: dx * dx + dz * dz });
      }
    }
  }
  wanted.sort((a, b) => a.d - b.d);
  for (const w of wanted) {
    if (fetchesInFlight >= 4) break;
    fetchChunk(w.cx, w.cz);
  }
}

// ---------------------------------------------------------------------------
// Edit sync back to the backend (batched); the backend persists to disk so
// world changes survive server restarts.
// ---------------------------------------------------------------------------
let editQueue = [];
let editTimer = null;

function pushEdit(edit) {
  editQueue.push(edit);
  if (!editTimer) {
    editTimer = setTimeout(async () => {
      const edits = editQueue;
      editQueue = [];
      editTimer = null;
      try {
        await fetch('/api/edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene: state.scene.name, edits }),
        });
      } catch (err) {
        console.error('edit sync failed', err);
      }
    }, 250);
  }
}

// ---------------------------------------------------------------------------
// Block targeting.
// Base grid: Amanatides & Woo traversal. Sub-voxels: ray/AABB tests over the
// sparse overlay of nearby chunks. The nearer hit wins.
// Returns {kind, t, matId, normal, point, base?, sub?, sizeMm, boxMin, boxSize}
// ---------------------------------------------------------------------------
function rayBox(o, d, minV, maxV) {
  let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 1;
  const axes = ['x', 'y', 'z'];
  for (let i = 0; i < 3; i++) {
    const a = axes[i];
    const inv = 1 / (d[a] || 1e-12);
    let t0 = (minV[a] - o[a]) * inv;
    let t1 = (maxV[a] - o[a]) * inv;
    let sgn = d[a] > 0 ? -1 : 1;   // normal of the entry face
    if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; }
    if (t0 > tmin) { tmin = t0; axis = i; sign = sgn; }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return null;
  }
  if (tmin < 0 || axis < 0) return null;
  const normal = { x: 0, y: 0, z: 0 };
  normal[axes[axis]] = sign;
  return { t: tmin, normal };
}

function raycastVoxel() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const o = camera.position;

  // --- base grid DDA ---
  let baseHit = null;
  {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const stepX = Math.sign(dir.x) || 1, stepY = Math.sign(dir.y) || 1,
          stepZ = Math.sign(dir.z) || 1;
    const tDeltaX = Math.abs(1 / (dir.x || 1e-10));
    const tDeltaY = Math.abs(1 / (dir.y || 1e-10));
    const tDeltaZ = Math.abs(1 / (dir.z || 1e-10));
    let tMaxX = tDeltaX * (stepX > 0 ? (x + 1 - o.x) : (o.x - x));
    let tMaxY = tDeltaY * (stepY > 0 ? (y + 1 - o.y) : (o.y - y));
    let tMaxZ = tDeltaZ * (stepZ > 0 ? (z + 1 - o.z) : (o.z - z));
    let tEntry = 0;
    let normal = { x: 0, y: 1, z: 0 };
    while (tEntry <= REACH) {
      const matId = getVoxel(x, y, z);
      if (matId) {
        baseHit = { t: tEntry, cell: { x, y, z }, matId, normal };
        break;
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        tEntry = tMaxX; tMaxX += tDeltaX; x += stepX;
        normal = { x: -stepX, y: 0, z: 0 };
      } else if (tMaxY < tMaxZ) {
        tEntry = tMaxY; tMaxY += tDeltaY; y += stepY;
        normal = { x: 0, y: -stepY, z: 0 };
      } else {
        tEntry = tMaxZ; tMaxZ += tDeltaZ; z += stepZ;
        normal = { x: 0, y: 0, z: -stepZ };
      }
    }
  }

  // --- sub-voxel overlay ---
  let subHit = null;
  const c0x = Math.floor((o.x - REACH) / CX), c1x = Math.floor((o.x + REACH) / CX);
  const c0z = Math.floor((o.z - REACH) / CZ), c1z = Math.floor((o.z + REACH) / CZ);
  for (let cz = c0z; cz <= c1z; cz++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const chunk = state.chunks.get(chunkKey(cx, cz));
      if (!chunk || chunk.sub.size === 0) continue;
      for (const sv of chunk.sub.values()) {
        const minV = { x: sv.x / MM, y: sv.y / MM, z: sv.z / MM };
        const maxV = { x: (sv.x + sv.s) / MM, y: (sv.y + sv.s) / MM,
                       z: (sv.z + sv.s) / MM };
        const hit = rayBox(o, dir, minV, maxV);
        if (hit && hit.t <= REACH && (!subHit || hit.t < subHit.t)) {
          subHit = { t: hit.t, sv, normal: hit.normal };
        }
      }
    }
  }

  const useSub = subHit && (!baseHit || subHit.t < baseHit.t);
  if (!useSub && !baseHit) return null;

  const t = useSub ? subHit.t : baseHit.t;
  const point = o.clone().addScaledVector(dir, t);
  if (useSub) {
    const sv = subHit.sv;
    return {
      kind: 'sub', t, point, matId: sv.mat, normal: subHit.normal,
      sub: sv, sizeMm: sv.s,
      boxMin: new THREE.Vector3(sv.x / MM, sv.y / MM, sv.z / MM),
      boxSize: sv.s / MM,
    };
  }
  const c = baseHit.cell;
  return {
    kind: 'base', t, point, matId: baseHit.matId, normal: baseHit.normal,
    base: c, sizeMm: MM,
    boxMin: new THREE.Vector3(c.x, c.y, c.z), boxSize: 1,
  };
}

// ---------------------------------------------------------------------------
// Inventory (the "store" part of create/destroy/store)
// ---------------------------------------------------------------------------
function storedCount(matId) {
  return state.inventory.get(matId) || 0;
}

function storeBlock(matId) {
  state.inventory.set(matId, storedCount(matId) + 1);
  renderHotbar();
}

function consumeBlock(matId) {
  const n = storedCount(matId);
  if (n > 0) state.inventory.set(matId, n - 1);
  renderHotbar();
}

// ---------------------------------------------------------------------------
// Create / destroy / carve
// ---------------------------------------------------------------------------
const floorTo = (vMm, sMm) => Math.floor(vMm / sMm) * sMm;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Pick the tool-size cell inside the target voxel nearest the hit point.
function innerCell(target, tool) {
  const eps = 0.5; // half a millimetre inside the surface
  const px = target.point.x * MM - target.normal.x * eps;
  const py = target.point.y * MM - target.normal.y * eps;
  const pz = target.point.z * MM - target.normal.z * eps;
  const o = target.kind === 'sub'
    ? { x: target.sub.x, y: target.sub.y, z: target.sub.z }
    : { x: target.base.x * MM, y: target.base.y * MM, z: target.base.z * MM };
  const size = target.sizeMm;
  return {
    x: clamp(floorTo(px, tool), o.x, o.x + size - tool),
    y: clamp(floorTo(py, tool), o.y, o.y + size - tool),
    z: clamp(floorTo(pz, tool), o.z, o.z + size - tool),
  };
}

function destroyBlock() {
  const t = state.target;
  if (!t) return;
  const tool = toolSizeMm();

  if (tool < t.sizeMm) {
    // Carve: remove a tool-sized piece out of a bigger voxel and decompose
    // the remainder into smaller voxels of the same material.
    const cell = innerCell(t, tool);
    const remainder = [];
    if (t.kind === 'base') {
      const ox = t.base.x * MM, oy = t.base.y * MM, oz = t.base.z * MM;
      decompose(ox, oy, oz, MM, cell.x, cell.y, cell.z, tool, remainder);
    } else {
      decompose(t.sub.x, t.sub.y, t.sub.z, t.sub.s,
                cell.x, cell.y, cell.z, tool, remainder);
      setSubVoxel(t.sub.x, t.sub.y, t.sub.z, t.sub.s, 0, false);
    }
    for (const [x, y, z, s] of remainder) {
      setSubVoxel(x, y, z, s, t.matId, false);
    }
    if (t.kind === 'base') {
      // setVoxel rebuilds the chunk, which also picks up the new sub-voxels.
      setVoxel(t.base.x, t.base.y, t.base.z, 0);
    } else {
      const chunk = chunkAtMm(t.sub.x, t.sub.z);
      if (chunk) rebuildChunk(chunk);
    }
    storeBlock(t.matId);
    return;
  }

  // Tool is at least as big as the hit voxel: hollow out the whole
  // tool-aligned cell around the hit point. That may remove several
  // smaller voxels in one strike.
  const eps = 0.5;
  const px = t.point.x * MM - t.normal.x * eps;
  const py = t.point.y * MM - t.normal.y * eps;
  const pz = t.point.z * MM - t.normal.z * eps;
  const rx = floorTo(px, tool), ry = floorTo(py, tool),
        rz = floorTo(pz, tool);

  if (tool === MM) {
    const bx = rx / MM, by = ry / MM, bz = rz / MM;
    if (getVoxel(bx, by, bz)) {
      storeBlock(t.matId);
      setVoxel(bx, by, bz, 0);
    }
  }
  clearSubsInBox(rx, ry, rz, tool);
}

// Remove every sub-voxel fully inside the tool-aligned box; if a *bigger*
// sub-voxel fully contains the box, carve the box out of it instead.
function clearSubsInBox(x, y, z, size) {
  const chunk = chunkAtMm(x, z);
  if (!chunk) return;
  let removed = 0;
  let container = null;
  for (const sv of [...chunk.sub.values()]) {
    if (sv.x >= x && sv.x + sv.s <= x + size &&
        sv.y >= y && sv.y + sv.s <= y + size &&
        sv.z >= z && sv.z + sv.s <= z + size) {
      setSubVoxel(sv.x, sv.y, sv.z, sv.s, 0, false);
      state.inventory.set(sv.mat, storedCount(sv.mat) + 1);
      removed++;
    } else if (sv.s > size &&
               x >= sv.x && x + size <= sv.x + sv.s &&
               y >= sv.y && y + size <= sv.y + sv.s &&
               z >= sv.z && z + size <= sv.z + sv.s) {
      container = sv;
    }
  }
  if (container) {
    const remainder = [];
    decompose(container.x, container.y, container.z, container.s,
              x, y, z, size, remainder);
    setSubVoxel(container.x, container.y, container.z, container.s, 0, false);
    for (const [nx, ny, nz, ns] of remainder) {
      setSubVoxel(nx, ny, nz, ns, container.mat, false);
    }
    state.inventory.set(container.mat, storedCount(container.mat) + 1);
    removed++;
  }
  if (removed) {
    renderHotbar();
    rebuildChunk(chunk);
  }
}

function subOverlaps(xMm, yMm, zMm, sMm) {
  const chunk = chunkAtMm(xMm, zMm);
  if (!chunk) return false;
  for (const sv of chunk.sub.values()) {
    if (xMm < sv.x + sv.s && xMm + sMm > sv.x &&
        yMm < sv.y + sv.s && yMm + sMm > sv.y &&
        zMm < sv.z + sv.s && zMm + sMm > sv.z) return true;
  }
  return false;
}

function cellHasSubs(cellX, cellY, cellZ) {
  return subOverlaps(cellX * MM, cellY * MM, cellZ * MM, MM);
}

function targetBaseCell(t) {
  return t.kind === 'base'
    ? t.base
    : { x: Math.floor(t.sub.x / MM), y: Math.floor(t.sub.y / MM),
        z: Math.floor(t.sub.z / MM) };
}

function placeBlock() {
  const t = state.target;
  if (!t) return;
  // Right-clicking an actionable "touch" material triggers it instead of
  // placing a block against it.
  const tm = state.materials[t.matId];
  if (tm && tm.action === 'touch') {
    const c = targetBaseCell(t);
    sendGameEvent('touch', c, 'on');
    showToast(`Touched ${tm.name}`);
    return;
  }
  const tool = toolSizeMm();
  const matId = state.hotbar[state.activeSlot].matId;
  if (!matId) return;

  // Point just outside the hit surface, in mm.
  const eps = 0.5;
  const px = t.point.x * MM + t.normal.x * eps;
  const py = t.point.y * MM + t.normal.y * eps;
  const pz = t.point.z * MM + t.normal.z * eps;

  if (tool === MM) {
    // Full default-size voxel on the base grid.
    const x = Math.floor(px / MM), y = Math.floor(py / MM),
          z = Math.floor(pz / MM);
    if (getVoxel(x, y, z) || cellHasSubs(x, y, z)) return;
    const cam = camera.position;
    if (Math.floor(cam.x) === x && Math.floor(cam.z) === z &&
        (Math.floor(cam.y) === y || Math.floor(cam.y) - 1 === y)) return;
    if (setVoxel(x, y, z, matId)) consumeBlock(matId);
    return;
  }

  // Smaller voxel, aligned to its own mm grid.
  const x = floorTo(px, tool), y = floorTo(py, tool), z = floorTo(pz, tool);
  if (y < 0 || y >= CY * MM) return;
  const cellX = Math.floor(x / MM), cellY = Math.floor(y / MM),
        cellZ = Math.floor(z / MM);
  if (getVoxel(cellX, cellY, cellZ)) return;  // inside a solid voxel
  if (subOverlaps(x, y, z, tool)) return;     // overlaps another sub-voxel
  if (setSubVoxel(x, y, z, tool, matId)) consumeBlock(matId);
}

function pickBlock() {
  const t = state.target;
  if (!t) return;
  state.hotbar[state.activeSlot].matId = t.matId;
  renderHotbar();
}

function cycleVoxelSize(delta) {
  const n = state.sizesMm.length;
  state.sizeIdx = (state.sizeIdx + delta + n) % n;
  renderSizeInfo();
}

// ---------------------------------------------------------------------------
// Actionable materials: touch / light / pressure events sent to the backend
// ---------------------------------------------------------------------------
function sendGameEvent(action, cell, stateStr) {
  fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scene: state.scene.name,
      events: [{ action, x: cell.x, y: cell.y, z: cell.z, state: stateStr }],
    }),
  }).catch((err) => console.error('event send failed', err));
}

// Light sensor: fires while the player's view ray rests on it.
function updateLightGaze() {
  const t = state.target;
  const m = t && state.materials[t.matId];
  const cell = m && m.action === 'light' ? targetBaseCell(t) : null;
  const k = cell ? `${cell.x},${cell.y},${cell.z}` : null;
  if (k === state.lightGaze) return;
  if (state.lightGaze) {
    const [x, y, z] = state.lightGaze.split(',').map(Number);
    sendGameEvent('light', { x, y, z }, 'off');
  }
  if (k) {
    sendGameEvent('light', cell, 'on');
    showToast('Light sensor lit');
  }
  state.lightGaze = k;
}

// Pressure plate: fires while the player is directly above one.
function updatePressure() {
  const fx = Math.floor(state.pos.x), fz = Math.floor(state.pos.z);
  let found = null;
  for (let dy = 1; dy <= 3; dy++) {
    const y = Math.floor(state.pos.y) - dy;
    const m = state.materials[getVoxel(fx, y, fz)];
    if (m && m.action === 'pressure') { found = { x: fx, y, z: fz }; break; }
  }
  const k = found ? `${found.x},${found.y},${found.z}` : null;
  if (k === state.pressureCell) return;
  if (state.pressureCell) {
    const [x, y, z] = state.pressureCell.split(',').map(Number);
    sendGameEvent('pressure', { x, y, z }, 'off');
  }
  if (k) {
    sendGameEvent('pressure', found, 'on');
    showToast('Pressure plate pressed');
  }
  state.pressureCell = k;
}

// ---------------------------------------------------------------------------
// Lamps: Lamp voxels become real point lights whose colour and strength are
// governed by the glass around them (stained glass tints, tinted glass dims,
// clear glass brightens).
// ---------------------------------------------------------------------------
const MAX_LAMP_LIGHTS = 8;
const lampLights = [];

function lampProperties(lamp) {
  const tints = [];
  let intensity = 14, distance = 11;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
                              [0, 0, 1], [0, 0, -1]]) {
    const m = state.materials[getVoxel(lamp.x + dx, lamp.y + dy, lamp.z + dz)];
    if (!m) continue;
    if (m.name.includes('Stained Glass')) tints.push(new THREE.Color(m.color));
    else if (m.name === 'Tinted Glass') { intensity *= 0.35; distance *= 0.7; }
    else if (m.name === 'Glass') { intensity *= 1.4; distance *= 1.2; }
  }
  let color = new THREE.Color('#fff1cf'); // warm white by default
  if (tints.length) {
    color = new THREE.Color(0, 0, 0);
    for (const tc of tints) color.add(tc);
    color.multiplyScalar(1 / tints.length);
  }
  return { color, intensity, distance };
}

function updateLampLights() {
  const lamps = [];
  for (const chunk of state.chunks.values()) {
    if (chunk.lamps) lamps.push(...chunk.lamps);
  }
  lamps.sort((a, b) =>
    state.pos.distanceToSquared(new THREE.Vector3(a.x, a.y, a.z)) -
    state.pos.distanceToSquared(new THREE.Vector3(b.x, b.y, b.z)));
  const active = lamps.slice(0, MAX_LAMP_LIGHTS);
  while (lampLights.length < active.length) {
    const light = new THREE.PointLight(0xffffff, 0, 10, 1.6);
    scene3.add(light);
    lampLights.push(light);
  }
  for (let i = 0; i < lampLights.length; i++) {
    const light = lampLights[i];
    if (i < active.length) {
      const lamp = active[i];
      const p = lampProperties(lamp);
      light.position.set(lamp.x + 0.5, lamp.y + 0.5, lamp.z + 0.5);
      light.color.copy(p.color);
      light.intensity = p.intensity;
      light.distance = p.distance;
    } else {
      light.intensity = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Live sync: poll the backend for world edits and screen changes it (or
// other clients) made, and apply them without echoing them back.
// ---------------------------------------------------------------------------
function applyRemoteEdit(e) {
  if (e.op === 'set') {
    if (getVoxel(e.x, e.y, e.z) !== e.id) {
      setVoxel(e.x, e.y, e.z, e.id, false);
    }
  } else if (e.op === 'sub') {
    const chunk = chunkAtMm(e.x, e.z);
    if (!chunk) return;
    const cur = chunk.sub.get(subKey(e.x, e.y, e.z, e.s));
    const same = e.id === 0 ? !cur : (cur && cur.mat === e.id);
    if (!same) setSubVoxel(e.x, e.y, e.z, e.s, e.id, true, false);
  }
}

async function pollUpdates() {
  if (!state.started || !state.scene) return;
  const sceneName = state.scene.name;
  try {
    const res = await fetch(
      `/api/updates?scene=${sceneName}&since=${state.rev}`);
    if (!res.ok) return;
    const p = await res.json();
    if (!state.scene || state.scene.name !== sceneName) return;
    state.rev = p.rev;
    for (const e of p.edits || []) applyRemoteEdit(e);
    if (screenMgr) screenMgr.applyVersions(p.screens || {});
    syncTime(p.time);
  } catch { /* transient network error; next poll retries */ }
}
setInterval(pollUpdates, 2000);

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const hotbarEl = el('hotbar');
const sceneInfoEl = el('scene-info');
const targetInfoEl = el('target-info');
const sizeInfoEl = el('size-info');
const matModal = el('mat-modal');
const invModal = el('inv-modal');

let toastTimer = null;
function showToast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), 2500);
}

function renderHotbar() {
  hotbarEl.innerHTML = '';
  state.hotbar.forEach((slot, i) => {
    const div = document.createElement('div');
    div.className = 'slot' + (i === state.activeSlot ? ' active' : '');
    const mat = state.materials[slot.matId];
    const count = storedCount(slot.matId);
    div.innerHTML = `
      <span class="num">${i + 1}</span>
      <span class="swatch" style="background:${mat ? mat.color : '#222'}"></span>
      <span class="count">${count > 0 ? count : '∞'}</span>
      <span class="label">${mat ? mat.name : ''}</span>`;
    div.addEventListener('click', () => { state.activeSlot = i; renderHotbar(); });
    hotbarEl.appendChild(div);
  });
}

function renderSizeInfo() {
  const s = toolSizeMm();
  sizeInfoEl.innerHTML =
    `Voxel size: <b>${s} mm</b> ` +
    `<span class="muted">(G / V to change · min ${state.sizesMm[state.sizesMm.length - 1]} mm · ` +
    `smaller sizes carve big voxels into smaller ones)</span>`;
}

function renderSceneInfo() {
  const s = state.scene;
  sceneInfoEl.innerHTML =
    `<b>${s.title}</b> — ${s.description}<br>` +
    `<span class="muted">${state.materials.length - 1} materials · ` +
    `scene generated by the Python backend</span><br>`;
  const select = document.createElement('select');
  for (const meta of state.config.scenes) {
    const opt = document.createElement('option');
    opt.value = meta.name;
    opt.textContent = meta.title;
    opt.selected = meta.name === s.name;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const meta = state.config.scenes.find((m) => m.name === select.value);
    if (meta) activateScene(meta);
  });
  sceneInfoEl.appendChild(select);
}

function renderTargetInfo() {
  const t = state.target;
  if (t) {
    const m = state.materials[t.matId];
    const where = t.kind === 'base'
      ? `(${t.base.x}, ${t.base.y}, ${t.base.z})`
      : `(${t.sub.x}, ${t.sub.y}, ${t.sub.z}) mm`;
    targetInfoEl.innerHTML =
      `Looking at: <b>${m ? m.name : '?'}</b> ` +
      `<span class="muted">${t.sizeMm} mm voxel · ${where} · ` +
      `${m ? m.category : ''}</span>`;
  } else {
    targetInfoEl.innerHTML = '<span class="muted">No block in reach</span>';
  }
}

function renderInventory() {
  const rows = [...state.inventory.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const list = el('inv-list');
  if (!rows.length) {
    list.innerHTML =
      '<p class="muted">Nothing stored yet — mine some blocks with left click.</p>';
    return;
  }
  list.innerHTML = '<table>' + rows.map(([id, n]) => {
    const m = state.materials[id];
    return `<tr><td><span class="sw" style="background:${m.color}"></span></td>` +
      `<td>${m.name}</td><td class="muted">${m.category}</td>` +
      `<td style="text-align:right"><b>${n}</b></td></tr>`;
  }).join('') + '</table>';
}

function renderMaterialBrowser(filter = '') {
  const grid = el('mat-grid');
  const q = filter.trim().toLowerCase();
  const all = state.materials.filter(Boolean);
  const matches = q
    ? all.filter((m) => m.name.toLowerCase().includes(q) ||
                        m.category.toLowerCase().includes(q))
    : all;
  el('mat-count').textContent =
    `${matches.length} of ${all.length} materials` +
    (matches.length > 400 ? ' (showing first 400)' : '');
  grid.innerHTML = '';
  for (const m of matches.slice(0, 400)) {
    const tile = document.createElement('div');
    tile.className = 'mat-tile';
    tile.innerHTML = `<span class="sw" style="background:${m.color}"></span>` +
      `<span><div class="nm">${m.name}</div><div class="cat">${m.category}` +
      ` · stored: ${storedCount(m.id)}</div></span>`;
    tile.addEventListener('click', () => {
      state.hotbar[state.activeSlot].matId = m.id;
      renderHotbar();
      closeModals();
      renderer.domElement.requestPointerLock();
    });
    grid.appendChild(tile);
  }
}

function anyModalOpen() {
  return matModal.classList.contains('visible') ||
         invModal.classList.contains('visible');
}

function closeModals() {
  matModal.classList.remove('visible');
  invModal.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (!state.started) return;

  if (e.code === 'KeyE' && !matModal.classList.contains('visible')) {
    e.preventDefault();
    closeModals();
    document.exitPointerLock();
    renderMaterialBrowser(el('mat-search').value);
    matModal.classList.add('visible');
    el('mat-search').focus();
    return;
  }
  if (e.code === 'KeyQ' && !anyModalOpen()) {
    document.exitPointerLock();
    renderInventory();
    invModal.classList.add('visible');
    return;
  }
  if (e.code === 'Escape' && anyModalOpen()) {
    closeModals();
    return;
  }
  if (anyModalOpen()) return;

  if (e.code === 'KeyG') cycleVoxelSize(1);   // smaller
  if (e.code === 'KeyV') cycleVoxelSize(-1);  // bigger
  if (e.code === 'KeyN') {
    state.noclip = !state.noclip;
    showToast(`No-clip ${state.noclip ? 'on — collision off' : 'off — collision on'}`);
  }
  if (e.code === 'Space' && !e.repeat) {
    const now = performance.now();
    if (now - (state.lastSpaceTap || 0) < 400) {
      state.mode = state.mode === 'fly' ? 'walk' : 'fly';
      state.vy = 0;
      showToast(state.mode === 'fly'
        ? 'Fly mode — Space/Shift for up/down'
        : 'Walk mode — gravity on, Space to jump');
      state.lastSpaceTap = 0;
    } else {
      state.lastSpaceTap = now;
    }
  }

  if (e.code.startsWith('Digit')) {
    const n = parseInt(e.code.slice(5), 10);
    if (n >= 1 && n <= state.hotbar.length) {
      state.activeSlot = n - 1;
      renderHotbar();
    }
  }
  state.keys.add(e.code);
});

document.addEventListener('keyup', (e) => state.keys.delete(e.code));

document.addEventListener('mousemove', (e) => {
  if (!state.pointerLocked) return;
  state.yaw -= e.movementX * 0.0024;
  state.pitch -= e.movementY * 0.0024;
  const lim = Math.PI / 2 - 0.01;
  state.pitch = Math.max(-lim, Math.min(lim, state.pitch));
});

renderer.domElement.addEventListener('mousedown', (e) => {
  if (!state.started || anyModalOpen()) return;
  if (!state.pointerLocked) {
    renderer.domElement.requestPointerLock();
    return;
  }
  if (e.button === 0) destroyBlock();
  else if (e.button === 1) { e.preventDefault(); pickBlock(); }
  else if (e.button === 2) placeBlock();
});
document.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('pointerlockchange', () => {
  state.pointerLocked = document.pointerLockElement === renderer.domElement;
  if (!state.pointerLocked) state.keys.clear();
});
window.addEventListener('blur', () => state.keys.clear());

el('mat-search').addEventListener('input',
  (e) => renderMaterialBrowser(e.target.value));

matModal.addEventListener('mousedown', (e) => {
  if (e.target === matModal) closeModals();
});
invModal.addEventListener('mousedown', (e) => {
  if (e.target === invModal) closeModals();
});

// ---------------------------------------------------------------------------
// Movement & main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
let lastChunkUpdate = 0;
let lastLampUpdate = 0;
let fluidAcc = 0;
const FLUID_TICK = 0.1; // seconds; the config's tickMs is advisory

// Player collision: an axis-aligned box around the camera (eye point) that
// may not intersect solid matter — base voxels or sub-voxels of any size.
const PLAYER_HALF = 0.32;   // half width (m)
const PLAYER_DOWN = 1.55;   // eye to feet
const PLAYER_UP = 0.25;     // eye to top of head

function boxCollides(px, py, pz) {
  const minX = px - PLAYER_HALF, maxX = px + PLAYER_HALF;
  const minY = py - PLAYER_DOWN, maxY = py + PLAYER_UP;
  const minZ = pz - PLAYER_HALF, maxZ = pz + PLAYER_HALF;
  for (let bx = Math.floor(minX); bx <= Math.floor(maxX); bx++) {
    for (let by = Math.floor(minY); by <= Math.floor(maxY); by++) {
      for (let bz = Math.floor(minZ); bz <= Math.floor(maxZ); bz++) {
        if (getVoxel(bx, by, bz)) return true;
      }
    }
  }
  const c0x = Math.floor(minX / CX), c1x = Math.floor(maxX / CX);
  const c0z = Math.floor(minZ / CZ), c1z = Math.floor(maxZ / CZ);
  for (let cz = c0z; cz <= c1z; cz++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const chunk = state.chunks.get(chunkKey(cx, cz));
      if (!chunk || !chunk.sub || chunk.sub.size === 0) continue;
      for (const sv of chunk.sub.values()) {
        if (minX * MM < sv.x + sv.s && maxX * MM > sv.x &&
            minY * MM < sv.y + sv.s && maxY * MM > sv.y &&
            minZ * MM < sv.z + sv.s && maxZ * MM > sv.z) return true;
      }
    }
  }
  return false;
}

function updateMovement(dt) {
  if (anyModalOpen()) return;
  const flying = state.mode === 'fly' || state.noclip;
  const forward = new THREE.Vector3(
    -Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);

  // Horizontal input works in every mode — including mid-fall.
  const move = new THREE.Vector3();
  if (state.keys.has('KeyW')) move.add(forward);
  if (state.keys.has('KeyS')) move.sub(forward);
  if (state.keys.has('KeyD')) move.add(right);
  if (state.keys.has('KeyA')) move.sub(right);
  const sprint = state.keys.has('KeyF');

  if (flying) {
    if (state.keys.has('Space')) move.y += 1;
    if (state.keys.has('ShiftLeft') || state.keys.has('ShiftRight')) {
      move.y -= 1;
    }
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(
        FLY_SPEED * (sprint ? SPRINT_MULT : 1) * dt);
    }
    state.vy = 0;
    state.grounded = false;
  } else {
    // Walk mode: gravity pulls, Space jumps from the ground.
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(
        WALK_SPEED * (sprint ? WALK_SPRINT_MULT : 1) * dt);
    }
    state.vy = Math.max(state.vy - GRAVITY * dt, -TERMINAL_VELOCITY);
    if (state.keys.has('Space') && state.grounded) {
      state.vy = JUMP_VELOCITY;
      state.grounded = false;
    }
    move.y = state.vy * dt;
  }

  if (state.noclip) {
    state.pos.add(move);
  } else {
    // Resolve each axis separately so we slide along walls. If we are
    // already stuck inside something (e.g. a block placed on us), allow
    // movement so the player can escape.
    const stuck = boxCollides(state.pos.x, state.pos.y, state.pos.z);
    const p = state.pos;
    if (stuck || !boxCollides(p.x + move.x, p.y, p.z)) p.x += move.x;
    if (stuck || !boxCollides(p.x, p.y, p.z + move.z)) p.z += move.z;
    if (stuck || !boxCollides(p.x, p.y + move.y, p.z)) {
      p.y += move.y;
      if (!flying) state.grounded = false;
    } else if (!flying) {
      // Vertical motion blocked: landed (falling) or bonked (jumping).
      if (state.vy < 0) state.grounded = true;
      state.vy = 0;
    }
  }
  state.pos.y = Math.max(1, Math.min(CY + 40, state.pos.y));
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (state.started) {
    updateMovement(dt);
    camera.position.copy(state.pos);
    camera.quaternion.setFromEuler(
      new THREE.Euler(state.pitch, state.yaw, 0, 'YXZ'));

    const now = performance.now();
    if (now - lastChunkUpdate > 250) {
      lastChunkUpdate = now;
      updateChunks();
    }
    if (now - lastLampUpdate > 500) {
      lastLampUpdate = now;
      updateLampLights();
      updatePressure();
    }
    if (fluidSim) {
      fluidAcc += dt;
      while (fluidAcc >= FLUID_TICK) {
        fluidAcc -= FLUID_TICK;
        fluidSim.tick();
      }
    }

    state.target = raycastVoxel();
    updateLightGaze();
    updateSky();
    if (state.target) {
      const t = state.target;
      highlight.position.set(
        t.boxMin.x + t.boxSize / 2,
        t.boxMin.y + t.boxSize / 2,
        t.boxMin.z + t.boxSize / 2);
      highlight.scale.setScalar(t.boxSize);
      highlight.visible = true;
    } else {
      highlight.visible = false;
    }
    renderTargetInfo();
  }

  renderer.render(scene3, camera);
}

// ---------------------------------------------------------------------------
// Scene management & boot
// ---------------------------------------------------------------------------
function clearWorld() {
  for (const chunk of state.chunks.values()) {
    if (chunk.mesh) {
      scene3.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
  }
  state.chunks.clear();
  state.pending.clear();
}

async function activateScene(meta) {
  clearWorld();
  state.scene = meta;
  state.pos.set(meta.spawn[0], meta.spawn[1], meta.spawn[2]);
  [state.yaw, state.pitch] = meta.look || [Math.PI * 0.25, -0.25];
  state.lightGaze = null;
  state.pressureCell = null;
  if (fluidSim) fluidSim.clear();
  if (screenMgr) {
    screenMgr.clear();
    screenMgr.load();
  }
  // Baseline revision so the updates poll only brings future changes.
  try {
    const res = await fetch(`/api/updates?scene=${meta.name}`);
    state.rev = (await res.json()).rev || 0;
  } catch { state.rev = 0; }
  renderSceneInfo();
  renderSizeInfo();
  updateChunks();
}

function defaultHotbar() {
  const byName = {};
  for (const m of state.materials) if (m) byName[m.name] = m.id;
  const picks = ['Granite', 'Polished Granite', 'Oak Planks', 'Glass',
                 'Gold Block', 'Marble', 'Red Brick', 'Element: Copper',
                 'Blue Stained Glass'];
  state.hotbar = picks.map((name) => ({ matId: byName[name] || 1 }));
}

async function boot() {
  const statusEl = el('loading-status');
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.config = await res.json();
  } catch (err) {
    statusEl.textContent =
      'Could not reach the Python backend. Start it with "python3 server.py" ' +
      `and reload. (${err.message})`;
    return;
  }

  [CX, CY, CZ] = state.config.chunkSize;
  if (state.config.voxelSizesMm) {
    state.sizesMm = state.config.voxelSizesMm.map((s) => s | 0);
    state.sizeIdx = Math.max(
      0, state.sizesMm.indexOf(state.config.defaultVoxelSizeMm | 0));
  }
  state.materials = [];
  for (const m of state.config.materials) state.materials[m.id] = m;

  screenMgr = createScreenManager({
    THREE, scene3,
    getSceneName: () => (state.scene ? state.scene.name : ''),
  });
  fluidSim = createFluidSim({
    THREE, scene3,
    config: state.config.fluids || {},
    materials: state.materials,
    toast: showToast,
    world: {
      isSolidCell,
      blockAtCell,
      subExactAtCell,
      faucets: loadedFaucets,
      setBase: (x, y, z, id) => setVoxel(x, y, z, id),
      setSub: (x, y, z, s, id) => setSubVoxel(x, y, z, s, id),
    },
  });

  const select = el('scene-select');
  for (const s of state.config.scenes) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.title} — ${s.description}`;
    if (s.name === state.config.defaultScene) opt.selected = true;
    select.appendChild(opt);
  }

  defaultHotbar();
  try {
    syncTime(await (await fetch('/api/time')).json());
  } catch { /* keep the default 09:00 clock until the first poll */ }
  statusEl.hidden = true;
  el('start-ready').hidden = false;

  el('start-btn').addEventListener('click', () => {
    state.started = true;
    el('start-modal').classList.remove('visible');
    for (const id of ['crosshair', 'hud-top', 'hotbar', 'hint', 'clock']) {
      el(id).hidden = false;
    }
    const meta = state.config.scenes.find((s) => s.name === select.value);
    activateScene(meta);
    renderHotbar();
    renderer.domElement.requestPointerLock();
  });
}

boot();
animate();

// Debug/testing hook (also handy in the browser console).
window.__voxel = {
  state, getVoxel, setVoxel, setSubVoxel, destroyBlock, placeBlock,
  pickBlock, raycastVoxel, storedCount, cycleVoxelSize, decompose,
  toolSizeMm, sendGameEvent, isSolidCell, blockAtCell, loadedFaucets,
  getScreens: () => screenMgr, getFluids: () => fluidSim, pollUpdates,
  lampLights, boxCollides, apparentHours, syncTime, timeState,
};
