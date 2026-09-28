"""SQLite-backed world storage for the voxel backend.

World edits are layered over procedurally generated terrain. They are kept
per 16 x 16 x 16 *section* (CHUNK_X x SECTION_H x CHUNK_Z cells), so reading
or writing one chunk never has to look at the edits of the rest of the world:

  sections   (scene, cx, cz, sy) -> zlib(uint16[4096])   base-grid edits
  subvoxels  (scene, cx, cz)     -> zlib(packed records) smaller voxels
  kv         key                 -> JSON                 worlds/time/screens

A section overlay stores the edited material id per cell, or NO_EDIT (0xFFFF)
where the generated terrain shows through; 0 is a real edit to air (e.g. a
mined block, or the air inside a pasted schematic).

The primary keys start with (scene, cx, ...), so any box of chunks is one
range query (see ensure_columns) — the chunk size a caller asks for is not
baked into the storage format.

Columns are loaded lazily into memory the first time a chunk in them is read
or written, and stay cached. Writes only touch memory and mark the section
dirty; a background thread flushes dirty sections, sub-voxel columns and
metadata to disk in one transaction about once a second (and on shutdown),
instead of rewriting the whole world after every edit.
"""

import json
import struct
import sys
import sqlite3
import threading
import zlib
from array import array

NO_EDIT = 0xFFFF
SUB_RECORD = struct.Struct("<iiiHH")  # x_mm, y_mm, z_mm, size_mm, material


def _to_le_bytes(arr):
    if sys.byteorder == "big":
        arr = array("H", arr)
        arr.byteswap()
    return arr.tobytes()


def _from_le_bytes(data):
    arr = array("H")
    arr.frombytes(data)
    if sys.byteorder == "big":
        arr.byteswap()
    return arr


class WorldStore:
    def __init__(self, path, chunk_x, chunk_z, section_h, flush_interval=1.0):
        self.path = path
        self.cx_size = chunk_x
        self.cz_size = chunk_z
        self.section_h = section_h
        self.section_cells = chunk_x * chunk_z * section_h
        self.empty_overlay = array("H", [NO_EDIT]) * self.section_cells

        # One re-entrant lock guards all in-memory state below; server.py
        # uses it as its EDITS_LOCK too, so the edit log and the stores
        # change atomically together.
        self.lock = threading.RLock()
        self.db_lock = threading.Lock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        with self.db_lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.executescript("""
                CREATE TABLE IF NOT EXISTS sections (
                    scene TEXT NOT NULL, cx INTEGER NOT NULL,
                    cz INTEGER NOT NULL, sy INTEGER NOT NULL,
                    data BLOB NOT NULL,
                    PRIMARY KEY (scene, cx, cz, sy)) WITHOUT ROWID;
                CREATE TABLE IF NOT EXISTS subvoxels (
                    scene TEXT NOT NULL, cx INTEGER NOT NULL,
                    cz INTEGER NOT NULL, data BLOB NOT NULL,
                    PRIMARY KEY (scene, cx, cz)) WITHOUT ROWID;
                CREATE TABLE IF NOT EXISTS kv (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)
            self.conn.commit()

        self.overlays = {}   # scene -> {(cx, cz): {sy: array('H')}}
        self.subs = {}       # scene -> {(cx, cz): {(x, y, z, s): mat}}
        self.loaded = {}     # scene -> {(cx, cz)} columns read from disk
        self.versions = {}   # (scene, cx, cz) -> int, bumped on every change
        self.dirty_sections = set()  # (scene, cx, cz, sy)
        self.dirty_subs = set()      # (scene, cx, cz)
        self.meta_dirty = False
        self.meta_provider = None    # () -> {kv key: JSON-able value}

        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._flush_loop, args=(flush_interval,), daemon=True)
        self._thread.start()

    # ---- scenes ----
    def add_scene(self, scene):
        with self.lock:
            self.overlays.setdefault(scene, {})
            self.subs.setdefault(scene, {})
            self.loaded.setdefault(scene, set())

    def drop_scene(self, scene):
        """Forget a deleted world in memory and on disk, right away, so a
        new world that later reuses the same id starts empty."""
        with self.lock:
            self.overlays.pop(scene, None)
            self.subs.pop(scene, None)
            self.loaded.pop(scene, None)
            self.dirty_sections = {k for k in self.dirty_sections
                                   if k[0] != scene}
            self.dirty_subs = {k for k in self.dirty_subs if k[0] != scene}
            for key in [k for k in self.versions if k[0] == scene]:
                del self.versions[key]
        with self.db_lock:
            self.conn.execute("DELETE FROM sections WHERE scene=?", (scene,))
            self.conn.execute("DELETE FROM subvoxels WHERE scene=?", (scene,))
            self.conn.commit()

    # ---- lazy column loading ----
    def ensure_columns(self, scene, cx0, cz0, cx1, cz1):
        """Make sure every column in the inclusive chunk box is in memory,
        with one range query for whatever is still missing."""
        with self.lock:
            loaded = self.loaded[scene]
            missing = [(cx, cz) for cx in range(cx0, cx1 + 1)
                       for cz in range(cz0, cz1 + 1)
                       if (cx, cz) not in loaded]
            if not missing:
                return
            with self.db_lock:
                sec_rows = self.conn.execute(
                    "SELECT cx, cz, sy, data FROM sections WHERE scene=? "
                    "AND cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?",
                    (scene, cx0, cx1, cz0, cz1)).fetchall()
                sub_rows = self.conn.execute(
                    "SELECT cx, cz, data FROM subvoxels WHERE scene=? "
                    "AND cx BETWEEN ? AND ? AND cz BETWEEN ? AND ?",
                    (scene, cx0, cx1, cz0, cz1)).fetchall()
            missing_set = set(missing)
            overlays = self.overlays[scene]
            for cx, cz, sy, data in sec_rows:
                if (cx, cz) in missing_set:
                    overlays.setdefault((cx, cz), {})[sy] = \
                        _from_le_bytes(zlib.decompress(data))
            subs = self.subs[scene]
            for cx, cz, data in sub_rows:
                if (cx, cz) not in missing_set:
                    continue
                raw = zlib.decompress(data)
                col = subs.setdefault((cx, cz), {})
                for x, y, z, s, m in SUB_RECORD.iter_unpack(raw):
                    col[(x, y, z, s)] = m
            loaded.update(missing_set)

    def ensure_column_set(self, scene, columns):
        if not columns:
            return
        xs = [c[0] for c in columns]
        zs = [c[1] for c in columns]
        self.ensure_columns(scene, min(xs), min(zs), max(xs), max(zs))

    # ---- base grid (1000 mm) edits ----
    def _split(self, x, y, z):
        cx, lx = divmod(x, self.cx_size)
        cz, lz = divmod(z, self.cz_size)
        sy, ly = divmod(y, self.section_h)
        return cx, cz, sy, lx + lz * self.cx_size + \
            ly * self.cx_size * self.cz_size

    def get_edit(self, scene, x, y, z):
        """The edited material at a base cell, or None if unedited."""
        cx, cz, sy, i = self._split(x, y, z)
        with self.lock:
            self.ensure_columns(scene, cx, cz, cx, cz)
            sec = self.overlays[scene].get((cx, cz), {}).get(sy)
            if sec is None or sec[i] == NO_EDIT:
                return None
            return sec[i]

    def set_edit(self, scene, x, y, z, mat):
        cx, cz, sy, i = self._split(x, y, z)
        with self.lock:
            self.ensure_columns(scene, cx, cz, cx, cz)
            col = self.overlays[scene].setdefault((cx, cz), {})
            sec = col.get(sy)
            if sec is None:
                sec = col[sy] = array("H", self.empty_overlay)
            sec[i] = mat
            self.dirty_sections.add((scene, cx, cz, sy))
            self._bump(scene, cx, cz)

    def merge_sections(self, scene, sections):
        """Bulk-apply {(cx, cz, sy): overlay} (NO_EDIT = leave as is), e.g.
        a pasted schematic. Returns the set of touched columns."""
        columns = {(cx, cz) for cx, cz, _ in sections}
        with self.lock:
            self.ensure_column_set(scene, columns)
            overlays = self.overlays[scene]
            for (cx, cz, sy), sec in sections.items():
                col = overlays.setdefault((cx, cz), {})
                cur = col.get(sy)
                if cur is None or NO_EDIT not in sec:
                    col[sy] = sec
                else:
                    for i, v in enumerate(sec):
                        if v != NO_EDIT:
                            cur[i] = v
                self.dirty_sections.add((scene, cx, cz, sy))
            for cx, cz in columns:
                self._bump(scene, cx, cz)
        return columns

    def column_overlays(self, scene, cx, cz):
        """{sy: overlay} for one column. Caller must hold self.lock while
        reading the arrays."""
        self.ensure_columns(scene, cx, cz, cx, cz)
        return self.overlays[scene].get((cx, cz), {})

    # ---- sub-voxels (sizes below 1000 mm, keyed in integer mm) ----
    def _sub_column(self, x_mm, z_mm):
        return (x_mm // (self.cx_size * 1000), z_mm // (self.cz_size * 1000))

    def set_sub(self, scene, x, y, z, s, mat):
        cx, cz = self._sub_column(x, z)
        with self.lock:
            self.ensure_columns(scene, cx, cz, cx, cz)
            col = self.subs[scene].setdefault((cx, cz), {})
            if mat == 0:
                col.pop((x, y, z, s), None)
            else:
                col[(x, y, z, s)] = mat
            self.dirty_subs.add((scene, cx, cz))
            self._bump(scene, cx, cz)

    def column_subs(self, scene, cx, cz):
        """[[x, y, z, s, mat], ...] for one column."""
        with self.lock:
            self.ensure_columns(scene, cx, cz, cx, cz)
            return [[x, y, z, s, m] for (x, y, z, s), m in
                    self.subs[scene].get((cx, cz), {}).items()]

    # ---- change tracking ----
    def _bump(self, scene, cx, cz):
        key = (scene, cx, cz)
        self.versions[key] = self.versions.get(key, 0) + 1

    def version(self, scene, cx, cz):
        with self.lock:
            return self.versions.get((scene, cx, cz), 0)

    # ---- metadata (worlds, clock, screens) ----
    def load_meta(self):
        with self.db_lock:
            rows = self.conn.execute("SELECT key, value FROM kv").fetchall()
        return {k: json.loads(v) for k, v in rows}

    def mark_meta_dirty(self):
        with self.lock:
            self.meta_dirty = True

    def has_data(self):
        with self.db_lock:
            for table in ("kv", "sections", "subvoxels"):
                if self.conn.execute(
                        f"SELECT 1 FROM {table} LIMIT 1").fetchone():
                    return True
        return False

    # ---- persistence ----
    def flush(self):
        with self.lock:
            sections = []
            for scene, cx, cz, sy in self.dirty_sections:
                sec = self.overlays.get(scene, {}).get((cx, cz), {}).get(sy)
                if sec is None:
                    continue
                if sec == self.empty_overlay:
                    sections.append((scene, cx, cz, sy, None))
                else:
                    sections.append(
                        (scene, cx, cz, sy, _to_le_bytes(sec)))
            subs = []
            for scene, cx, cz in self.dirty_subs:
                col = self.subs.get(scene, {}).get((cx, cz), {})
                packed = b"".join(SUB_RECORD.pack(x, y, z, s, m)
                                  for (x, y, z, s), m in col.items())
                subs.append((scene, cx, cz, packed))
            self.dirty_sections.clear()
            self.dirty_subs.clear()
            meta = None
            if self.meta_dirty and self.meta_provider:
                self.meta_dirty = False
                meta = self.meta_provider()
        if not sections and not subs and meta is None:
            return
        # Compression and disk I/O happen outside self.lock so request
        # threads aren't held up by the flush.
        with self.db_lock:
            cur = self.conn.cursor()
            for scene, cx, cz, sy, raw in sections:
                if raw is None:
                    cur.execute("DELETE FROM sections WHERE scene=? AND cx=? "
                                "AND cz=? AND sy=?", (scene, cx, cz, sy))
                else:
                    cur.execute(
                        "INSERT OR REPLACE INTO sections VALUES (?,?,?,?,?)",
                        (scene, cx, cz, sy, zlib.compress(raw, 6)))
            for scene, cx, cz, packed in subs:
                if not packed:
                    cur.execute("DELETE FROM subvoxels WHERE scene=? AND "
                                "cx=? AND cz=?", (scene, cx, cz))
                else:
                    cur.execute(
                        "INSERT OR REPLACE INTO subvoxels VALUES (?,?,?,?)",
                        (scene, cx, cz, zlib.compress(packed, 6)))
            if meta is not None:
                for key, value in meta.items():
                    cur.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)",
                                (key, json.dumps(value)))
            self.conn.commit()

    def _flush_loop(self, interval):
        while not self._stop.wait(interval):
            try:
                self.flush()
            except Exception as err:  # keep flushing on later ticks
                print(f"warning: world flush failed: {err}")

    def close(self):
        self._stop.set()
        self.flush()
        with self.db_lock:
            self.conn.close()
