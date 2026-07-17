// Minecraft schematic import: Sponge/WorldEdit .schem (versions 1-3) and
// the legacy MCEdit/Schematica .schematic format. Pure client-side feature:
// parse the file, resolve blocks to this game's material catalog, compute
// placement, and hand the result to the caller's bulk-apply function — the
// backend only ever sees ordinary /api/edits, same as a player building by
// hand. Also exports rotateAndNormalize(), the footprint-rotation helper
// shared with composite object placement (see materials with `object:true`
// and static/js/main.js's placeObject()).

import { inflateAuto } from '/js/inflate.js';
import { parseNbt } from '/js/nbt.js';

export const MAX_SCHEMATIC_DIM = 512; // max width/height/length, each axis

// ---------------------------------------------------------------------------
// Shared rotation/placement math (also used by object placement in main.js)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Block name / legacy id -> material id resolution
// ---------------------------------------------------------------------------

const SHAPE_SUFFIXES = [
  '_stairs', '_double_slab', '_slab', '_fence_gate', '_fence',
  '_wall_sign', '_wall_torch', '_wall_banner', '_wall_head', '_wall',
  '_door', '_trapdoor', '_pressure_plate', '_button', '_carpet', '_bed',
  '_torch', '_lantern', '_campfire', '_hanging_sign', '_sign', '_banner',
  '_head', '_panes', '_pane',
];

function titleCase(slug) {
  return slug.split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function normalizeBlockName(raw) {
  return raw.split('[')[0].replace(/^minecraft:/, '');
}

function resolveMaterialId(rawName, nameToId, unmapped) {
  const base = normalizeBlockName(rawName);
  if (base === '' || base === 'air' || base === 'cave_air' ||
      base === 'void_air') {
    return 0;
  }
  let id = nameToId.get(titleCase(base));
  if (id === undefined) {
    for (const suf of SHAPE_SUFFIXES) {
      if (base.endsWith(suf) && base.length > suf.length) {
        id = nameToId.get(titleCase(base.slice(0, -suf.length)));
        if (id !== undefined) break;
      }
    }
  }
  if (id === undefined) {
    unmapped.add(base);
    id = nameToId.get('Stone') || 1;
  }
  return id;
}

// Legacy (pre-1.13) numeric block ids -> our material names, covering the
// common ones typical hand-built .schematic files use. Not exhaustive —
// obscure/rare legacy ids fall back to Stone like any other unmapped block.
const LEGACY_ID_NAMES = {
  1: 'Stone', 2: 'Grass Block', 3: 'Dirt', 4: 'Cobblestone',
  7: 'Bedrock', 8: 'Water', 9: 'Water', 10: 'Lava', 11: 'Lava',
  12: 'Sand', 13: 'Gravel', 14: 'Gold Ore', 15: 'Iron Ore', 16: 'Coal Ore',
  18: 'Oak Leaves', 19: 'Sponge', 20: 'Glass', 21: 'Lapis Lazuli Ore',
  22: 'Lapis Lazuli Block', 24: 'Sandstone', 30: 'Cobweb', 37: 'Poppy',
  41: 'Gold Block', 42: 'Iron Block', 43: 'Stone', 45: 'Brick Block',
  46: 'TNT', 47: 'Bookshelf', 48: 'Mossy Cobblestone', 49: 'Obsidian',
  50: 'Torch', 52: 'Monster Spawner', 53: 'Oak Planks', 56: 'Diamond Ore',
  57: 'Diamond Block', 58: 'Crafting Table', 61: 'Furnace', 62: 'Furnace',
  73: 'Redstone Ore', 74: 'Redstone Ore', 78: 'Snow Block', 79: 'Ice',
  80: 'Snow Block', 81: 'Cactus', 82: 'Clay Block', 84: 'Jukebox',
  86: 'Pumpkin', 87: 'Netherrack', 88: 'Soul Sand', 89: 'Glowstone',
  91: "Jack o'Lantern", 95: 'White Stained Glass', 98: 'Stone Bricks',
  103: 'Melon', 110: 'Mycelium', 112: 'Nether Bricks', 121: 'End Stone',
  129: 'Emerald Ore', 133: 'Emerald Block', 155: 'Quartz Block',
  159: 'White Terracotta', 162: 'Acacia Log', 168: 'Prismarine',
  169: 'Sea Lantern', 170: 'Hay Bale', 172: 'Terracotta',
  173: 'Coal Block', 174: 'Packed Ice', 179: 'Red Sandstone',
  201: 'Purpur Block',
};
const LEGACY_PLANKS_BY_DATA = ['Oak Planks', 'Spruce Planks', 'Birch Planks',
  'Jungle Planks', 'Acacia Planks', 'Dark Oak Planks'];
const LEGACY_LOG_BY_DATA = ['Oak Log', 'Spruce Log', 'Birch Log',
  'Jungle Log'];
const LEGACY_WOOL_BY_DATA = ['White Wool', 'Orange Wool', 'Magenta Wool',
  'Light Blue Wool', 'Yellow Wool', 'Lime Wool', 'Pink Wool', 'Gray Wool',
  'Light Gray Wool', 'Cyan Wool', 'Purple Wool', 'Blue Wool', 'Brown Wool',
  'Green Wool', 'Red Wool', 'Black Wool'];

function resolveLegacyId(id, data, nameToId, unmapped) {
  if (id === 0) return 0;
  if (id === 5 && data < LEGACY_PLANKS_BY_DATA.length) {
    return nameToId.get(LEGACY_PLANKS_BY_DATA[data]) || 1;
  }
  if (id === 17 && data < LEGACY_LOG_BY_DATA.length) {
    return nameToId.get(LEGACY_LOG_BY_DATA[data]) || 1;
  }
  if (id === 35 && data < LEGACY_WOOL_BY_DATA.length) {
    return nameToId.get(LEGACY_WOOL_BY_DATA[data]) || 1;
  }
  const name = LEGACY_ID_NAMES[id];
  if (name) {
    const mid = nameToId.get(name);
    if (mid !== undefined) return mid;
  }
  unmapped.add(`legacy id ${id}`);
  return nameToId.get('Stone') || 1;
}

// ---------------------------------------------------------------------------
// VarInt (Minecraft/LEB128-style unsigned varint) decoding for Sponge's
// BlockData/Data byte array.
// ---------------------------------------------------------------------------
function readVarInts(bytes, count) {
  const out = new Array(count);
  let pos = 0;
  for (let i = 0; i < count; i++) {
    let value = 0, size = 0, b;
    do {
      b = bytes[pos++];
      value |= (b & 0x7f) << (7 * size);
      size++;
    } while ((b & 0x80) !== 0 && size < 5);
    out[i] = value >>> 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format parsing: returns {width, height, length, cells: [{x,y,z,mat}]}
// with cells already resolved to material ids (0 = air), local coordinates
// 0-based in [0,width)x[0,height)x[0,length).
// ---------------------------------------------------------------------------
function parseSponge(root, nameToId, unmapped) {
  const isV3 = (root.Version || 1) >= 3 && root.Blocks;
  const body = isV3 ? root.Blocks : root;
  const width = root.Width, height = root.Height, length = root.Length;
  const paletteObj = body.Palette;
  const dataArr = isV3 ? body.Data : body.BlockData;
  if (!paletteObj || !dataArr) {
    throw new Error('schematic: missing Palette/BlockData');
  }
  const paletteByIndex = [];
  for (const [name, idx] of Object.entries(paletteObj)) {
    paletteByIndex[idx] = name;
  }
  const total = width * height * length;
  const indices = readVarInts(dataArr, total);
  const idToMat = paletteByIndex.map(
    (name) => resolveMaterialId(name, nameToId, unmapped));

  const cells = [];
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++, i++) {
        const mat = idToMat[indices[i]];
        cells.push({ x, y, z, mat });
      }
    }
  }
  return { width, height, length, cells };
}

function parseLegacy(root, nameToId, unmapped) {
  const width = root.Width, height = root.Height, length = root.Length;
  const blocks = root.Blocks;
  const add = root.AddBlocks; // optional nibble array, high bits of id>255
  const dataArr = root.Data;
  const total = width * height * length;
  const cells = [];
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++, i++) {
        let id = blocks[i] & 0xff;
        if (add) {
          const nibble = (add[i >> 1] >> ((i & 1) * 4)) & 0xf;
          id |= nibble << 8;
        }
        const data = dataArr ? (dataArr[i] & 0xff) : 0;
        cells.push({ x, y, z, mat: resolveLegacyId(id, data, nameToId, unmapped) });
      }
    }
  }
  return { width, height, length, cells };
}

/** Parse an ArrayBuffer (already read from a File) into a resolved cell
 * grid. `nameToId` is a Map<materialName, id> built from state.materials. */
export function parseSchematic(arrayBuffer, nameToId) {
  const raw = new Uint8Array(arrayBuffer);
  const inflated = inflateAuto(raw);
  const root = parseNbt(inflated);
  const unmapped = new Set();

  let parsed;
  if (root.Palette && root.BlockData) {
    parsed = parseSponge(root, nameToId, unmapped); // Sponge v1/v2
  } else if (root.Blocks && root.Blocks.Palette && root.Blocks.Data) {
    parsed = parseSponge(root, nameToId, unmapped); // Sponge v3 (nested)
  } else if (root.Blocks && root.Width !== undefined) {
    parsed = parseLegacy(root, nameToId, unmapped); // legacy: Blocks is a byte array
  } else {
    throw new Error('schematic: unrecognized format');
  }
  return { ...parsed, unmapped: [...unmapped] };
}

// ---------------------------------------------------------------------------
// Placement: centered on the target voxel in all three axes, oriented to
// face away from the clicked surface, clamped/truncated to world height.
// ---------------------------------------------------------------------------
export function placeSchematic(parsed, target, normal, chunkY) {
  const local = parsed.cells.map((c) => ({ x: c.x, y: c.y, z: c.z, mat: c.mat }));
  const steps = stepsFromNormal(normal);
  const { cells, width, height, length } = rotateAndNormalize(local, steps);

  let ox = target.x - Math.floor(width / 2);
  let oy = target.y - Math.floor(height / 2);
  let oz = target.z - Math.floor(length / 2);

  if (oy < 0) oy = 0;
  if (oy + height > chunkY) oy = Math.max(0, chunkY - height);

  const world = [];
  for (const c of cells) {
    const wy = oy + c.y;
    if (wy < 0 || wy >= chunkY) continue; // truncate: taller than the world
    world.push({ x: ox + c.x, y: wy, z: oz + c.z, mat: c.mat });
  }
  return world;
}
