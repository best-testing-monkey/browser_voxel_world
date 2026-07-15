// Fluid simulation: sand, water and lava as 5 cm (50 mm) fluid voxels that
// pour out of faucet blocks. The rules (which materials are faucets, what
// lava+water makes, what burns, what cools) come from the backend's
// /api/config "fluids" section — the client just executes them.
//
// Fluid cells live in two tiers and are UNLIMITED in number:
//   - ACTIVE cells are simulated. `maxCellsPerType` is not a presence cap
//     but a per-tick movement budget: when more cells are active than the
//     budget, each tick steps a rotating window of that many cells, so
//     more moving fluid simply moves slower.
//   - SETTLED cells reached equilibrium (no movement for `settleAfterTicks`
//     ticks). They cost nothing per tick: they are not iterated and their
//     instanced mesh is only re-uploaded when the settled pool actually
//     changes. They wake back into the active tier when disturbed — a
//     neighbouring cell vacates, a block nearby is placed or removed, or
//     a reaction partner arrives.
// Instanced meshes grow on demand, so rendering follows the fluid volume.
//
// Fluid cells are ephemeral (not persisted); their *effects* are real world
// edits: obsidian from lava+water, burned wood, cooled magma.

export function createFluidSim({ THREE, scene3, config, materials, world,
                                 toast }) {
  const CELL = (config.cellMm || 50) / 1000;   // metres
  const PER_BLOCK = Math.round(1 / CELL);      // cells per 1000 mm voxel
  const BUDGET = config.maxCellsPerType || 4000; // cells stepped per tick/type
  const SETTLE_TICKS = config.settleAfterTicks || 8;
  const EMIT_EVERY = config.emitEveryTicks || 2;
  const BURN_CHANCE = config.burnChance || 0.15;
  const OBSIDIAN = config.lavaWaterContact;
  const COOLS_TO = new Map(
    Object.entries(config.coolsTo || {}).map(([k, v]) => [+k, +v]));
  const FAUCETS = new Map(
    Object.entries(config.faucets || {}).map(([k, v]) => [+k, v]));

  const cells = new Map();     // active:  "x,y,z" -> {x,y,z,type,rest,born}
  const settled = new Map();   // static:  "x,y,z" -> {x,y,z,type}
  const counts = { sand: 0, water: 0, lava: 0 };         // active only
  const settledCounts = { sand: 0, water: 0, lava: 0 };
  let settledDirty = false;
  let tickNo = 0;
  let lastToast = 0;

  const key = (x, y, z) => `${x},${y},${z}`;

  function effectToast(msg) {
    const now = performance.now();
    if (now - lastToast > 1500) { lastToast = now; toast(msg); }
  }

  // ---- rendering ----
  // One InstancedMesh per type for active cells (updated every tick) and a
  // second one for settled cells (updated only when they change). Meshes
  // grow on demand — fluid presence is unbounded.
  const dummy = new THREE.Object3D();
  const activeMeshes = {};
  const settledMeshes = {};

  function makeMesh(type, color, capacity, geo = null, mat = null) {
    geo = geo ||
      new THREE.BoxGeometry(CELL * 0.96, CELL * 0.96, CELL * 0.96);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
      if (type === 'water') {
        mat.transparent = true;
        mat.opacity = 0.6;
      }
      if (type === 'lava') {
        mat.emissive = new THREE.Color(color);
        mat.emissiveIntensity = 0.7;
      }
    }
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene3.add(mesh);
    return mesh;
  }

  for (const [type, color] of Object.entries(config.colors || {})) {
    activeMeshes[type] = makeMesh(type, color, BUDGET);
    settledMeshes[type] = makeMesh(type, color, 8192);
  }

  function ensureCapacity(store, type, needed) {
    const mesh = store[type];
    if (!mesh || needed <= mesh.instanceMatrix.count) return;
    const grown = makeMesh(type, null, Math.ceil(needed * 1.5),
                           mesh.geometry, mesh.material);
    scene3.remove(mesh);
    mesh.dispose(); // frees instance buffers; geometry/material are reused
    store[type] = grown;
  }

  function writeInstances(store, source) {
    const needed = { sand: 0, water: 0, lava: 0 };
    for (const c of source.values()) needed[c.type]++;
    for (const type of Object.keys(store)) {
      ensureCapacity(store, type, needed[type]);
    }
    const idx = { sand: 0, water: 0, lava: 0 };
    for (const c of source.values()) {
      const mesh = store[c.type];
      if (!mesh) continue;
      dummy.position.set(
        c.x * CELL + CELL / 2, c.y * CELL + CELL / 2, c.z * CELL + CELL / 2);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx[c.type]++, dummy.matrix);
    }
    for (const [type, mesh] of Object.entries(store)) {
      mesh.count = idx[type];
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function render() {
    writeInstances(activeMeshes, cells);
    if (settledDirty) {
      settledDirty = false;
      writeInstances(settledMeshes, settled);
    }
  }

  // ---- tier transitions ----
  function wakeAt(k) {
    const c = settled.get(k);
    if (!c) return;
    settled.delete(k);
    settledCounts[c.type]--;
    settledDirty = true;
    c.rest = 0;
    cells.set(k, c);
    counts[c.type]++;
  }

  const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
                     [0, 0, 1], [0, 0, -1]];

  // A position was vacated or the world changed there: settled neighbours
  // may be able to move again.
  function wakeAround(x, y, z) {
    for (const [dx, dy, dz] of NEIGHBORS) {
      wakeAt(key(x + dx, y + dy, z + dz));
    }
  }

  function settle(k, c) {
    // Never settle next to a reaction partner — stay active so the
    // cross-effect fires.
    if (c.type === 'lava' || c.type === 'water') {
      const other = c.type === 'lava' ? 'water' : 'lava';
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nk = key(c.x + dx, c.y + dy, c.z + dz);
        const n = cells.get(nk) || settled.get(nk);
        if (n && n.type === other) return;
      }
    }
    cells.delete(k);
    counts[c.type]--;
    settled.set(k, c);
    settledCounts[c.type]++;
    settledDirty = true;
  }

  // Public: the world changed inside this cell-space box (inclusive min,
  // exclusive max) — wake any settled cells in and around it.
  function disturbCells(x0, y0, z0, x1, y1, z1) {
    for (let x = x0 - 1; x < x1 + 1; x++) {
      for (let y = y0 - 1; y < y1 + 1; y++) {
        for (let z = z0 - 1; z < z1 + 1; z++) {
          wakeAt(key(x, y, z));
        }
      }
    }
  }

  function disturbBlock(bx, by, bz) {
    disturbCells(bx * PER_BLOCK, by * PER_BLOCK, bz * PER_BLOCK,
                 (bx + 1) * PER_BLOCK, (by + 1) * PER_BLOCK,
                 (bz + 1) * PER_BLOCK);
  }

  function disturbMm(xMm, yMm, zMm, sizeMm) {
    const s = Math.max(1, Math.round(sizeMm / (CELL * 1000)));
    const cx = Math.floor(xMm / (CELL * 1000));
    const cy = Math.floor(yMm / (CELL * 1000));
    const cz = Math.floor(zMm / (CELL * 1000));
    disturbCells(cx, cy, cz, cx + s, cy + s, cz + s);
  }

  // ---- movement ----
  function isFree(x, y, z) {
    if (y < 0) return false;
    const k = key(x, y, z);
    return !cells.has(k) && !settled.has(k) && !world.isSolidCell(x, y, z);
  }

  function spawn(type, x, y, z) {
    // Fluid presence is unbounded — only movement is budgeted per tick.
    if (!isFree(x, y, z)) return;
    cells.set(key(x, y, z), { x, y, z, type, rest: 0 });
    counts[type]++;
  }

  function despawn(k, c) {
    cells.delete(k);
    counts[c.type]--;
    wakeAround(c.x, c.y, c.z);
  }

  function despawnSettled(k, c) {
    settled.delete(k);
    settledCounts[c.type]--;
    settledDirty = true;
    wakeAround(c.x, c.y, c.z);
  }

  function moveTo(c, nx, ny, nz) {
    const ox = c.x, oy = c.y, oz = c.z;
    cells.delete(key(ox, oy, oz));
    c.x = nx; c.y = ny; c.z = nz;
    c.rest = 0;
    cells.set(key(nx, ny, nz), c);
    wakeAround(ox, oy, oz);
  }

  const DIAG = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function step(c) {
    if (c.y <= 0) { despawn(key(c.x, c.y, c.z), c); return; }
    if (isFree(c.x, c.y - 1, c.z)) {
      // Falling: water and sand drop two cells per tick, lava one.
      if (c.type !== 'lava' && isFree(c.x, c.y - 2, c.z) && c.y > 1) {
        moveTo(c, c.x, c.y - 2, c.z);
      } else {
        moveTo(c, c.x, c.y - 1, c.z);
      }
      return;
    }
    const dirs = DIAG.slice().sort(() => Math.random() - 0.5);
    for (const [dx, dz] of dirs) {
      if (isFree(c.x + dx, c.y - 1, c.z + dz)) {
        moveTo(c, c.x + dx, c.y - 1, c.z + dz);
        return;
      }
    }
    if (c.type !== 'sand') { // sand piles up; water and lava spread
      const sideChance = c.type === 'water' ? 0.5 : 0.2;
      if (Math.random() < sideChance) {
        const [dx, dz] = dirs[0];
        if (isFree(c.x + dx, c.y, c.z + dz)) {
          moveTo(c, c.x + dx, c.y, c.z + dz);
          return;
        }
      }
    }
    c.rest++;
  }

  // ---- cross effects ----
  function fluidAt(k) {
    return cells.get(k) || settled.get(k) || null;
  }

  function removeFluid(k, c) {
    if (cells.has(k)) despawn(k, c);
    else despawnSettled(k, c);
  }

  function crossEffects() {
    let ops = 0;
    for (const [k, c] of [...cells.entries()]) {
      if (ops > 40) break;
      if (!cells.has(k)) continue; // consumed by an earlier effect

      if (c.type === 'lava') {
        for (const [dx, dy, dz] of NEIGHBORS) {
          const nk = key(c.x + dx, c.y + dy, c.z + dz);
          const n = fluidAt(nk);
          if (n && n.type === 'water') {
            // Lava + water: the lava cell freezes to (persisted) obsidian
            despawn(k, c);
            removeFluid(nk, n);
            world.setSub(c.x * 50, c.y * 50, c.z * 50, 50, OBSIDIAN);
            effectToast('Lava + water → Obsidian');
            ops++;
            break;
          }
          const solid = world.blockAtCell(c.x + dx, c.y + dy, c.z + dz);
          if (solid && materials[solid.id] &&
              materials[solid.id].flammable && Math.random() < BURN_CHANCE) {
            if (solid.kind === 'base') {
              world.setBase(solid.x, solid.y, solid.z, 0);
            } else {
              world.setSub(solid.x, solid.y, solid.z, solid.s, 0);
            }
            effectToast(`${materials[solid.id].name} burned in lava`);
            ops++;
          }
        }
      } else if (c.type === 'water') {
        for (const [dx, dy, dz] of NEIGHBORS) {
          const solid = world.blockAtCell(c.x + dx, c.y + dy, c.z + dz);
          if (!solid) continue;
          const cooled = COOLS_TO.get(solid.id);
          if (cooled !== undefined && solid.kind === 'base') {
            world.setBase(solid.x, solid.y, solid.z, cooled);
            effectToast(`Water cooled ${materials[solid.id].name}` +
              ` → ${materials[cooled].name}`);
            ops++;
          }
        }
        // Wood floats: a small (50 mm) wooden voxel below rises through
        const below = world.subExactAtCell(c.x, c.y - 1, c.z);
        if (below && materials[below.mat] && materials[below.mat].flammable &&
            ops <= 40) {
          world.setSub(below.x, below.y, below.z, 50, 0);
          world.setSub(c.x * 50, c.y * 50, c.z * 50, 50, below.mat);
          moveTo(c, c.x, c.y - 1, c.z);
          ops++;
        }
      }
    }
  }

  // ---- faucet emission ----
  function emit() {
    if (tickNo % EMIT_EVERY) return;
    for (const f of world.faucets()) {
      const type = FAUCETS.get(f.id);
      if (!type) continue;
      const cx = f.x * PER_BLOCK + (PER_BLOCK >> 1) +
        (Math.floor(Math.random() * 3) - 1);
      const cz = f.z * PER_BLOCK + (PER_BLOCK >> 1) +
        (Math.floor(Math.random() * 3) - 1);
      spawn(type, cx, f.y * PER_BLOCK - 1, cz);
    }
  }

  const cursor = { sand: 0, water: 0, lava: 0 };

  function tick() {
    tickNo++;
    emit();
    // Movement budget: when more cells of a type are active than BUDGET,
    // step a rotating window of BUDGET cells so every cell still gets its
    // turn — more moving fluid just moves proportionally slower.
    const byType = { sand: [], water: [], lava: [] };
    for (const c of cells.values()) {
      if (byType[c.type]) byType[c.type].push(c);
    }
    const toStep = [];
    for (const [type, list] of Object.entries(byType)) {
      if (list.length <= BUDGET) {
        cursor[type] = 0;
        toStep.push(...list);
      } else {
        const start = cursor[type] % list.length;
        for (let i = 0; i < BUDGET; i++) {
          toStep.push(list[(start + i) % list.length]);
        }
        cursor[type] = (start + BUDGET) % list.length;
      }
    }
    toStep.sort((a, b) => a.y - b.y);
    for (const c of toStep) {
      if (c.type === 'lava' && tickNo % 2) continue; // lava is slower
      if (c.type === 'sand' && tickNo % 2 === 0 && Math.random() < 0.3) {
        continue; // sand a touch slower than water
      }
      step(c);
    }
    crossEffects();
    // Promote cells that reached equilibrium to the settled tier.
    for (const [k, c] of [...cells.entries()]) {
      if (c.rest >= SETTLE_TICKS) settle(k, c);
    }
    render();
  }

  function clear() {
    cells.clear();
    settled.clear();
    for (const type of Object.keys(counts)) {
      counts[type] = 0;
      settledCounts[type] = 0;
    }
    settledDirty = true;
    render();
  }

  return { tick, clear, cells, settled, counts, settledCounts, spawn,
           disturbBlock, disturbMm, budgetPerType: BUDGET };
}
