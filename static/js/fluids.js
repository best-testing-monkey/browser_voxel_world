// Fluid simulation: sand, water and lava as 5 cm (50 mm) fluid voxels that
// pour out of faucet blocks. The rules (which materials are faucets, what
// lava+water makes, what burns, what cools) come from the backend's
// /api/config "fluids" section — the client just executes them.
//
// Fluid cells are ephemeral (they settle and rest, but are not persisted);
// their *effects* are real world edits: obsidian from lava+water, burned
// wood, cooled magma. Those go through the normal edit channel and persist.

export function createFluidSim({ THREE, scene3, config, materials, world,
                                 toast }) {
  const CELL = (config.cellMm || 50) / 1000;   // metres
  const PER_BLOCK = Math.round(1 / CELL);      // cells per 1000 mm voxel
  const MAX = config.maxCellsPerType || 1200;
  const EMIT_EVERY = config.emitEveryTicks || 3;
  const BURN_CHANCE = config.burnChance || 0.08;
  const OBSIDIAN = config.lavaWaterContact;
  const COOLS_TO = new Map(
    Object.entries(config.coolsTo || {}).map(([k, v]) => [+k, +v]));
  const FAUCETS = new Map(
    Object.entries(config.faucets || {}).map(([k, v]) => [+k, v]));

  const cells = new Map();   // "x,y,z" (50mm ints) -> {x,y,z,type}
  const counts = { sand: 0, water: 0, lava: 0 };
  let tickNo = 0;
  let lastToast = 0;

  const key = (x, y, z) => `${x},${y},${z}`;

  function effectToast(msg) {
    const now = performance.now();
    if (now - lastToast > 1500) { lastToast = now; toast(msg); }
  }

  // ---- rendering: one InstancedMesh per fluid type ----
  const meshes = {};
  const dummy = new THREE.Object3D();
  for (const [type, color] of Object.entries(config.colors || {})) {
    const geo = new THREE.BoxGeometry(CELL * 0.96, CELL * 0.96, CELL * 0.96);
    const opts = { color: new THREE.Color(color) };
    const mat = new THREE.MeshLambertMaterial(opts);
    if (type === 'water') {
      mat.transparent = true;
      mat.opacity = 0.6;
    }
    if (type === 'lava') {
      mat.emissive = new THREE.Color(color);
      mat.emissiveIntensity = 0.7;
    }
    const mesh = new THREE.InstancedMesh(geo, mat, MAX);
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene3.add(mesh);
    meshes[type] = mesh;
  }

  function render() {
    const idx = { sand: 0, water: 0, lava: 0 };
    for (const c of cells.values()) {
      const mesh = meshes[c.type];
      if (!mesh || idx[c.type] >= MAX) continue;
      dummy.position.set(
        c.x * CELL + CELL / 2, c.y * CELL + CELL / 2, c.z * CELL + CELL / 2);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx[c.type]++, dummy.matrix);
    }
    for (const [type, mesh] of Object.entries(meshes)) {
      mesh.count = idx[type];
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---- movement ----
  function isFree(x, y, z) {
    if (y < 0) return false;
    return !cells.has(key(x, y, z)) && !world.isSolidCell(x, y, z);
  }

  function spawn(type, x, y, z) {
    if (counts[type] >= MAX || !isFree(x, y, z)) return;
    cells.set(key(x, y, z), { x, y, z, type });
    counts[type]++;
  }

  function despawn(k, c) {
    cells.delete(k);
    counts[c.type]--;
  }

  function moveTo(c, nx, ny, nz) {
    cells.delete(key(c.x, c.y, c.z));
    c.x = nx; c.y = ny; c.z = nz;
    cells.set(key(nx, ny, nz), c);
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
    if (c.type === 'sand') return; // sand piles up
    const sideChance = c.type === 'water' ? 0.5 : 0.2;
    if (Math.random() < sideChance) {
      const [dx, dz] = dirs[0];
      if (isFree(c.x + dx, c.y, c.z + dz)) {
        moveTo(c, c.x + dx, c.y, c.z + dz);
      }
    }
  }

  // ---- cross effects ----
  const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
                     [0, 0, 1], [0, 0, -1]];

  function crossEffects() {
    let ops = 0;
    for (const [k, c] of [...cells.entries()]) {
      if (ops > 40) break;
      if (!cells.has(k)) continue; // consumed by an earlier effect

      if (c.type === 'lava') {
        for (const [dx, dy, dz] of NEIGHBORS) {
          const nk = key(c.x + dx, c.y + dy, c.z + dz);
          const n = cells.get(nk);
          if (n && n.type === 'water') {
            // Lava + water: the lava cell freezes to (persisted) obsidian
            despawn(k, c);
            despawn(nk, n);
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
      if (!type || counts[type] >= MAX) continue;
      const cx = f.x * PER_BLOCK + (PER_BLOCK >> 1) +
        (Math.floor(Math.random() * 3) - 1);
      const cz = f.z * PER_BLOCK + (PER_BLOCK >> 1) +
        (Math.floor(Math.random() * 3) - 1);
      spawn(type, cx, f.y * PER_BLOCK - 1, cz);
    }
  }

  function tick() {
    tickNo++;
    emit();
    const list = [...cells.values()].sort((a, b) => a.y - b.y);
    for (const c of list) {
      if (c.type === 'lava' && tickNo % 2) continue; // lava is slower
      if (c.type === 'sand' && tickNo % 2 === 0 && Math.random() < 0.3) {
        continue; // sand a touch slower than water
      }
      step(c);
    }
    crossEffects();
    render();
  }

  function clear() {
    cells.clear();
    counts.sand = counts.water = counts.lava = 0;
    render();
  }

  return { tick, clear, cells, counts };
}
