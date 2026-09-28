// Sectioned voxel storage shared by the main thread and the workers.
//
// A chunk is CX x CY x CZ base (1000 mm) cells, split vertically into
// SECTION_H-tall sections. Each section is a Uint16Array of material ids
// indexed lx + lz*CX + ly*CX*CZ, or null when it is entirely air — most of
// a 1024-tall chunk is sky, so this keeps memory proportional to content.
//
// Chunk objects look like {cx, cz, sections: Array<Uint16Array|null>,
// sub: Map<"x,y,z,s", {x, y, z, s, mat}>} plus whatever each thread hangs
// on them (meshes, light, occupancy sets).

export const SECTION_H = 16;

export const chunkKey = (cx, cz) => `${cx},${cz}`;
export const subKey = (x, y, z, s) => `${x},${y},${z},${s}`;

export function createWorldStore({ CX, CY, CZ }) {
  const LAYER = CX * CZ;
  const SECTION_CELLS = LAYER * SECTION_H;
  const NS = Math.ceil(CY / SECTION_H);
  const chunks = new Map();

  function chunkAt(wx, wz) {
    return chunks.get(chunkKey(Math.floor(wx / CX), Math.floor(wz / CZ)));
  }

  function getVoxel(wx, wy, wz) {
    if (wy < 0 || wy >= CY) return 0;
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const chunk = chunks.get(chunkKey(cx, cz));
    if (!chunk) return 0;
    const sec = chunk.sections[wy >> 4];
    if (!sec) return 0;
    return sec[(wx - cx * CX) + (wz - cz * CZ) * CX + (wy & 15) * LAYER];
  }

  // Local-coordinate read within one chunk (no Map lookup).
  function localVoxel(chunk, lx, y, lz) {
    const sec = chunk.sections[y >> 4];
    return sec ? sec[lx + lz * CX + (y & 15) * LAYER] : 0;
  }

  // Write a base cell; returns the chunk or null if it isn't loaded.
  function setVoxel(wx, wy, wz, id) {
    if (wy < 0 || wy >= CY) return null;
    const cx = Math.floor(wx / CX), cz = Math.floor(wz / CZ);
    const chunk = chunks.get(chunkKey(cx, cz));
    if (!chunk) return null;
    const si = wy >> 4;
    let sec = chunk.sections[si];
    if (!sec) {
      if (!id) return chunk;
      sec = chunk.sections[si] = new Uint16Array(SECTION_CELLS);
    }
    sec[(wx - cx * CX) + (wz - cz * CZ) * CX + (wy & 15) * LAYER] = id;
    return chunk;
  }

  function subChunkAt(xMm, zMm) {
    return chunks.get(chunkKey(
      Math.floor(xMm / (CX * 1000)), Math.floor(zMm / (CZ * 1000))));
  }

  function setSub(xMm, yMm, zMm, sMm, id) {
    const chunk = subChunkAt(xMm, zMm);
    if (!chunk) return null;
    const key = subKey(xMm, yMm, zMm, sMm);
    if (id === 0) chunk.sub.delete(key);
    else chunk.sub.set(key, { x: xMm, y: yMm, z: zMm, s: sMm, mat: id });
    return chunk;
  }

  // Build a chunk from decoded sections: [{sy, data: Uint16Array}], subs:
  // [[x, y, z, s, mat]].
  function makeChunk(cx, cz, sectionList, subs) {
    const sections = new Array(NS).fill(null);
    for (const { sy, data } of sectionList) {
      if (sy >= 0 && sy < NS) sections[sy] = data;
    }
    const sub = new Map();
    for (const [x, y, z, s, mat] of subs) {
      sub.set(subKey(x, y, z, s), { x, y, z, s, mat });
    }
    return { cx, cz, sections, sub };
  }

  return {
    CX, CY, CZ, LAYER, NS, SECTION_CELLS, chunks,
    chunkAt, getVoxel, localVoxel, setVoxel, subChunkAt, setSub, makeChunk,
  };
}

// Parse the backend's binary chunk format (GET /api/chunk?format=bin; see
// server.py build_chunk_binary). Returns {cx, cz, sections:[{sy, data}],
// subs:[[x, y, z, s, mat]]}. Section arrays are fresh copies.
export function decodeChunkBinary(buf, { CX, CZ }) {
  const view = new DataView(buf);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'VXC1') throw new Error(`bad chunk magic ${magic}`);
  const cx = view.getInt32(4, true);
  const cz = view.getInt32(8, true);
  const count = view.getUint16(12, true);
  const subCount = view.getUint32(16, true);
  const cells = CX * CZ * SECTION_H;
  const sections = [];
  let off = 20;
  for (let i = 0; i < count; i++) {
    const sy = view.getUint16(off, true);
    off += 2;
    // Copy out of the response buffer (offsets are always even, and
    // every browser we target is little-endian like the wire format).
    const data = new Uint16Array(cells);
    data.set(new Uint16Array(buf, off, cells));
    sections.push({ sy, data });
    off += cells * 2;
  }
  const subs = [];
  for (let i = 0; i < subCount; i++) {
    subs.push([view.getInt32(off, true), view.getInt32(off + 4, true),
               view.getInt32(off + 8, true), view.getUint16(off + 12, true),
               view.getUint16(off + 14, true)]);
    off += 16;
  }
  return { cx, cz, sections, subs };
}
