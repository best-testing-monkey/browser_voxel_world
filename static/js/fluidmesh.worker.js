// Fluid surface worker: turns the fluid simulation's per-block level grids
// into smooth marching-cubes surfaces — one mesh per fluid type per 1 m
// block, covering only the boundary between fluid and air.
//
// Input arrives from the simulation worker over a MessagePort:
//   {type:'blocks', epoch, blocks:[{bx,by,bz, grid, depth, flow} |
//                                  {bx,by,bz, empty:true}]}
// where each grid is (PER_BLOCK+2)^3 cells (one cell of padding from the
// neighbouring blocks on every side), see fluidsim.worker.js.
//
// The scalar field sampled at cell centres is
//   fluid of this type: 0.5 + 0.5 * level/8  (sand: 1)     -> inside
//   air, other fluids : 0                                   -> outside
//   solid             : the highest neighbouring fluid value
// so every fluid cell is inside the iso-surface at 0.5, the surface height
// between a cell and the air above it follows the fill level (interpolated
// per corner by marching cubes), and walls/floors adopt the fluid's value so
// the surface meets them without a visible gap (the closing part of the
// surface is hidden inside the solid).
//
// Each block owns the cubes whose minimum corner is one of its own cells;
// the cube reaching into the next block's first cell is built here, so
// neighbouring blocks never produce the same triangles twice.
//
// Output to the main thread:
//   {type:'surface', epoch, bx,by,bz, meshes:{water|lava|sand:
//     {positions, normals, depth, flow}}}   positions relative to the block

import { edgeTable, triTable, EDGE_CORNERS, CORNER_OFFSETS } from './mc_tables.js';

const TYPES = { 1: 'water', 2: 'lava', 3: 'sand' };
const ISO = 0.5;

let port = null;
let PER_BLOCK = 20;
let CELL = 0.05;           // metres
let epoch = 0;

// Grow-on-demand Float32 builder.
class FBuf {
  constructor(n = 3072) { this.a = new Float32Array(n); this.n = 0; }
  push(v) {
    if (this.n >= this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

function buildField(grid, P, type) {
  const field = new Float32Array(P * P * P);
  let any = false;
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i];
    if (g && !(g & 0x80) && (g >> 4) === type) {
      field[i] = type === 3 ? 1 : 0.5 + 0.5 * (g & 15) / 8;
      any = true;
    }
  }
  if (!any) return null;
  // Solids take the strongest neighbouring fluid value.
  const PP = P * P;
  for (let j = 0; j < P; j++) {
    for (let k = 0; k < P; k++) {
      for (let i = 0; i < P; i++) {
        const idx = i + k * P + j * PP;
        if (!(grid[idx] & 0x80)) continue;
        let m = 0;
        const probe = (n) => {
          const g = grid[n];
          if (g && !(g & 0x80) && (g >> 4) === type && field[n] > m) m = field[n];
        };
        if (i > 0) probe(idx - 1);
        if (i < P - 1) probe(idx + 1);
        if (k > 0) probe(idx - P);
        if (k < P - 1) probe(idx + P);
        if (j > 0) probe(idx - PP);
        if (j < P - 1) probe(idx + PP);
        field[idx] = m;
      }
    }
  }
  return field;
}

function polygonize(field, grid, depth, flow, P) {
  const PP = P * P;
  const pos = new FBuf(), nrm = new FBuf(), dep = new FBuf(), flw = new FBuf();
  const at = (i, j, k) => field[i + k * P + j * PP];
  const clampI = (v) => (v < 0 ? 0 : v > P - 1 ? P - 1 : v);
  // Field gradient by central differences (clamped at the grid border).
  const grad = (i, j, k) => [
    at(clampI(i + 1), j, k) - at(clampI(i - 1), j, k),
    at(i, clampI(j + 1), k) - at(i, clampI(j - 1), k),
    at(i, j, clampI(k + 1)) - at(i, j, clampI(k - 1)),
  ];
  const vals = new Float32Array(8);
  const edgeVerts = new Array(12);

  for (let j = 1; j <= P - 2; j++) {
    for (let k = 1; k <= P - 2; k++) {
      for (let i = 1; i <= P - 2; i++) {
        let ci = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER_OFFSETS[c];
          vals[c] = at(i + o[0], j + o[1], k + o[2]);
          if (vals[c] < ISO) ci |= 1 << c;
        }
        const bits = edgeTable[ci];
        if (!bits) continue;
        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          const [a, b] = EDGE_CORNERS[e];
          const oa = CORNER_OFFSETS[a], ob = CORNER_OFFSETS[b];
          const va = vals[a], vb = vals[b];
          const t = Math.abs(vb - va) < 1e-6 ? 0.5 : (ISO - va) / (vb - va);
          const ia = i + oa[0], ja = j + oa[1], ka = k + oa[2];
          const ib = i + ob[0], jb = j + ob[1], kb = k + ob[2];
          const ga = grad(ia, ja, ka), gb = grad(ib, jb, kb);
          // Attributes come from whichever end is inside the fluid.
          const inside = va >= vb ? ia + ka * P + ja * PP : ib + kb * P + jb * PP;
          edgeVerts[e] = {
            // Cell centre of padded index p sits at (p - 1 + 0.5) cells
            // from the block origin.
            x: (ia + t * (ib - ia) - 0.5) * CELL,
            y: (ja + t * (jb - ja) - 0.5) * CELL,
            z: (ka + t * (kb - ka) - 0.5) * CELL,
            // The field decreases outward, so the outward normal is -grad.
            nx: -(ga[0] + t * (gb[0] - ga[0])),
            ny: -(ga[1] + t * (gb[1] - ga[1])),
            nz: -(ga[2] + t * (gb[2] - ga[2])),
            d: (grid[inside] & 0x80 ? 1 : depth[inside]) * CELL,
            f: inside,
          };
        }
        const base = ci * 16;
        for (let n = 0; triTable[base + n] !== -1; n += 3) {
          // In table order the triangles wind counter-clockwise seen from
          // outside (the low-value side), i.e. outward-facing front faces.
          for (const e of [triTable[base + n], triTable[base + n + 1],
                           triTable[base + n + 2]]) {
            const v = edgeVerts[e];
            pos.push(v.x); pos.push(v.y); pos.push(v.z);
            let l = Math.hypot(v.nx, v.ny, v.nz);
            if (l < 1e-6) { v.nx = 0; v.ny = 1; v.nz = 0; l = 1; }
            nrm.push(v.nx / l); nrm.push(v.ny / l); nrm.push(v.nz / l);
            dep.push(v.d);
            flw.push(flow[v.f * 3] / 127);
            flw.push(flow[v.f * 3 + 1] / 127);
            flw.push(flow[v.f * 3 + 2] / 127);
          }
        }
      }
    }
  }
  if (!pos.n) return null;
  return { positions: pos.done(), normals: nrm.done(), depth: dep.done(),
           flow: flw.done() };
}

function meshBlock(block) {
  const P = PER_BLOCK + 2;
  const meshes = {};
  const transfer = [];
  if (!block.empty) {
    for (const t of [1, 2, 3]) {
      const field = buildField(block.grid, P, t);
      if (!field) continue;
      const m = polygonize(field, block.grid, block.depth, block.flow, P);
      if (!m) continue;
      meshes[TYPES[t]] = m;
      transfer.push(m.positions.buffer, m.normals.buffer, m.depth.buffer,
                    m.flow.buffer);
    }
  }
  postMessage({ type: 'surface', epoch, bx: block.bx, by: block.by,
                bz: block.bz, meshes }, transfer);
}

function onBlocks(e) {
  const msg = e.data;
  if (msg.type !== 'blocks' || msg.epoch !== epoch) return;
  for (const block of msg.blocks) meshBlock(block);
}

onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    CELL = (msg.cellMm || 50) / 1000;
    PER_BLOCK = Math.round(1000 / (msg.cellMm || 50));
    port = msg.port;
    port.onmessage = onBlocks;
  } else if (msg.type === 'clear') {
    epoch = msg.epoch;
  }
};

// Exposed for tests (node): build one block's meshes synchronously.
export { buildField, polygonize };
