// Fluid simulation worker: sand, water and lava as 5 cm (50 mm) cells.
//
// Water and lava carry a Minecraft-style fill LEVEL (1..8 eighths of a
// cell) and are mass-conserving: a cell pours into the one below until
// that is full, then shares with lower horizontal neighbours one eighth at
// a time, so pools level out and thin sheets spread across floors. Lava
// keeps at least two eighths (it's viscous) and moves every other tick.
// Sand is granular: always a full cell, it falls, slides off slopes into
// piles, and sinks through water and lava by swapping places.
//
// Cells live in two tiers and are UNLIMITED in number:
//   - ACTIVE cells are simulated. `maxCellsPerType` is a per-tick movement
//     budget (a rotating window when more cells are active), not a cap.
//   - SETTLED cells reached equilibrium (no change for `settleAfterTicks`
//     ticks). They cost nothing per tick and wake when a neighbour changes,
//     the world is edited nearby, or a reaction partner arrives.
//
// This worker keeps its own copy of the world (worldstore.js, fed by the
// same load/unload/edit messages as the mesher). World changes the fluids
// cause — obsidian, burned wood, cooled magma, floating wood — are applied
// locally at once and posted to the main thread, which persists them as
// ordinary edits. Every tick, the 1 m blocks whose fluid changed are sent
// as small padded grids over a MessagePort to the fluid surface worker
// (fluidmesh.worker.js), which builds the marching-cubes surface.
//
// Messages in: init, clear, load, unload, edits, focus (see mesher.worker)
//   plus {type:'port', port} for the surface worker channel.
// Messages out: {type:'effects', epoch, list:[{op:'base'|'sub', ...}]},
//   {type:'toast', text}, {type:'stats', epoch, counts, settledCounts}.

import { createWorldStore, chunkKey } from './worldstore.js';

const WATER = 1, LAVA = 2, SAND = 3;
const TYPE_NAMES = { 1: 'water', 2: 'lava', 3: 'sand' };
const TYPE_IDS = { water: WATER, lava: LAVA, sand: SAND };
const FULL = 8;

let store = null;
let materials = [];
let config = {};
let epoch = 0;
let focus = { x: 0, z: 0 };
let port = null;           // to the fluid surface worker
let tickTimer = null;

let CELL_MM = 50;
let PER_BLOCK = 20;        // cells per 1000 mm base voxel
let BUDGET = 4000;
let SETTLE_TICKS = 8;
let EMIT_EVERY = 2;
let BURN_CHANCE = 0.15;
let OBSIDIAN = 0;
let COOLS_TO = new Map();
let FAUCETS = new Map();   // material id -> fluid type id

// Numeric cell keys: x, z in [-2^18, 2^18) cells (~13 km), y < 2^15.
const OFF = 1 << 18;
const inRange = (x, y, z) =>
  x >= -OFF && x < OFF && z >= -OFF && z < OFF && y >= 0 && y < 32768;
const key = (x, y, z) => ((x + OFF) * 524288 + (z + OFF)) * 32768 + y;

const cells = new Map();     // active:  key -> cell
const settled = new Map();   // settled: key -> cell
// cell = {x, y, z, t, l, rest, fx, fz, fall}
const counts = { water: 0, lava: 0, sand: 0 };
const settledCounts = { water: 0, lava: 0, sand: 0 };
let tickNo = 0;

// ---- world queries (50 mm cells) ----
// Sub-voxel occupancy per chunk: a Set of cell keys, rebuilt on change.
function subCells(chunk) {
  if (chunk.subCells) return chunk.subCells;
  const set = new Set();
  for (const sv of chunk.sub.values()) {
    const n = Math.max(1, sv.s / CELL_MM);
    const cx0 = Math.floor(sv.x / CELL_MM), cy0 = Math.floor(sv.y / CELL_MM),
          cz0 = Math.floor(sv.z / CELL_MM);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < n; k++) set.add(key(cx0 + i, cy0 + j, cz0 + k));
      }
    }
  }
  chunk.subCells = set;
  return set;
}

const blockOf = (c) => Math.floor(c / PER_BLOCK);

// Solid, or outside the loaded world (fluid must not flow into the unknown).
function isSolid(x, y, z) {
  if (y < 0) return true;
  if (!inRange(x, y, z)) return true;
  const bx = blockOf(x), by = blockOf(y), bz = blockOf(z);
  if (by >= store.CY) return false;
  const chunk = store.chunkAt(bx, bz);
  if (!chunk) return true;
  if (store.getVoxel(bx, by, bz)) return true;
  return chunk.sub.size > 0 && subCells(chunk).has(key(x, y, z));
}

function loaded(x, z) {
  return !!store.chunkAt(blockOf(x), blockOf(z));
}

// The block occupying a 50 mm cell:
// {kind:'base', x,y,z, id} | {kind:'sub', x,y,z,s (mm), id} | null.
function blockAtCell(x, y, z) {
  const bx = blockOf(x), by = blockOf(y), bz = blockOf(z);
  const base = store.getVoxel(bx, by, bz);
  if (base) return { kind: 'base', x: bx, y: by, z: bz, id: base };
  const chunk = store.chunkAt(bx, bz);
  if (!chunk || !chunk.sub.size || !subCells(chunk).has(key(x, y, z))) {
    return null;
  }
  const xm = x * CELL_MM, ym = y * CELL_MM, zm = z * CELL_MM;
  for (const sv of chunk.sub.values()) {
    if (xm >= sv.x && xm < sv.x + sv.s && ym >= sv.y && ym < sv.y + sv.s &&
        zm >= sv.z && zm < sv.z + sv.s) {
      return { kind: 'sub', x: sv.x, y: sv.y, z: sv.z, s: sv.s, id: sv.mat };
    }
  }
  return null;
}

// ---- rendering bookkeeping: 1 m blocks whose fluid changed ----
const dirtyBlocks = new Set();   // "bx,by,bz"
function markDirty(x, y, z) {
  const bx = blockOf(x), by = blockOf(y), bz = blockOf(z);
  dirtyBlocks.add(`${bx},${by},${bz}`);
  // The surface worker pads each block by one cell, so a change on a block
  // face also changes the neighbouring block's surface.
  const lx = x - bx * PER_BLOCK, ly = y - by * PER_BLOCK, lz = z - bz * PER_BLOCK;
  if (lx === 0) dirtyBlocks.add(`${bx - 1},${by},${bz}`);
  if (lx === PER_BLOCK - 1) dirtyBlocks.add(`${bx + 1},${by},${bz}`);
  if (ly === 0) dirtyBlocks.add(`${bx},${by - 1},${bz}`);
  if (ly === PER_BLOCK - 1) dirtyBlocks.add(`${bx},${by + 1},${bz}`);
  if (lz === 0) dirtyBlocks.add(`${bx},${by},${bz - 1}`);
  if (lz === PER_BLOCK - 1) dirtyBlocks.add(`${bx},${by},${bz + 1}`);
}

// ---- tiers ----
const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
                   [0, 0, 1], [0, 0, -1]];
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const fluidAt = (k) => cells.get(k) || settled.get(k);

function wakeKey(k) {
  const c = settled.get(k);
  if (!c) return;
  settled.delete(k);
  settledCounts[TYPE_NAMES[c.t]]--;
  c.rest = 0;
  cells.set(k, c);
  counts[TYPE_NAMES[c.t]]++;
}

function wakeAround(x, y, z) {
  for (const [dx, dy, dz] of NEIGHBORS) wakeKey(key(x + dx, y + dy, z + dz));
}

function settle(k, c) {
  // Never settle next to a reaction partner — the cross effect must fire.
  if (c.t !== SAND) {
    const other = c.t === LAVA ? WATER : LAVA;
    for (const [dx, dy, dz] of NEIGHBORS) {
      const n = fluidAt(key(c.x + dx, c.y + dy, c.z + dz));
      if (n && n.t === other) return;
    }
  }
  cells.delete(k);
  counts[TYPE_NAMES[c.t]]--;
  settled.set(k, c);
  settledCounts[TYPE_NAMES[c.t]]++;
  if (c.fx || c.fz || c.fall) {
    // Still water: drop the flow so the surface stops scrolling.
    land(c);
    c.fx = 0; c.fz = 0;
    markDirty(c.x, c.y, c.z);
  }
}

function removeCell(k, c) {
  if (cells.delete(k)) counts[TYPE_NAMES[c.t]]--;
  else if (settled.delete(k)) settledCounts[TYPE_NAMES[c.t]]--;
  markDirty(c.x, c.y, c.z);
  wakeAround(c.x, c.y, c.z);
}

function addCell(t, l, x, y, z, fx = 0, fz = 0) {
  const c = { x, y, z, t, l, rest: 0, fx, fz, fall: 0 };
  cells.set(key(x, y, z), c);
  counts[TYPE_NAMES[t]]++;
  markDirty(x, y, z);
  wakeAround(x, y, z);
  return c;
}

function moveTo(c, nx, ny, nz) {
  const ox = c.x, oy = c.y, oz = c.z;
  cells.delete(key(ox, oy, oz));
  c.x = nx; c.y = ny; c.z = nz;
  c.rest = 0;
  cells.set(key(nx, ny, nz), c);
  markDirty(ox, oy, oz);
  markDirty(nx, ny, nz);
  if (c.fall) {
    // The render trail above a falling cell (see sendDirtyBlocks) moves
    // along with it.
    markDirty(ox, oy + TRAIL, oz);
    markDirty(nx, ny + TRAIL, nz);
  }
  wakeAround(ox, oy, oz);
}

// A falling cell landed: its render trail disappears.
function land(c) {
  if (!c.fall) return;
  c.fall = 0;
  markDirty(c.x, c.y + 1, c.z);
  markDirty(c.x, c.y + TRAIL, c.z);
}

// A settled or active neighbour got more fluid: make sure it simulates.
function touched(n) {
  const k = key(n.x, n.y, n.z);
  if (settled.has(k)) wakeKey(k);
  n.rest = 0;
  markDirty(n.x, n.y, n.z);
}

const free = (x, y, z) => !fluidAt(key(x, y, z)) && !isSolid(x, y, z);

function shuffledSides() {
  const s = SIDES.slice();
  for (let i = s.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  return s;
}

// ---- movement ----
function stepSand(c) {
  if (c.y <= 0) { removeCell(key(c.x, c.y, c.z), c); return; }
  if (free(c.x, c.y - 1, c.z)) {
    const drop = c.y > 1 && free(c.x, c.y - 2, c.z) ? 2 : 1;
    c.fall = 1;
    moveTo(c, c.x, c.y - drop, c.z);
    return;
  }
  land(c);
  // Sink through liquids: swap places with the water/lava cell below.
  const bk = key(c.x, c.y - 1, c.z);
  const below = fluidAt(bk);
  if (below && below.t !== SAND) {
    const k = key(c.x, c.y, c.z);
    const wasSettled = settled.has(bk);
    if (wasSettled) wakeKey(bk);
    cells.delete(k);
    cells.delete(bk);
    below.y = c.y; c.y -= 1;
    cells.set(key(below.x, below.y, below.z), below);
    cells.set(key(c.x, c.y, c.z), c);
    below.rest = 0; c.rest = 0;
    markDirty(c.x, c.y, c.z);
    markDirty(below.x, below.y, below.z);
    return;
  }
  for (const [dx, dz] of shuffledSides()) {
    if (free(c.x + dx, c.y - 1, c.z + dz) && free(c.x + dx, c.y, c.z + dz)) {
      moveTo(c, c.x + dx, c.y - 1, c.z + dz);
      return;
    }
  }
  c.rest++;
}

function stepLiquid(c) {
  if (c.y <= 0) { removeCell(key(c.x, c.y, c.z), c); return; }
  const minKeep = c.t === LAVA ? 2 : 1;
  let changed = false;

  // 1. Fall: move the whole cell into free space below.
  if (free(c.x, c.y - 1, c.z)) {
    const drop = c.t === WATER && c.y > 1 && free(c.x, c.y - 2, c.z) ? 2 : 1;
    c.fall = 1;
    moveTo(c, c.x, c.y - drop, c.z);
    return;
  }
  // 2. Pour into the same liquid below until it is full.
  const below = fluidAt(key(c.x, c.y - 1, c.z));
  if (below && below.t === c.t && below.l < FULL) {
    const n = Math.min(c.l, FULL - below.l);
    below.l += n;
    c.l -= n;
    touched(below);
    below.fall = 1;
    if (c.l <= 0) { removeCell(key(c.x, c.y, c.z), c); return; }
    changed = true;
  }
  land(c);

  // 3. Spread sideways: share one eighth at a time with lower neighbours.
  let fx = 0, fz = 0;
  const sides = shuffledSides();
  if (c.l > minKeep) {
    for (const [dx, dz] of sides) {
      if (c.l <= minKeep) break;
      const nx = c.x + dx, nz = c.z + dz;
      if (isSolid(nx, c.y, nz)) continue;
      const n = fluidAt(key(nx, c.y, nz));
      if (!n) {
        addCell(c.t, 1, nx, c.y, nz, dx, dz);
        c.l -= 1;
        fx += dx; fz += dz;
        changed = true;
      } else if (n.t === c.t && n.l < c.l - 1) {
        n.l += 1;
        c.l -= 1;
        n.fx = n.fx * 0.5 + dx * 0.5;
        n.fz = n.fz * 0.5 + dz * 0.5;
        touched(n);
        fx += dx; fz += dz;
        changed = true;
      }
    }
  } else {
    // Too thin to spread: a sheet reaching a ledge flows over the edge.
    for (const [dx, dz] of sides) {
      const nx = c.x + dx, nz = c.z + dz;
      if (free(nx, c.y, nz) && free(nx, c.y - 1, nz)) {
        moveTo(c, nx, c.y, nz);
        c.fx = dx; c.fz = dz;
        return;
      }
    }
  }
  if (changed) {
    c.fx = c.fx * 0.6 + Math.sign(fx) * 0.4;
    c.fz = c.fz * 0.6 + Math.sign(fz) * 0.4;
    c.rest = 0;
    markDirty(c.x, c.y, c.z);
    wakeAround(c.x, c.y, c.z);
  } else {
    c.rest++;
  }
}

// ---- cross effects ----
function effect(list, e) {
  // Apply to our own world copy right away (the main thread echoes the
  // edit back later, which is idempotent) so it isn't triggered twice.
  if (e.op === 'base') {
    store.setVoxel(e.x, e.y, e.z, e.id);
    if (e.id) clearFluidInBlock(e.x, e.y, e.z);
  } else {
    const chunk = store.setSub(e.x, e.y, e.z, e.s, e.id);
    if (chunk) chunk.subCells = null;
  }
  list.push(e);
}

let lastToast = 0;
function effectToast(text) {
  const now = Date.now();
  if (now - lastToast > 1500) {
    lastToast = now;
    postMessage({ type: 'toast', text });
  }
}

const matName = (id) => (materials[id] ? materials[id].name || `#${id}` : `#${id}`);

// Reactions of the cells stepped this tick (a settled cell never sits next
// to a reaction partner, so every reaction involves an active cell).
function crossEffects(stepped) {
  const list = [];
  let ops = 0;
  for (const c of stepped) {
    if (ops > 40) break;
    const k = key(c.x, c.y, c.z);
    if (cells.get(k) !== c) continue; // consumed by an earlier effect

    if (c.t === LAVA) {
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = c.x + dx, ny = c.y + dy, nz = c.z + dz;
        const nk = key(nx, ny, nz);
        const n = fluidAt(nk);
        if (n && n.t === WATER) {
          // Lava + water: the lava cell freezes to (persisted) obsidian.
          removeCell(k, c);
          removeCell(nk, n);
          effect(list, { op: 'sub', x: c.x * CELL_MM, y: c.y * CELL_MM,
                         z: c.z * CELL_MM, s: CELL_MM, id: OBSIDIAN });
          effectToast('Lava + water → Obsidian');
          ops++;
          break;
        }
        const solid = blockAtCell(nx, ny, nz);
        if (solid && materials[solid.id] && materials[solid.id].flammable &&
            Math.random() < BURN_CHANCE) {
          if (solid.kind === 'base') {
            effect(list, { op: 'base', x: solid.x, y: solid.y, z: solid.z, id: 0 });
          } else {
            effect(list, { op: 'sub', x: solid.x, y: solid.y, z: solid.z,
                           s: solid.s, id: 0 });
          }
          wakeAround(nx, ny, nz);
          effectToast(`${matName(solid.id)} burned in lava`);
          ops++;
        }
      }
    } else if (c.t === WATER) {
      for (const [dx, dy, dz] of NEIGHBORS) {
        const solid = blockAtCell(c.x + dx, c.y + dy, c.z + dz);
        if (!solid || solid.kind !== 'base') continue;
        const cooled = COOLS_TO.get(solid.id);
        if (cooled !== undefined) {
          effect(list, { op: 'base', x: solid.x, y: solid.y, z: solid.z, id: cooled });
          effectToast(`Water cooled ${matName(solid.id)} → ${matName(cooled)}`);
          ops++;
        }
      }
      // Wood floats: a small (50 mm) wooden voxel below rises through.
      const below = blockAtCell(c.x, c.y - 1, c.z);
      if (below && below.kind === 'sub' && below.s === CELL_MM &&
          materials[below.id] && materials[below.id].flammable && ops <= 40) {
        effect(list, { op: 'sub', x: below.x, y: below.y, z: below.z,
                       s: CELL_MM, id: 0 });
        effect(list, { op: 'sub', x: c.x * CELL_MM, y: c.y * CELL_MM,
                       z: c.z * CELL_MM, s: CELL_MM, id: below.id });
        moveTo(c, c.x, c.y - 1, c.z);
        ops++;
      }
    }
  }
  if (list.length) postMessage({ type: 'effects', epoch, list });
}

// ---- faucets ----
function scanFaucets(chunk) {
  const out = [];
  const { CX, CZ, LAYER } = store;
  chunk.sections.forEach((sec, si) => {
    if (!sec) return;
    for (let i = 0; i < sec.length; i++) {
      if (!sec[i] || !FAUCETS.has(sec[i])) continue;
      out.push({ x: chunk.cx * CX + (i % CX), y: si * 16 + ((i / LAYER) | 0),
                 z: chunk.cz * CZ + (((i / CX) | 0) % CZ), id: sec[i] });
    }
  });
  chunk.faucets = out;
}

function emit() {
  if (tickNo % EMIT_EVERY) return;
  for (const chunk of store.chunks.values()) {
    for (const f of chunk.faucets || []) {
      const t = FAUCETS.get(f.id);
      // Always the same centre cell, so successive drops (and their render
      // trails) line up into one continuous stream.
      const half = PER_BLOCK >> 1;
      const x = f.x * PER_BLOCK + half;
      const z = f.z * PER_BLOCK + half;
      const y = f.y * PER_BLOCK - 1;
      if (isSolid(x, y, z)) continue;
      const k = key(x, y, z);
      const cur = fluidAt(k);
      if (!cur) addCell(t, FULL, x, y, z);
      else if (cur.t === t && cur.l < FULL) { cur.l = FULL; touched(cur); }
    }
  }
}

// ---- world edits ----
function clearFluidInBlock(bx, by, bz) {
  const x0 = bx * PER_BLOCK, y0 = by * PER_BLOCK, z0 = bz * PER_BLOCK;
  for (let x = x0; x < x0 + PER_BLOCK; x++) {
    for (let y = y0; y < y0 + PER_BLOCK; y++) {
      for (let z = z0; z < z0 + PER_BLOCK; z++) {
        const k = key(x, y, z);
        const c = fluidAt(k);
        if (c) removeCell(k, c);
      }
    }
  }
}

// The world changed inside this cell box (inclusive min, exclusive max):
// wake settled cells in and around it.
function disturbCells(x0, y0, z0, x1, y1, z1) {
  for (let x = x0 - 1; x < x1 + 1; x++) {
    for (let y = y0 - 1; y < y1 + 1; y++) {
      for (let z = z0 - 1; z < z1 + 1; z++) wakeKey(key(x, y, z));
    }
  }
}

// ---- tick ----
const cursor = { 1: 0, 2: 0, 3: 0 };

let tickMs = 0;

function tick() {
  const t0 = performance.now();
  tickNo++;
  emit();
  // Movement budget: when more cells of a type are active than BUDGET,
  // step a rotating window of BUDGET cells so every cell gets its turn.
  const byType = { 1: [], 2: [], 3: [] };
  for (const c of cells.values()) {
    if (loaded(c.x, c.z)) byType[c.t].push(c);
  }
  const toStep = [];
  for (const [t, list] of Object.entries(byType)) {
    if (list.length <= BUDGET) {
      cursor[t] = 0;
      toStep.push(...list);
    } else {
      const start = cursor[t] % list.length;
      for (let i = 0; i < BUDGET; i++) toStep.push(list[(start + i) % list.length]);
      cursor[t] = (start + BUDGET) % list.length;
    }
  }
  toStep.sort((a, b) => a.y - b.y);
  for (const c of toStep) {
    if (!cells.has(key(c.x, c.y, c.z)) || cells.get(key(c.x, c.y, c.z)) !== c) {
      continue; // removed or merged earlier this tick
    }
    if (c.t === LAVA && tickNo % 2) continue;           // lava is slower
    if (c.t === SAND && tickNo % 2 === 0 && Math.random() < 0.3) continue;
    if (c.t === SAND) stepSand(c);
    else stepLiquid(c);
  }
  crossEffects(toStep);
  for (const c of toStep) {
    const k = key(c.x, c.y, c.z);
    if (c.rest >= SETTLE_TICKS && cells.get(k) === c) settle(k, c);
  }
  sendDirtyBlocks();
  tickMs = performance.now() - t0;
  if (tickNo % 5 === 0) {
    postMessage({ type: 'stats', epoch, counts: { ...counts },
                  settledCounts: { ...settledCounts }, tickMs });
  }
}

// ---- surface data for the mesh worker ----
// Per dirty block, a (PER_BLOCK+2)^3 padded grid (one cell of the
// neighbouring blocks on every side):
//   grid[i]  = type << 4 | level for fluid, 0x80 for solid, 0 for air
//   depth[i] = contiguous fluid cells from here down (capped), for the
//              water shader's depth colouring
//   flow[3i..3i+2] = flow x, flow z, falling  (int8, scaled by 127)
const MAX_BLOCKS_PER_TICK = 96;
const DEPTH_CAP = 60;
// Falling cells are several cells apart (they drop up to two cells a
// tick), which would render as a string of droplets. For rendering only,
// the free cells just above a falling cell count as a thinner "trail" of
// the same fluid, so pours and waterfalls read as continuous streams.
const TRAIL = 3;
const TRAIL_LEVEL = 4;

function buildTrails() {
  const trails = new Map();
  for (const c of cells.values()) {
    if (!c.fall) continue;
    for (let d = 1; d <= TRAIL; d++) {
      const k = key(c.x, c.y + d, c.z);
      if (fluidAt(k) || isSolid(c.x, c.y + d, c.z)) break;
      if (!trails.has(k)) trails.set(k, c);
    }
  }
  return trails;
}

function sendDirtyBlocks() {
  if (!port || !dirtyBlocks.size) return;
  const P = PER_BLOCK + 2;
  let keys = [...dirtyBlocks];
  if (keys.length > MAX_BLOCKS_PER_TICK) {
    const fbx = focus.x, fbz = focus.z;
    const d = (k) => {
      const [bx, , bz] = k.split(',').map(Number);
      return (bx - fbx) ** 2 + (bz - fbz) ** 2;
    };
    keys.sort((a, b) => d(a) - d(b));
    keys = keys.slice(0, MAX_BLOCKS_PER_TICK);
  }
  const blocks = [];
  const transfer = [];
  const trails = buildTrails();
  for (const bkey of keys) {
    dirtyBlocks.delete(bkey);
    const [bx, by, bz] = bkey.split(',').map(Number);
    const x0 = bx * PER_BLOCK - 1, y0 = by * PER_BLOCK - 1, z0 = bz * PER_BLOCK - 1;
    const grid = new Uint8Array(P * P * P);
    const depth = new Uint8Array(P * P * P);
    const flow = new Int8Array(P * P * P * 3);
    let any = false;
    for (let j = 0; j < P; j++) {
      for (let k = 0; k < P; k++) {
        for (let i = 0; i < P; i++) {
          const x = x0 + i, y = y0 + j, z = z0 + k;
          const idx = i + k * P + j * P * P;
          const k0 = key(x, y, z);
          let c = fluidAt(k0);
          let level = c ? c.l : 0;
          if (!c && (c = trails.get(k0))) level = Math.min(c.l, TRAIL_LEVEL);
          if (c) {
            grid[idx] = (c.t << 4) | level;
            flow[idx * 3] = Math.round(Math.max(-1, Math.min(1, c.fx)) * 127);
            flow[idx * 3 + 1] = Math.round(Math.max(-1, Math.min(1, c.fz)) * 127);
            flow[idx * 3 + 2] = c.fall ? 127 : 0;
            if (j === 0) {
              let d = 1;
              while (d < DEPTH_CAP && fluidAt(key(x, y - d, z))) d++;
              depth[idx] = d;
            } else {
              depth[idx] = Math.min(DEPTH_CAP, depth[idx - P * P] + 1);
            }
            if (j > 0 && j < P - 1 && i > 0 && i < P - 1 && k > 0 && k < P - 1) {
              any = true;
            }
          } else if (isSolid(x, y, z)) {
            grid[idx] = 0x80;
          }
        }
      }
    }
    if (!any) {
      blocks.push({ bx, by, bz, empty: true });
      continue;
    }
    blocks.push({ bx, by, bz, grid, depth, flow });
    transfer.push(grid.buffer, depth.buffer, flow.buffer);
  }
  port.postMessage({ type: 'blocks', epoch, blocks }, transfer);
}

// ---- messages ----
function applyConfig(cfg) {
  config = cfg || {};
  CELL_MM = config.cellMm || 50;
  PER_BLOCK = Math.round(1000 / CELL_MM);
  BUDGET = config.maxCellsPerType || 4000;
  SETTLE_TICKS = config.settleAfterTicks || 2;
  EMIT_EVERY = config.emitEveryTicks || 2;
  BURN_CHANCE = config.burnChance || 0.15;
  OBSIDIAN = config.lavaWaterContact;
  COOLS_TO = new Map(Object.entries(config.coolsTo || {}).map(([k, v]) => [+k, +v]));
  FAUCETS = new Map(Object.entries(config.faucets || {})
    .map(([k, v]) => [+k, TYPE_IDS[v]]));
}

function clearAll() {
  for (const [k, c] of [...cells.entries()]) removeCell(k, c);
  for (const [k, c] of [...settled.entries()]) removeCell(k, c);
  dirtyBlocks.clear();
}

onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      store = createWorldStore(msg.dims);
      materials = [];
      for (const m of msg.materials) materials[m.id] = m;
      applyConfig(msg.config);
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(tick, config.tickMs || 100);
      break;
    case 'port':
      port = msg.port;
      break;
    case 'clear':
      epoch = msg.epoch;
      clearAll();
      store.chunks.clear();
      break;
    case 'focus':
      focus = { x: msg.x, z: msg.z }; // metres = 1 m block coordinates
      break;
    case 'load': {
      const chunk = store.makeChunk(msg.cx, msg.cz, msg.sections, msg.subs);
      store.chunks.set(chunkKey(msg.cx, msg.cz), chunk);
      scanFaucets(chunk);
      // Fluid resting at this chunk's edges may now be able to move.
      const x0 = msg.cx * store.CX * PER_BLOCK, z0 = msg.cz * store.CZ * PER_BLOCK;
      for (const c of settled.values()) {
        if (c.x >= x0 - 1 && c.x <= x0 + store.CX * PER_BLOCK &&
            c.z >= z0 - 1 && c.z <= z0 + store.CZ * PER_BLOCK) c.rest = -1;
      }
      for (const [k, c] of [...settled.entries()]) if (c.rest === -1) wakeKey(k);
      break;
    }
    case 'unload':
      store.chunks.delete(chunkKey(msg.cx, msg.cz));
      break;
    case 'fill': {
      // Debug/scripting: fill every free cell of a box (cell coordinates,
      // inclusive min, exclusive max) with full cells of one fluid.
      const t = TYPE_IDS[msg.fluid];
      const [x0, y0, z0, x1, y1, z1] = msg.box;
      if (!t || (x1 - x0) * (y1 - y0) * (z1 - z0) > 2e6) break;
      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) {
            if (free(x, y, z)) addCell(t, FULL, x, y, z);
          }
        }
      }
      break;
    }
    case 'edits': {
      const b = msg.base;
      for (let i = 0; i < b.length; i += 4) {
        const [x, y, z, id] = [b[i], b[i + 1], b[i + 2], b[i + 3]];
        const chunk = store.setVoxel(x, y, z, id);
        if (!chunk) continue;
        if (id) clearFluidInBlock(x, y, z);
        if (FAUCETS.has(id) || (chunk.faucets || []).some(
          (f) => f.x === x && f.y === y && f.z === z)) scanFaucets(chunk);
        disturbCells(x * PER_BLOCK, y * PER_BLOCK, z * PER_BLOCK,
                     (x + 1) * PER_BLOCK, (y + 1) * PER_BLOCK, (z + 1) * PER_BLOCK);
      }
      for (const [x, y, z, s, id] of msg.subs) {
        const chunk = store.setSub(x, y, z, s, id);
        if (!chunk) continue;
        chunk.subCells = null;
        const n = Math.max(1, Math.round(s / CELL_MM));
        const cx = Math.floor(x / CELL_MM), cy = Math.floor(y / CELL_MM),
              cz = Math.floor(z / CELL_MM);
        if (id) {
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              for (let k = 0; k < n; k++) {
                const fk = key(cx + i, cy + j, cz + k);
                const c = fluidAt(fk);
                if (c) removeCell(fk, c);
              }
            }
          }
        }
        disturbCells(cx, cy, cz, cx + n, cy + n, cz + n);
      }
      break;
    }
  }
};
