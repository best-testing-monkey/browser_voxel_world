import * as THREE from '/vendor/three.module.js';

// ---------------------------------------------------------------------------
// Config & state
// ---------------------------------------------------------------------------
const LOAD_RADIUS = 3;          // chunks around the player to load
const UNLOAD_RADIUS = LOAD_RADIUS + 2;
const REACH = 8;                // block interaction distance
const FLY_SPEED = 12;
const SPRINT_MULT = 2.6;

let CX = 16, CY = 64, CZ = 16;  // chunk dimensions (from backend config)

const state = {
  config: null,
  materials: [],                // by id (index 0 unused)
  scene: null,                  // active scene meta
  chunks: new Map(),            // "cx,cz" -> {cx, cz, data:Uint16Array, mesh}
  pending: new Set(),           // chunk keys being fetched
  inventory: new Map(),         // matId -> stored count
  hotbar: [],                   // [{matId}]
  activeSlot: 0,
  yaw: 0, pitch: 0,
  pos: new THREE.Vector3(),
  keys: new Set(),
  pointerLocked: false,
  started: false,
  target: null,                 // {hit:{x,y,z}, prev:{x,y,z}, matId}
};

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
  75, window.innerWidth / window.innerHeight, 0.1, 600);

const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(0.45, 1, 0.3);
scene3.add(sun);
scene3.add(new THREE.AmbientLight(0xbfd4ea, 0.9));
const hemi = new THREE.HemisphereLight(0xcfe5ff, 0x6b6252, 0.5);
scene3.add(hemi);

const chunkMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });

// Highlight wireframe for the targeted block
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
// Voxel access
// ---------------------------------------------------------------------------
const chunkKey = (cx, cz) => `${cx},${cz}`;

function getVoxel(wx, wy, wz) {
  if (wy < 0 || wy >= CY) return 0;
  const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
  const chunk = state.chunks.get(chunkKey(cx, cz));
  if (!chunk || !chunk.data) return 0;
  const lx = wx - cx * CX, lz = wz - cz * CZ;
  return chunk.data[lx + lz * CX + wy * CX * CZ];
}

function setVoxel(wx, wy, wz, matId) {
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
  pushEdit(wx, wy, wz, matId);
  return true;
}

function rebuildChunkAt(cx, cz) {
  const chunk = state.chunks.get(chunkKey(cx, cz));
  if (chunk && chunk.data) rebuildChunk(chunk);
}

// ---------------------------------------------------------------------------
// Meshing: culled cube faces, vertex-coloured per material with a subtle
// per-voxel brightness jitter (this is what makes granite look speckled).
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

  for (let y = 0; y < CY; y++) {
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        const matId = chunk.data[x + z * CX + y * layer];
        if (!matId) continue;
        const wx = ox + x, wz = oz + z;
        const jitter = voxelJitter(wx, y, wz);
        const rgb = materialRGB(matId);
        for (const face of FACES) {
          const nx = wx + face.dir[0], ny = y + face.dir[1],
                nz = wz + face.dir[2];
          if (getVoxel(nx, ny, nz)) continue; // neighbour solid -> cull
          const base = positions.length / 3;
          for (const c of face.corners) {
            positions.push(wx + c[0], y + c[1], wz + c[2]);
            normals.push(...face.dir);
            const s = face.shade * jitter;
            colors.push(
              Math.min(1, rgb[0] * s),
              Math.min(1, rgb[1] * s),
              Math.min(1, rgb[2] * s));
          }
          indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
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
    const chunk = { cx, cz, data: decodeVoxels(payload.voxels), mesh: null };
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
// Edit sync back to the backend (batched)
// ---------------------------------------------------------------------------
let editQueue = [];
let editTimer = null;

function pushEdit(x, y, z, id) {
  editQueue.push({ x, y, z, id });
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
// Block targeting: Amanatides & Woo voxel traversal from the camera
// ---------------------------------------------------------------------------
function raycastVoxel() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const origin = camera.position;

  let x = Math.floor(origin.x), y = Math.floor(origin.y),
      z = Math.floor(origin.z);
  const stepX = Math.sign(dir.x) || 1, stepY = Math.sign(dir.y) || 1,
        stepZ = Math.sign(dir.z) || 1;
  const tDeltaX = Math.abs(1 / (dir.x || 1e-10));
  const tDeltaY = Math.abs(1 / (dir.y || 1e-10));
  const tDeltaZ = Math.abs(1 / (dir.z || 1e-10));
  let tMaxX = tDeltaX * (stepX > 0 ? (x + 1 - origin.x) : (origin.x - x));
  let tMaxY = tDeltaY * (stepY > 0 ? (y + 1 - origin.y) : (origin.y - y));
  let tMaxZ = tDeltaZ * (stepZ > 0 ? (z + 1 - origin.z) : (origin.z - z));

  let prev = { x, y, z };
  let t = 0;
  while (t <= REACH) {
    const matId = getVoxel(x, y, z);
    if (matId) return { hit: { x, y, z }, prev, matId };
    prev = { x, y, z };
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      t = tMaxX; tMaxX += tDeltaX; x += stepX;
    } else if (tMaxY < tMaxZ) {
      t = tMaxY; tMaxY += tDeltaY; y += stepY;
    } else {
      t = tMaxZ; tMaxZ += tDeltaZ; z += stepZ;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inventory / hotbar
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

function destroyBlock() {
  const t = state.target;
  if (!t) return;
  storeBlock(t.matId);
  setVoxel(t.hit.x, t.hit.y, t.hit.z, 0);
}

function placeBlock() {
  const t = state.target;
  if (!t) return;
  const { x, y, z } = t.prev;
  if (getVoxel(x, y, z)) return;
  // Don't place a block into the camera's own cell.
  const cam = camera.position;
  if (Math.floor(cam.x) === x && Math.floor(cam.z) === z &&
      (Math.floor(cam.y) === y || Math.floor(cam.y) - 1 === y)) return;
  const matId = state.hotbar[state.activeSlot].matId;
  if (!matId) return;
  if (setVoxel(x, y, z, matId)) consumeBlock(matId);
}

function pickBlock() {
  const t = state.target;
  if (!t) return;
  state.hotbar[state.activeSlot].matId = t.matId;
  renderHotbar();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const hotbarEl = el('hotbar');
const sceneInfoEl = el('scene-info');
const targetInfoEl = el('target-info');
const matModal = el('mat-modal');
const invModal = el('inv-modal');

function matName(matId) {
  return state.materials[matId] ? state.materials[matId].name : '—';
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
    targetInfoEl.innerHTML =
      `Looking at: <b>${m ? m.name : '?'}</b> ` +
      `<span class="muted">(${t.hit.x}, ${t.hit.y}, ${t.hit.z}) · ` +
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

function updateMovement(dt) {
  if (anyModalOpen()) return;
  const speed = FLY_SPEED * (state.keys.has('KeyF') ? SPRINT_MULT : 1);
  const forward = new THREE.Vector3(
    -Math.sin(state.yaw), 0, -Math.cos(state.yaw));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const move = new THREE.Vector3();
  if (state.keys.has('KeyW')) move.add(forward);
  if (state.keys.has('KeyS')) move.sub(forward);
  if (state.keys.has('KeyD')) move.add(right);
  if (state.keys.has('KeyA')) move.sub(right);
  if (state.keys.has('Space')) move.y += 1;
  if (state.keys.has('ShiftLeft') || state.keys.has('ShiftRight')) move.y -= 1;
  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed * dt);
    state.pos.add(move);
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

    state.target = raycastVoxel();
    if (state.target) {
      const { x, y, z } = state.target.hit;
      highlight.position.set(x + 0.5, y + 0.5, z + 0.5);
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

function activateScene(meta) {
  clearWorld();
  state.scene = meta;
  state.pos.set(meta.spawn[0], meta.spawn[1], meta.spawn[2]);
  [state.yaw, state.pitch] = meta.look || [Math.PI * 0.25, -0.25];
  renderSceneInfo();
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
  state.materials = [];
  for (const m of state.config.materials) state.materials[m.id] = m;

  const select = el('scene-select');
  for (const s of state.config.scenes) {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = `${s.title} — ${s.description}`;
    if (s.name === state.config.defaultScene) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    const meta = state.config.scenes.find((s) => s.name === select.value);
    if (meta && state.started) activateScene(meta);
  });

  defaultHotbar();
  statusEl.hidden = true;
  el('start-ready').hidden = false;

  el('start-btn').addEventListener('click', () => {
    state.started = true;
    el('start-modal').classList.remove('visible');
    for (const id of ['crosshair', 'hud-top', 'hotbar', 'hint']) {
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
  state, getVoxel, setVoxel, destroyBlock, placeBlock, pickBlock,
  raycastVoxel, storedCount,
};
