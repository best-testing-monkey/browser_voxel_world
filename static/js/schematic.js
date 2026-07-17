// Footprint-rotation helpers shared by composite object placement
// (static/js/main.js's placeObject(), for materials with `object: true`).
//
// Minecraft schematic import itself (parsing .schem/.schematic files,
// block-name resolution, and placement) runs server-side — see
// schematic_import.py and POST /api/schematic/import — so a large file no
// longer blocks the browser's main thread. This module now only keeps the
// small piece of that math still needed client-side for everyday object
// placement, which is unrelated to file import.

// Rotate a set of {x,y,z,mat} cells `steps` * 90deg clockwise (viewed from
// above, +Y up) around the vector rule (x,z) -> (-z,x), then re-normalize
// so the minimum coordinate on every axis is 0 again. Works for arbitrary
// (including negative) input coordinates. Returns the rotated/normalized
// cells plus the resulting bounding-box dimensions.
export function rotateAndNormalize(cells, steps) {
  let pts = cells;
  for (let s = 0; s < ((steps % 4) + 4) % 4; s++) {
    pts = pts.map((p) => ({ x: -p.z, y: p.y, z: p.x, mat: p.mat }));
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
  }
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const out = pts.map((p) => {
    const nx = p.x - minX, ny = p.y - minY, nz = p.z - minZ;
    if (nx > maxX) maxX = nx;
    if (ny > maxY) maxY = ny;
    if (nz > maxZ) maxZ = nz;
    return { x: nx, y: ny, z: nz, mat: p.mat };
  });
  return {
    cells: out,
    width: maxX + 1 || 1,
    height: maxY + 1 || 1,
    length: maxZ + 1 || 1,
  };
}

// Steps needed to turn a structure's local "north" (-Z) to face away from
// the given outward face normal; floor/ceiling hits keep it unrotated
// (there's no reliable horizontal facing to infer from a vertical normal).
export function stepsFromNormal(normal) {
  if (Math.abs(normal.y) > 0.5) return 0;
  if (normal.x > 0.5) return 1;
  if (normal.x < -0.5) return 3;
  if (normal.z > 0.5) return 2;
  return 0; // normal.z < -0.5 (north) — already the authored default
}
