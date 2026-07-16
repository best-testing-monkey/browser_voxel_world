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

export function createLightEngine({ state, dims }) {
  const { CX, CY, CZ } = dims;
  const LAYER = CX * CZ;
  const MAX = 15;

  const dirty = new Set();
  let timer = null;

  const chunkKey = (cx, cz) => `${cx},${cz}`;

  // Per-material light behaviour, cached by material id:
  // {opaque, seed:[r,g,b] emission, tint:[r,g,b] filter for translucents}
  const matCache = [];
  function matInfo(matId) {
    if (!matId) return AIR_INFO;
    let info = matCache[matId];
    if (info) return info;
    const m = state.materials[matId];
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
      seed: m.emissive
        ? norm.map((c) => Math.round(m.emissive * c))
        : null,
      tint: m.translucent ? norm : null,
    };
    matCache[matId] = info;
    return info;
  }
  const AIR_INFO = { opaque: false, seed: null, tint: null };

  // Packing: [sr sg sb br bg bb], 4 bits each in a Uint32 per cell.
  function lightAt(x, y, z) {
    if (y >= CY) return { sky: [MAX, MAX, MAX], block: [0, 0, 0] };
    if (y < 0) return { sky: [0, 0, 0], block: [0, 0, 0] };
    const cx = Math.floor(x / CX), cz = Math.floor(z / CZ);
    const chunk = state.chunks.get(chunkKey(cx, cz));
    if (!chunk || !chunk.light) {
      // Unloaded/unlit neighbour: assume open sky so borders aren't black.
      return { sky: [MAX, MAX, MAX], block: [0, 0, 0] };
    }
    const v = chunk.light[
      (x - cx * CX) + (z - cz * CZ) * CX + y * LAYER];
    return {
      sky: [(v >> 20) & 15, (v >> 16) & 15, (v >> 12) & 15],
      block: [(v >> 8) & 15, (v >> 4) & 15, v & 15],
    };
  }

  // Recompute lighting for the 3x3 chunk region centred on (ccx, ccz).
  function relightRegion(ccx, ccz) {
    const region = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = state.chunks.get(chunkKey(ccx + dx, ccz + dz));
        if (chunk && chunk.data) region.push(chunk);
      }
    }
    return relightSet(region);
  }

  // Recompute lighting for an arbitrary set of chunks in one pass.
  function relightSet(region) {
    if (!region.length) return [];

    const inRegion = new Map();
    for (const c of region) {
      c.light = new Uint32Array(CX * CY * CZ);
      inRegion.set(chunkKey(c.cx, c.cz), c);
    }

    const idx = (lx, y, lz) => lx + lz * CX + y * LAYER;
    const cellChunk = (x, z) => inRegion.get(
      chunkKey(Math.floor(x / CX), Math.floor(z / CZ)));

    // Write per-component maxima; returns true if anything improved.
    const raise = (chunk, i, r, g, b, shift) => {
      const v = chunk.light[i];
      const cr = (v >> (shift + 8)) & 15, cg = (v >> (shift + 4)) & 15,
            cb = (v >> shift) & 15;
      const nr = Math.max(cr, r), ng = Math.max(cg, g), nb = Math.max(cb, b);
      if (nr === cr && ng === cg && nb === cb) return false;
      const mask = ~(0xfff << shift);
      chunk.light[i] = (v & mask) | (((nr << 8) | (ng << 4) | nb) << shift);
      return true;
    };
    const raiseSky = (c, i, r, g, b) => raise(c, i, r, g, b, 12);
    const raiseBlock = (c, i, r, g, b) => raise(c, i, r, g, b, 0);

    const skyQ = [];
    const blockQ = [];

    // --- seed ---
    for (const chunk of region) {
      const ox = chunk.cx * CX, oz = chunk.cz * CZ;
      for (let lz = 0; lz < CZ; lz++) {
        for (let lx = 0; lx < CX; lx++) {
          // Skylight: full white from the top down to the first opaque
          // voxel (tinted if it passes through translucent blocks).
          let s = [MAX, MAX, MAX];
          for (let y = CY - 1; y >= 0; y--) {
            const info = matInfo(chunk.data[idx(lx, y, lz)]);
            if (info.opaque) break;
            if (info.tint) {
              s = s.map((c, i) => Math.floor(c * info.tint[i]));
            }
            if (s[0] <= 0 && s[1] <= 0 && s[2] <= 0) break;
            raiseSky(chunk, idx(lx, y, lz), s[0], s[1], s[2]);
            skyQ.push([ox + lx, y, oz + lz, s[0], s[1], s[2]]);
          }
          // Blocklight: emissive materials seed in their own colour.
          for (let y = 0; y < CY; y++) {
            const info = matInfo(chunk.data[idx(lx, y, lz)]);
            if (info.seed) {
              raiseBlock(chunk, idx(lx, y, lz), ...info.seed);
              blockQ.push([ox + lx, y, oz + lz, ...info.seed]);
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
        const lx = x - chunk.cx * CX, lz = z - chunk.cz * CZ;
        if (raiseBlock(chunk, idx(lx, y, lz), ...info.seed)) {
          blockQ.push([x, y, z, ...info.seed]);
        }
      }
    }

    // Light entering from lit chunks bordering the region.
    for (const chunk of region) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = chunkKey(chunk.cx + dx, chunk.cz + dz);
        if (inRegion.has(nk)) continue;
        const nb = state.chunks.get(nk);
        if (!nb || !nb.light) continue;
        for (let i = 0; i < (dx !== 0 ? CZ : CX); i++) {
          const nlx = dx === 1 ? 0 : (dx === -1 ? CX - 1 : i);
          const nlz = dz === 1 ? 0 : (dz === -1 ? CZ - 1 : i);
          const wx = nb.cx * CX + nlx, wz = nb.cz * CZ + nlz;
          for (let y = 0; y < CY; y++) {
            const v = nb.light[idx(nlx, y, nlz)];
            const sr = (v >> 20) & 15, sg = (v >> 16) & 15,
                  sb = (v >> 12) & 15;
            const br = (v >> 8) & 15, bg = (v >> 4) & 15, bb = v & 15;
            if (sr > 1 || sg > 1 || sb > 1) {
              skyQ.push([wx, y, wz, sr, sg, sb]);
            }
            if (br > 1 || bg > 1 || bb > 1) {
              blockQ.push([wx, y, wz, br, bg, bb]);
            }
          }
        }
      }
    }

    // --- BFS spread: -1 per step per component (skylight keeps 15 going
    // straight down), filtered through translucent blocks' tints.
    const spread = (queue, isSky) => {
      for (let qi = 0; qi < queue.length; qi++) {
        const [x, y, z, r, g, b] = queue[qi];
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0],
                                    [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (ny < 0 || ny >= CY) continue;
          const chunk = cellChunk(nx, nz);
          if (!chunk) continue;
          const lx = nx - chunk.cx * CX, lz = nz - chunk.cz * CZ;
          const i = idx(lx, ny, lz);
          const info = matInfo(chunk.data[i]);
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
          nr = Math.max(0, nr); ng = Math.max(0, ng); nb2 = Math.max(0, nb2);
          const wrote = isSky
            ? raiseSky(chunk, i, nr, ng, nb2)
            : raiseBlock(chunk, i, nr, ng, nb2);
          if (wrote) queue.push([nx, ny, nz, nr, ng, nb2]);
        }
      }
    };
    spread(skyQ, true);
    spread(blockQ, false);
    return region;
  }

  function markDirty(cx, cz, onRelit) {
    dirty.add(chunkKey(cx, cz));
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const batch = [...dirty];
      dirty.clear();
      // One union pass over the 3x3 neighbourhoods of every dirty chunk —
      // far cheaper than a region pass per dirty chunk when many load at
      // once, and light crosses the whole union consistently.
      const union = new Map();
      for (const key of batch) {
        const [cx2, cz2] = key.split(',').map(Number);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = chunkKey(cx2 + dx, cz2 + dz);
            const chunk = state.chunks.get(k);
            if (chunk && chunk.data) union.set(k, chunk);
          }
        }
      }
      const touched = relightSet([...union.values()]);
      if (onRelit) onRelit(touched);
    }, 50);
  }

  function reset() {
    dirty.clear();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { lightAt, relightRegion, markDirty, reset };
}
