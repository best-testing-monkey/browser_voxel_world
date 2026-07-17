"""Minecraft schematic import, server-side.

Ported from the original client-side implementation (static/js/schematic.js,
nbt.js, inflate.js) so that parsing a large file no longer blocks the
browser's main thread — the client now just uploads the raw file bytes and
polls for progress while this module does the work in a background thread
(see server.py's /api/schematic/import and /api/schematic/status).

Supports Sponge/WorldEdit .schem (versions 1-3) and the legacy MCEdit
.schematic format, gzip- or zlib-compressed (or raw) NBT.
"""

import gzip
import struct
import zlib

MAX_SCHEMATIC_DIM = 512  # max width/height/length, each axis


class SchematicTooLarge(Exception):
    def __init__(self, width, height, length):
        self.width, self.height, self.length = width, height, length
        super().__init__(
            f"schematic too large ({width}x{height}x{length}) "
            f"— max {MAX_SCHEMATIC_DIM} per axis")


# ---------------------------------------------------------------------------
# Decompression: gzip/zlib/raw-deflate, auto-detected by magic bytes. Python's
# stdlib gzip/zlib (both C-implemented) replace the hand-rolled JS decoder.
# ---------------------------------------------------------------------------
def inflate_auto(raw):
    if len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B:
        return gzip.decompress(raw)
    if len(raw) >= 2 and (raw[0] & 0x0F) == 8 and \
            ((raw[0] << 8 | raw[1]) % 31 == 0):
        return zlib.decompress(raw)
    return zlib.decompress(raw, -15)  # raw deflate, no header


# ---------------------------------------------------------------------------
# NBT (Named Binary Tag) reader — big-endian, all 12 tag types.
# ---------------------------------------------------------------------------
(TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG, TAG_FLOAT, TAG_DOUBLE,
 TAG_BYTE_ARRAY, TAG_STRING, TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY,
 TAG_LONG_ARRAY) = range(13)


class _Cursor:
    __slots__ = ("data", "pos")

    def __init__(self, data):
        self.data = data
        self.pos = 0

    def u8(self):
        v = self.data[self.pos]
        self.pos += 1
        return v

    def i8(self):
        v = self.u8()
        return v - 256 if v >= 128 else v

    def u16(self):
        v = struct.unpack_from(">H", self.data, self.pos)[0]
        self.pos += 2
        return v

    def i16(self):
        v = struct.unpack_from(">h", self.data, self.pos)[0]
        self.pos += 2
        return v

    def i32(self):
        v = struct.unpack_from(">i", self.data, self.pos)[0]
        self.pos += 4
        return v

    def i64(self):
        v = struct.unpack_from(">q", self.data, self.pos)[0]
        self.pos += 8
        return v

    def f32(self):
        v = struct.unpack_from(">f", self.data, self.pos)[0]
        self.pos += 4
        return v

    def f64(self):
        v = struct.unpack_from(">d", self.data, self.pos)[0]
        self.pos += 8
        return v

    def bytes_raw(self, n):
        v = self.data[self.pos:self.pos + n]
        self.pos += n
        return v

    def string(self):
        n = self.u16()
        return self.bytes_raw(n).decode("utf-8")


def _read_payload(c, tag_type):
    if tag_type == TAG_BYTE:
        return c.i8()
    if tag_type == TAG_SHORT:
        return c.i16()
    if tag_type == TAG_INT:
        return c.i32()
    if tag_type == TAG_LONG:
        return c.i64()
    if tag_type == TAG_FLOAT:
        return c.f32()
    if tag_type == TAG_DOUBLE:
        return c.f64()
    if tag_type == TAG_BYTE_ARRAY:
        n = c.i32()
        return c.bytes_raw(n)
    if tag_type == TAG_STRING:
        return c.string()
    if tag_type == TAG_LIST:
        elem_type = c.u8()
        n = c.i32()
        return [_read_payload(c, elem_type) for _ in range(max(0, n))]
    if tag_type == TAG_COMPOUND:
        obj = {}
        while True:
            t = c.u8()
            if t == TAG_END:
                break
            name = c.string()
            obj[name] = _read_payload(c, t)
        return obj
    if tag_type == TAG_INT_ARRAY:
        n = c.i32()
        vals = struct.unpack_from(f">{n}i", c.data, c.pos) if n else ()
        c.pos += 4 * n
        return list(vals)
    if tag_type == TAG_LONG_ARRAY:
        n = c.i32()
        vals = struct.unpack_from(f">{n}q", c.data, c.pos) if n else ()
        c.pos += 8 * n
        return list(vals)
    raise ValueError(f"nbt: unknown tag type {tag_type}")


def parse_nbt(data):
    """Parse a full (already decompressed) NBT byte stream into a plain
    dict tree. The root tag must be a named Compound; its name is
    discarded."""
    c = _Cursor(data)
    root_type = c.u8()
    if root_type != TAG_COMPOUND:
        raise ValueError("nbt: root tag is not a compound")
    c.string()  # root name, usually empty
    return _read_payload(c, TAG_COMPOUND)


# ---------------------------------------------------------------------------
# Shared rotation/placement math — steps needed to face a structure's local
# "north" (-Z) away from a given outward face normal, and the closed-form
# per-cell (x,z) -> (nx,nz) transform for that many 90-degree turns, derived
# from (and verified against) the client's generic rotateAndNormalize().
# ---------------------------------------------------------------------------
def steps_from_normal(normal):
    if abs(normal["y"]) > 0.5:
        return 0
    if normal["x"] > 0.5:
        return 1
    if normal["x"] < -0.5:
        return 3
    if normal["z"] > 0.5:
        return 2
    return 0


def _rotated_dims(width, length, steps):
    return (width, length) if steps in (0, 2) else (length, width)


def _rotate_xz(x, z, width, length, steps):
    if steps == 0:
        return x, z
    if steps == 1:
        return length - 1 - z, x
    if steps == 2:
        return width - 1 - x, length - 1 - z
    return z, width - 1 - x  # steps == 3


# ---------------------------------------------------------------------------
# Block name / legacy id -> material id resolution
# ---------------------------------------------------------------------------
SHAPE_SUFFIXES = [
    "_stairs", "_double_slab", "_slab", "_fence_gate", "_fence",
    "_wall_sign", "_wall_torch", "_wall_banner", "_wall_head", "_wall",
    "_door", "_trapdoor", "_pressure_plate", "_button", "_carpet", "_bed",
    "_torch", "_lantern", "_campfire", "_hanging_sign", "_sign", "_banner",
    "_head", "_panes", "_pane",
]


def _title_case(slug):
    return " ".join((w[:1].upper() + w[1:]) if w else w
                     for w in slug.split("_"))


def _normalize_block_name(raw):
    name = raw.split("[", 1)[0]
    if name.startswith("minecraft:"):
        name = name[len("minecraft:"):]
    return name


def _resolve_material_id(raw_name, name_to_id, unmapped):
    base = _normalize_block_name(raw_name)
    if base in ("", "air", "cave_air", "void_air"):
        return 0
    mat_id = name_to_id.get(_title_case(base))
    if mat_id is None:
        for suf in SHAPE_SUFFIXES:
            if base.endswith(suf) and len(base) > len(suf):
                mat_id = name_to_id.get(_title_case(base[:-len(suf)]))
                if mat_id is not None:
                    break
    if mat_id is None:
        unmapped.add(base)
        mat_id = name_to_id.get("Stone", 1)
    return mat_id


# Legacy (pre-1.13) numeric block ids -> material names, covering the common
# ones typical hand-built .schematic files use. Not exhaustive — obscure
# legacy ids fall back to Stone like any other unmapped block.
LEGACY_ID_NAMES = {
    1: "Stone", 2: "Grass Block", 3: "Dirt", 4: "Cobblestone",
    7: "Bedrock", 8: "Water", 9: "Water", 10: "Lava", 11: "Lava",
    12: "Sand", 13: "Gravel", 14: "Gold Ore", 15: "Iron Ore", 16: "Coal Ore",
    18: "Oak Leaves", 19: "Sponge", 20: "Glass", 21: "Lapis Lazuli Ore",
    22: "Lapis Lazuli Block", 24: "Sandstone", 30: "Cobweb", 37: "Poppy",
    41: "Gold Block", 42: "Iron Block", 43: "Stone", 45: "Brick Block",
    46: "TNT", 47: "Bookshelf", 48: "Mossy Cobblestone", 49: "Obsidian",
    50: "Torch", 52: "Monster Spawner", 53: "Oak Planks", 56: "Diamond Ore",
    57: "Diamond Block", 58: "Crafting Table", 61: "Furnace", 62: "Furnace",
    73: "Redstone Ore", 74: "Redstone Ore", 78: "Snow Block", 79: "Ice",
    80: "Snow Block", 81: "Cactus", 82: "Clay Block", 84: "Jukebox",
    86: "Pumpkin", 87: "Netherrack", 88: "Soul Sand", 89: "Glowstone",
    91: "Jack o'Lantern", 95: "White Stained Glass", 98: "Stone Bricks",
    103: "Melon", 110: "Mycelium", 112: "Nether Bricks", 121: "End Stone",
    129: "Emerald Ore", 133: "Emerald Block", 155: "Quartz Block",
    159: "White Terracotta", 162: "Acacia Log", 168: "Prismarine",
    169: "Sea Lantern", 170: "Hay Bale", 172: "Terracotta",
    173: "Coal Block", 174: "Packed Ice", 179: "Red Sandstone",
    201: "Purpur Block",
}
LEGACY_PLANKS_BY_DATA = ["Oak Planks", "Spruce Planks", "Birch Planks",
                         "Jungle Planks", "Acacia Planks", "Dark Oak Planks"]
LEGACY_LOG_BY_DATA = ["Oak Log", "Spruce Log", "Birch Log", "Jungle Log"]
LEGACY_WOOL_BY_DATA = ["White Wool", "Orange Wool", "Magenta Wool",
                       "Light Blue Wool", "Yellow Wool", "Lime Wool",
                       "Pink Wool", "Gray Wool", "Light Gray Wool",
                       "Cyan Wool", "Purple Wool", "Blue Wool", "Brown Wool",
                       "Green Wool", "Red Wool", "Black Wool"]


def _resolve_legacy_id(block_id, data, name_to_id, unmapped):
    if block_id == 0:
        return 0
    if block_id == 5 and data < len(LEGACY_PLANKS_BY_DATA):
        return name_to_id.get(LEGACY_PLANKS_BY_DATA[data], 1)
    if block_id == 17 and data < len(LEGACY_LOG_BY_DATA):
        return name_to_id.get(LEGACY_LOG_BY_DATA[data], 1)
    if block_id == 35 and data < len(LEGACY_WOOL_BY_DATA):
        return name_to_id.get(LEGACY_WOOL_BY_DATA[data], 1)
    name = LEGACY_ID_NAMES.get(block_id)
    if name is not None:
        mid = name_to_id.get(name)
        if mid is not None:
            return mid
    unmapped.add(f"legacy id {block_id}")
    return name_to_id.get("Stone", 1)


# ---------------------------------------------------------------------------
# VarInt (Minecraft/LEB128-style unsigned varint) decoding, inlined into the
# per-cell loops below rather than pre-decoded into a separate array — for
# a very large schematic that avoids materializing a second huge list.
# ---------------------------------------------------------------------------

PROGRESS_STEP = 50_000  # cells between progress-callback updates


def _parse_sponge_and_place(root, name_to_id, target, normal, chunk_y,
                             progress_cb):
    is_v3 = (root.get("Version") or 1) >= 3 and isinstance(
        root.get("Blocks"), dict)
    body = root["Blocks"] if is_v3 else root
    width, height, length = root["Width"], root["Height"], root["Length"]
    if (width > MAX_SCHEMATIC_DIM or height > MAX_SCHEMATIC_DIM or
            length > MAX_SCHEMATIC_DIM):
        raise SchematicTooLarge(width, height, length)

    palette_obj = body.get("Palette")
    data = body.get("Data") if is_v3 else body.get("BlockData")
    if not palette_obj or data is None:
        raise ValueError("schematic: missing Palette/BlockData")

    unmapped = set()
    stone_id = name_to_id.get("Stone", 1)
    palette_size = max(palette_obj.values()) + 1
    palette_to_mat = [stone_id] * palette_size
    for name, idx in palette_obj.items():
        palette_to_mat[idx] = _resolve_material_id(name, name_to_id, unmapped)

    steps = steps_from_normal(normal)
    width2, length2 = _rotated_dims(width, length, steps)
    ox = target["x"] - width2 // 2
    oy = target["y"] - height // 2
    oz = target["z"] - length2 // 2
    if oy < 0:
        oy = 0
    if oy + height > chunk_y:
        oy = max(0, chunk_y - height)

    total = width * height * length
    edits = {}
    pos = 0
    processed = 0
    for y in range(height):
        wy = oy + y
        in_y_range = 0 <= wy < chunk_y
        for z in range(length):
            for x in range(width):
                value = 0
                shift = 0
                while True:
                    b = data[pos]
                    pos += 1
                    value |= (b & 0x7F) << shift
                    shift += 7
                    if not (b & 0x80):
                        break
                processed += 1
                if progress_cb and processed % PROGRESS_STEP == 0:
                    progress_cb(processed, total)
                if in_y_range:
                    nx, nz = _rotate_xz(x, z, width, length, steps)
                    edits[(ox + nx, wy, oz + nz)] = palette_to_mat[value]
    if progress_cb:
        progress_cb(total, total)
    bbox = (ox, oy, oz, ox + width2, oy + height, oz + length2)
    return edits, sorted(unmapped), bbox


def _parse_legacy_and_place(root, name_to_id, target, normal, chunk_y,
                            progress_cb):
    width, height, length = root["Width"], root["Height"], root["Length"]
    if (width > MAX_SCHEMATIC_DIM or height > MAX_SCHEMATIC_DIM or
            length > MAX_SCHEMATIC_DIM):
        raise SchematicTooLarge(width, height, length)

    blocks = root["Blocks"]
    add = root.get("AddBlocks")
    data_arr = root.get("Data")
    unmapped = set()

    steps = steps_from_normal(normal)
    width2, length2 = _rotated_dims(width, length, steps)
    ox = target["x"] - width2 // 2
    oy = target["y"] - height // 2
    oz = target["z"] - length2 // 2
    if oy < 0:
        oy = 0
    if oy + height > chunk_y:
        oy = max(0, chunk_y - height)

    total = width * height * length
    edits = {}
    processed = 0
    i = 0
    for y in range(height):
        wy = oy + y
        in_y_range = 0 <= wy < chunk_y
        for z in range(length):
            for x in range(width):
                block_id = blocks[i] & 0xFF
                if add is not None:
                    nibble = (add[i >> 1] >> ((i & 1) * 4)) & 0xF
                    block_id |= nibble << 8
                data_val = (data_arr[i] & 0xFF) if data_arr is not None else 0
                mat = _resolve_legacy_id(block_id, data_val, name_to_id,
                                         unmapped)
                i += 1
                processed += 1
                if progress_cb and processed % PROGRESS_STEP == 0:
                    progress_cb(processed, total)
                if in_y_range:
                    nx, nz = _rotate_xz(x, z, width, length, steps)
                    edits[(ox + nx, wy, oz + nz)] = mat
    if progress_cb:
        progress_cb(total, total)
    bbox = (ox, oy, oz, ox + width2, oy + height, oz + length2)
    return edits, sorted(unmapped), bbox


def parse_and_place(raw_bytes, name_to_id, target, normal, chunk_y,
                     progress_cb=None):
    """Parse a schematic file's raw bytes and compute its placement.

    `target`/`normal` are {"x","y","z"} dicts (target = the solid block hit,
    normal = the outward face normal), matching the client's raycast result.
    `progress_cb(processed, total)` is called periodically during the
    (potentially long) per-cell decode/placement loop.

    Returns (edits, unmapped, bbox):
      edits: {(x, y, z): material_id} in world/base-grid coordinates
      unmapped: sorted list of block names/ids that fell back to Stone
      bbox: (x0, y0, z0, x1, y1, z1) — half-open world-space bounding box

    Raises SchematicTooLarge if any axis exceeds MAX_SCHEMATIC_DIM, or
    ValueError if the file isn't a recognized format.
    """
    inflated = inflate_auto(raw_bytes)
    root = parse_nbt(inflated)

    if root.get("Palette") and root.get("BlockData") is not None:
        return _parse_sponge_and_place(root, name_to_id, target, normal,
                                        chunk_y, progress_cb)
    blocks_val = root.get("Blocks")
    if (isinstance(blocks_val, dict) and blocks_val.get("Palette") and
            blocks_val.get("Data") is not None):
        return _parse_sponge_and_place(root, name_to_id, target, normal,
                                        chunk_y, progress_cb)
    if blocks_val is not None and root.get("Width") is not None:
        return _parse_legacy_and_place(root, name_to_id, target, normal,
                                       chunk_y, progress_cb)
    raise ValueError("schematic: unrecognized format")
