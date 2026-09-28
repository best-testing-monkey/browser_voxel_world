// Voxel lighting engine: Minecraft-style flood-fill light at the 1 m cell
// resolution — but with COLOURED light. Each cell stores two RGB channels
// (4 bits per component, packed into a Uint32):
//   skylight  (r,g,b): 15 under open sky, spreads -1 per step, travels
//              straight down without loss; scaled by the day factor at
//              render time. Passing through stained glass filters each
//              colour component, so sunlight through a blue pane is blue.
//   blocklight (r,g,b): seeded by emissive materials in the material's own
//              colour, spreads -1 per step, filtered by glass the same
//              way; independent of time of day — this is what lights caves.
//
// Which materials emit ("emissive": 1..15), their colours, and which pass
// light ("translucent") all come from the backend material catalog.
//
// Runs inside the mesher worker (mesher.worker.js) on its worldstore copy.
// Light is stored per 16-tall section like the voxels (chunk.light[sy] is a
// Uint32Array or null), so only the part of a 1024-tall column that light
// actually reaches costs memory.

import { chunkKey, SECTION_H } from './worldstore.js';

export const MAX_LIGHT = 15;
// Packed value for "open sky, no blocklight": sky r,g,b = 15, block = 0.
export const OPEN_SKY = (0xfff << 12) >>> 0;

export function createLightEngine({ store, materials }) {
  const { CX, CY, CZ, LAYER, NS, SECTION_CELLS, chunks } = store;
  const MAX = MAX_LIGHT;

  // Highest occupied cell seen anywhere so far (across every chunk that's
  // been lit at least once). Not per-column: blocklight can travel
  // horizontally from a tall column's torch into a shorter neighbouring
  // column's air, above *that* column's own top, so any single-column
  // bound would risk reading the "open sky" default over a real value.
  let globalTopY = -1;

  // Per-material light behaviour, cached by material id:
  // {opaque, seed:[r,g,b] emission, tint:[r,g,b] filter for translucents}
  const AIR_INFO = { opaque: false, seed: null, tint: null };
  const matCache = [];
  function matInfo(matId) {
    if (!matId) return AIR_INFO;
    let info = matCache[matId];
    if (info) return info;
    const m = materials[matId];
    if (!m) return AIR_INFO;
    const rgb = [
      parseInt(m.color.slice(1, 3), 16) / 255,
      parseInt(m.color.slice(3, 5), 16) / 255,
      parseInt(m.color.slice(5, 7), 16) / 255,
    ];
    const peak = Math.max(rgb[0], rgb[1], rgb[2], 0.01);
    const norm = rgb.map((c) => c / peak); // hue-preserving, max = 1
    info = {
      opaque: !m.translucent,
      seed: m.emissive ? norm.map((c) => Math.round(m.emissive * c)) : null,
      tint: m.translucent ? norm : null,
    };
    matCache[matId] = info;
    return info;
  }

  const ceiling = () => Math.min(CY - 1, globalTopY + MAX);

  // Packed light at a world cell: [sr sg sb br bg bb] 4 bits each.
  function lightAt(x, y, z) {
    if (y >= CY) return OPEN_SKY;
    if (y < 0) return 0;
    const cx = Math.floor(x / CX), cz = Math.floor(z / CZ);
    const chunk = chunks.get(chunkKey(cx, cz));
    // Unloaded/unlit neighbour: assume open sky so borders aren't black.
    if (!chunk || !chunk.light) return OPEN_SKY;
    // Above anything blocklight could possibly have reached: open sky.
    if (y > ceiling()) return OPEN_SKY;
    const sec = chunk.light[y >> 4];
    if (!sec) return 0;
    return sec[(x - cx * CX) + (z - cz * CZ) * CX + (y & 15) * LAYER];
  }

  // Highest occupied cell per column (-1 = all air), including sub-voxels:
  // a torch or object on top of the terrain needs a correct light value in
  // its containing cell even above the highest *base* voxel.
  function computeTopY(chunk) {
    const topY = new Int16Array(LAYER).fill(-1);
    for (let si = NS - 1; si >= 0; si--) {
      const sec = chunk.sections[si];
      if (!sec) continue;
      for (let col = 0; col < LAYER; col++) {
        if (topY[col] >= 0) continue;
        for (let ly = SECTION_H - 1; ly >= 0; ly--) {
          if (sec[col + ly * LAYER]) {
            topY[col] = si * SECTION_H + ly;
            break;
          }
        }
      }
    }
    const ox = chunk.cx * CX, oz = chunk.cz * CZ;
    for (const sv of chunk.sub.values()) {
      const y = Math.floor(sv.y / 1000);
      const col = (Math.floor(sv.x / 1000) - ox) +
        (Math.floor(sv.z / 1000) - oz) * CX;
      if (col >= 0 && col < LAYER && y > topY[col]) topY[col] = y;
    }
    chunk.topY = topY;
  }

  // Recompute lighting for an arbitrary set of chunks in one pass. Light
  // entering from lit chunks bordering the set is taken into account.
  function relightSet(region) {
    if (!region.length) return [];

    const inRegion = new Map();
    for (const c of region) {
      c.light = new Array(NS).fill(null);
      inRegion.set(chunkKey(c.cx, c.cz), c);
      computeTopY(c);
      for (let i = 0; i < c.topY.length; i++) {
        if (c.topY[i] > globalTopY) globalTopY = c.topY[i];
      }
    }
    const lightCeiling = ceiling();

    const cellChunk = (x, z) => inRegion.get(
      chunkKey(Math.floor(x / CX), Math.floor(z / CZ)));

    // Write per-component maxima; returns true if anything improved.
    const raise = (chunk, y, i, r, g, b, shift) => {
      let sec = chunk.light[y >> 4];
      if (!sec) sec = chunk.light[y >> 4] = new Uint32Array(SECTION_CELLS);
      const v = sec[i];
      const cr = (v >> (shift + 8)) & 15, cg = (v >> (shift + 4)) & 15,
            cb = (v >> shift) & 15;
      const nr = cr > r ? cr : r, ng = cg > g ? cg : g, nb = cb > b ? cb : b;
      if (nr === cr && ng === cg && nb === cb) return false;
      const mask = ~(0xfff << shift);
      sec[i] = (v & mask) | (((nr << 8) | (ng << 4) | nb) << shift);
      return true;
    };

    // Queues are flat int arrays: x, y, z, r, g, b per entry.
    const skyQ = [];
    const blockQ = [];

    // --- seed ---
    for (const chunk of region) {
      const ox = chunk.cx * CX, oz = chunk.cz * CZ;
      for (let lz = 0; lz < CZ; lz++) {
        for (let lx = 0; lx < CX; lx++) {
          const col = lx + lz * CX;
          const top = chunk.topY[col];
          if (top < 0) continue; // fully-air column: nothing to light
          // Skylight: full white from just above the terrain down to the
          // first opaque voxel (tinted through translucent blocks).
          let sr = MAX, sg = MAX, sb = MAX;
          for (let y = Math.min(CY - 1, top + 1); y >= 0; y--) {
            const info = matInfo(store.localVoxel(chunk, lx, y, lz));
            if (info.opaque) break;
            if (info.tint) {
              sr = Math.floor(sr * info.tint[0]);
              sg = Math.floor(sg * info.tint[1]);
              sb = Math.floor(sb * info.tint[2]);
            }
            if (sr <= 0 && sg <= 0 && sb <= 0) break;
            const i = col + (y & 15) * LAYER;
            raise(chunk, y, i, sr, sg, sb, 12);
            skyQ.push(ox + lx, y, oz + lz, sr, sg, sb);
          }
          // Blocklight: emissive materials seed in their own colour.
          for (let si = 0; si <= top >> 4; si++) {
            const sec = chunk.sections[si];
            if (!sec) continue;
            for (let ly = 0; ly < SECTION_H; ly++) {
              const info = matInfo(sec[col + ly * LAYER]);
              if (!info.seed) continue;
              const y = si * SECTION_H + ly;
              raise(chunk, y, col + ly * LAYER, ...info.seed, 0);
              blockQ.push(ox + lx, y, oz + lz, ...info.seed);
            }
          }
        }
      }
      // Emissive sub-voxels light their containing cell.
      for (const sv of chunk.sub.values()) {
        const info = matInfo(sv.mat);
        if (!info.seed) continue;
        const x = Math.floor(sv.x / 1000), y = Math.floor(sv.y / 1000),
              z = Math.floor(sv.z / 1000);
        if (y < 0 || y >= CY) continue;
        const i = (x - ox) + (z - oz) * CX + (y & 15) * LAYER;
        if (raise(chunk, y, i, ...info.seed, 0)) {
          blockQ.push(x, y, z, ...info.seed);
        }
      }
    }

    // Light entering from lit chunks bordering the region.
    for (const chunk of region) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = chunkKey(chunk.cx + dx, chunk.cz + dz);
        if (inRegion.has(nk)) continue;
        const nb = chunks.get(nk);
        if (!nb || !nb.light) continue;
        for (let i = 0; i < (dx !== 0 ? CZ : CX); i++) {
          const nlx = dx === 1 ? 0 : (dx === -1 ? CX - 1 : i);
          const nlz = dz === 1 ? 0 : (dz === -1 ? CZ - 1 : i);
          const wx = nb.cx * CX + nlx, wz = nb.cz * CZ + nlz;
          for (let y = 0; y <= lightCeiling; y++) {
            const sec = nb.light[y >> 4];
            if (!sec) { y |= 15; continue; }
            const v = sec[nlx + nlz * CX + (y & 15) * LAYER];
            const sr = (v >> 20) & 15, sg = (v >> 16) & 15,
                  sb = (v >> 12) & 15;
            const br = (v >> 8) & 15, bg = (v >> 4) & 15, bb = v & 15;
            if (sr > 1 || sg > 1 || sb > 1) skyQ.push(wx, y, wz, sr, sg, sb);
            if (br > 1 || bg > 1 || bb > 1) blockQ.push(wx, y, wz, br, bg, bb);
          }
        }
      }
    }

    // --- BFS spread: -1 per step per component (skylight keeps 15 going
    // straight down), filtered through translucent blocks' tints.
    const DIRS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
    const spread = (q, isSky) => {
      const shift = isSky ? 12 : 0;
      for (let qi = 0; qi < q.length; qi += 6) {
        const x = q[qi], y = q[qi + 1], z = q[qi + 2];
        const r = q[qi + 3], g = q[qi + 4], b = q[qi + 5];
        for (let d = 0; d < 18; d += 3) {
          const dy = DIRS[d + 1];
          const nx = x + DIRS[d], ny = y + dy, nz = z + DIRS[d + 2];
          if (ny < 0 || ny >= CY) continue;
          const chunk = cellChunk(nx, nz);
          if (!chunk) continue;
          const lx = nx - chunk.cx * CX, lz = nz - chunk.cz * CZ;
          const info = matInfo(store.localVoxel(chunk, lx, ny, lz));
          if (info.opaque) continue;
          const down = isSky && dy === -1;
          let nr = down && r === MAX ? MAX : r - 1;
          let ng = down && g === MAX ? MAX : g - 1;
          let nb2 = down && b === MAX ? MAX : b - 1;
          if (info.tint) {
            nr = Math.floor(Math.max(0, nr) * info.tint[0]);
            ng = Math.floor(Math.max(0, ng) * info.tint[1]);
            nb2 = Math.floor(Math.max(0, nb2) * info.tint[2]);
          }
          if (nr <= 0 && ng <= 0 && nb2 <= 0) continue;
          if (nr < 0) nr = 0;
          if (ng < 0) ng = 0;
          if (nb2 < 0) nb2 = 0;
          const i = lx + lz * CX + (ny & 15) * LAYER;
          if (raise(chunk, ny, i, nr, ng, nb2, shift)) {
            q.push(nx, ny, nz, nr, ng, nb2);
          }
        }
      }
    };
    spread(skyQ, true);
    spread(blockQ, false);
    return region;
  }

  // Relight the union of the 3x3 neighbourhoods of the given chunk keys —
  // far cheaper than a region pass per chunk when many change at once, and
  // light crosses the whole union consistently. Returns the relit chunks.
  function relightAround(keys) {
    const union = new Map();
    for (const key of keys) {
      const [cx, cz] = key.split(',').map(Number);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = chunkKey(cx + dx, cz + dz);
          const chunk = chunks.get(k);
          if (chunk) union.set(k, chunk);
        }
      }
    }
    return relightSet([...union.values()]);
  }

  function reset() {
    globalTopY = -1;
  }

  return { lightAt, relightAround, reset, matInfo };
}
