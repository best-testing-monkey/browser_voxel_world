#!/usr/bin/env python3
"""Python backend for the browser voxel world.

Serves the Three.js frontend from ./static and dictates scene contents via a
small JSON API. Run with:  python3 server.py [--port 8000]

API:
  GET  /api/config                     -> materials, scenes, chunk size, default scene
  GET  /api/chunk?scene=S&cx=N&cz=N    -> one chunk of voxel data (base64 uint16 LE)
  POST /api/edits                      -> persist block edits {scene, edits:[{x,y,z,id}]}
"""

import argparse
import base64
import json
import struct
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from materials import MATERIALS, NAME_TO_ID
from worldgen import (build_scenes, DEFAULT_SCENE, CHUNK_X, CHUNK_Y, CHUNK_Z,
                      VOXEL_SIZE_MM, MIN_VOXEL_SIZE_MM, VOXEL_SIZES_MM)

STATIC_DIR = Path(__file__).parent / "static"
STATE_FILE = Path(__file__).parent / "world_state.json"

SCENES = build_scenes(len(MATERIALS))

# Edit stores, applied on top of generated chunks and persisted to
# STATE_FILE so world changes survive server restarts.
#   EDITS:     {scene: {(x, y, z): material_id}}          base 1000 mm grid
#   SUBVOXELS: {scene: {(x_mm, y_mm, z_mm, size_mm): id}}  smaller voxels
EDITS = {name: {} for name in SCENES}
SUBVOXELS = {name: {} for name in SCENES}
EDITS_LOCK = threading.Lock()

SUB_SIZES = [s for s in VOXEL_SIZES_MM if s < VOXEL_SIZE_MM]

# Revision log so clients can pick up changes the backend (or another
# client) makes at runtime: every applied edit gets a revision number and
# GET /api/updates?since=N returns the ops after N.
REV = {name: 0 for name in SCENES}
EDIT_LOG = {name: [] for name in SCENES}
EDIT_LOG_MAX = 4000

# Sensor event bookkeeping for the demo installation (see handle_game_event)
SENSOR_COUNTS = {name: {"touch": 0, "light": 0, "pressure": 0}
                 for name in SCENES}
SENSOR_LOG = {name: [] for name in SCENES}

ACTIONS = ("touch", "light", "pressure")
MATERIAL_ACTION = {m["id"]: m.get("action") for m in MATERIALS
                   if m.get("action")}

# Event stream for external subscribers: every sensor event gets a global
# sequence number; poll GET /api/events?since=N or register a webhook with
# POST /api/subscribe.
EVENT_SEQ = 0
EVENTS_LOG = []
EVENTS_LOG_MAX = 500
SUBSCRIBERS = []  # [{"url": str, "failures": int}]
EVENTS_LOCK = threading.Lock()

# Fluid behaviour is dictated by the backend and executed by the client
# simulation (5 cm cells). All ids resolved here so the client stays generic.
FLUID_CONFIG = {
    "cellMm": 50,
    "faucets": {
        NAME_TO_ID["Sand Faucet"]: "sand",
        NAME_TO_ID["Water Faucet"]: "water",
        NAME_TO_ID["Lava Faucet"]: "lava",
    },
    "colors": {"sand": "#d7cd9d", "water": "#3f61d0", "lava": "#e2661e"},
    # lava + water contact: the lava cell freezes into this material
    "lavaWaterContact": NAME_TO_ID["Obsidian"],
    # water cools "hot" blocks: {hot material id: cooled material id}
    "coolsTo": {
        NAME_TO_ID["Magma Block"]: NAME_TO_ID["Coal Block"],
        NAME_TO_ID["Lava"]: NAME_TO_ID["Obsidian"],
    },
    "burnChance": 0.15,          # per tick per lava contact with flammables
    "emitEveryTicks": 2,
    "maxCellsPerType": 1200,
    "tickMs": 100,
}


def log_event(scene, action, x, y, z, on):
    global EVENT_SEQ
    with EVENTS_LOCK:
        EVENT_SEQ += 1
        ev = {"seq": EVENT_SEQ, "scene": scene, "action": action,
              "x": x, "y": y, "z": z, "state": "on" if on else "off",
              "ts": round(time.time(), 3)}
        EVENTS_LOG.append(ev)
        del EVENTS_LOG[:-EVENTS_LOG_MAX]
        subs = list(SUBSCRIBERS)
    if subs:
        threading.Thread(target=_notify_subscribers, args=(ev, subs),
                         daemon=True).start()
    return ev


def _notify_subscribers(ev, subs):
    body = json.dumps({"event": ev}).encode("utf-8")
    for sub in subs:
        try:
            req = urllib.request.Request(
                sub["url"], data=body,
                headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=3)
            sub["failures"] = 0
        except Exception:
            sub["failures"] += 1
            if sub["failures"] >= 5:
                with EVENTS_LOCK:
                    if sub in SUBSCRIBERS:
                        SUBSCRIBERS.remove(sub)


def record_edit(scene, op):
    """Caller must hold EDITS_LOCK. Applies nothing — just logs for sync."""
    REV[scene] += 1
    log = EDIT_LOG[scene]
    log.append({"rev": REV[scene], **op})
    if len(log) > EDIT_LOG_MAX:
        del log[:len(log) - EDIT_LOG_MAX]


def backend_set_block(scene, x, y, z, mat):
    """World edit made by the backend itself (event reactions etc.)."""
    with EDITS_LOCK:
        EDITS[scene][(x, y, z)] = mat
        record_edit(scene, {"op": "set", "x": x, "y": y, "z": z, "id": mat})


def load_state():
    if not STATE_FILE.is_file():
        return
    try:
        data = json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError) as err:
        print(f"warning: could not load {STATE_FILE.name}: {err}")
        return
    for scene, stores in data.get("scenes", {}).items():
        if scene not in SCENES:
            continue
        EDITS[scene] = {
            (int(x), int(y), int(z)): int(m)
            for x, y, z, m in stores.get("base", [])}
        SUBVOXELS[scene] = {
            (int(x), int(y), int(z), int(s)): int(m)
            for x, y, z, s, m in stores.get("sub", [])}
        for saved in stores.get("screens", []):
            sc = SCENES[scene]
            if saved["id"] in sc.screens:
                # Scene-defined screen: restore its (possibly updated) content
                sc.screens[saved["id"]]["content"] = saved["content"]
                sc.screens[saved["id"]]["version"] = saved["version"]
            elif saved.get("runtime"):
                # Screen created at runtime through the API
                sc.add_screen(saved["id"], saved["origin"], saved["facing"],
                              saved["w"], saved["h"],
                              saved["content"]["type"],
                              saved["content"]["data"])
                sc.screens[saved["id"]]["version"] = saved["version"]
                sc.screens[saved["id"]]["runtime"] = True


def save_state():
    with EDITS_LOCK:
        data = {"scenes": {name: {
            "base": [[x, y, z, m] for (x, y, z), m in EDITS[name].items()],
            "sub": [[x, y, z, s, m]
                    for (x, y, z, s), m in SUBVOXELS[name].items()],
            "screens": list(SCENES[name].screens.values()),
        } for name in SCENES}}
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(STATE_FILE)

CHUNK_CACHE = {}
CHUNK_CACHE_LOCK = threading.Lock()

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def get_chunk_voxels(scene_name, cx, cz):
    key = (scene_name, cx, cz)
    with CHUNK_CACHE_LOCK:
        cached = CHUNK_CACHE.get(key)
    if cached is None:
        cached = SCENES[scene_name].generate_chunk(cx, cz)
        with CHUNK_CACHE_LOCK:
            CHUNK_CACHE[key] = cached
    voxels = list(cached)

    layer = CHUNK_X * CHUNK_Z
    # Backend fixtures (screens, sensors) sit on top of generated terrain
    # but under player edits, so players can still remove them.
    for (x, y, z), mat in SCENES[scene_name].fixtures.items():
        if (cx * CHUNK_X <= x < (cx + 1) * CHUNK_X
                and cz * CHUNK_Z <= z < (cz + 1) * CHUNK_Z
                and 0 <= y < CHUNK_Y):
            lx = x - cx * CHUNK_X
            lz = z - cz * CHUNK_Z
            voxels[lx + lz * CHUNK_X + y * layer] = mat
    with EDITS_LOCK:
        scene_edits = EDITS[scene_name]
        for (x, y, z), mat in scene_edits.items():
            if (cx * CHUNK_X <= x < (cx + 1) * CHUNK_X
                    and cz * CHUNK_Z <= z < (cz + 1) * CHUNK_Z
                    and 0 <= y < CHUNK_Y):
                lx = x - cx * CHUNK_X
                lz = z - cz * CHUNK_Z
                voxels[lx + lz * CHUNK_X + y * layer] = mat
    return voxels


def handle_game_event(scene_name, action, x, y, z, on):
    """Backend reaction to actionable materials — this is the hook to
    customise. The demo: keeps counters, rewrites the markdown sensor
    board, and toggles indicator blocks above the sensors."""
    scene = SCENES[scene_name]
    counts = SENSOR_COUNTS[scene_name]
    if on:
        counts[action] += 1
    log = SENSOR_LOG[scene_name]
    log.append(f"`{action}` {'on' if on else 'off'} at ({x}, {y}, {z})")
    del log[:-6]

    # Indicator blocks: glowstone flash above the touch sensor, sea lantern
    # while lit, gold marker while the pressure plate is held.
    indicator = {
        "touch": NAME_TO_ID["Glowstone"],
        "light": NAME_TO_ID["Sea Lantern"],
        "pressure": NAME_TO_ID["Gold Block"],
    }[action]
    if action == "touch":
        # Toggle on each touch
        with EDITS_LOCK:
            current = EDITS[scene_name].get((x, y + 2, z), 0)
        backend_set_block(scene_name, x, y + 2, z, 0 if current else indicator)
    else:
        backend_set_block(scene_name, x, y + 2, z, indicator if on else 0)

    if "board" in scene.screens:
        lines = "\n".join(f"- {entry}" for entry in log) or "- (none yet)"
        scene.set_screen_content("board", "markdown", f"""# Sensor Board

Rendered from **Markdown** by the *Python backend* — it rewrites this
screen every time a sensor fires.

Touches: **{counts['touch']}** · Light: **{counts['light']}** · \
Pressure: **{counts['pressure']}**

Recent events:
{lines}
""")
    save_state()


class Handler(BaseHTTPRequestHandler):
    server_version = "VoxelWorld/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        pass

    # ---- helpers ----
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        self.send_json({"error": message}, status=status)

    # ---- routing ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/config":
            return self.handle_config()
        if path == "/api/chunk":
            return self.handle_chunk(parse_qs(parsed.query))
        if path == "/api/screens":
            return self.handle_screens_get(parse_qs(parsed.query))
        if path == "/api/updates":
            return self.handle_updates(parse_qs(parsed.query))
        if path == "/api/events":
            return self.handle_events_get(parse_qs(parsed.query))
        return self.handle_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/edits":
            return self.handle_edits()
        if parsed.path == "/api/events":
            return self.handle_events()
        if parsed.path == "/api/screens":
            return self.handle_screens_post()
        if parsed.path == "/api/subscribe":
            return self.handle_subscribe()
        self.send_error_json("not found", 404)

    def read_body_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(min(length, 1 << 20)) or b"{}")

    # ---- API handlers ----
    def handle_config(self):
        self.send_json({
            "materials": MATERIALS,
            "scenes": [s.meta() for s in SCENES.values()],
            "defaultScene": DEFAULT_SCENE,
            "chunkSize": [CHUNK_X, CHUNK_Y, CHUNK_Z],
            "voxelSizesMm": VOXEL_SIZES_MM,
            "defaultVoxelSizeMm": VOXEL_SIZE_MM,
            "minVoxelSizeMm": MIN_VOXEL_SIZE_MM,
            "fluids": FLUID_CONFIG,
        })

    def handle_chunk(self, query):
        scene = query.get("scene", [DEFAULT_SCENE])[0]
        if scene not in SCENES:
            return self.send_error_json(f"unknown scene {scene!r}", 404)
        try:
            cx = int(query.get("cx", ["0"])[0])
            cz = int(query.get("cz", ["0"])[0])
        except ValueError:
            return self.send_error_json("cx/cz must be integers")
        if abs(cx) > 4096 or abs(cz) > 4096:
            return self.send_error_json("chunk out of range")

        voxels = get_chunk_voxels(scene, cx, cz)
        packed = struct.pack(f"<{len(voxels)}H", *voxels)

        x0, x1 = cx * CHUNK_X * 1000, (cx + 1) * CHUNK_X * 1000
        z0, z1 = cz * CHUNK_Z * 1000, (cz + 1) * CHUNK_Z * 1000
        with EDITS_LOCK:
            subs = [[x, y, z, s, m]
                    for (x, y, z, s), m in SUBVOXELS[scene].items()
                    if x0 <= x < x1 and z0 <= z < z1]

        self.send_json({
            "scene": scene,
            "cx": cx,
            "cz": cz,
            "size": [CHUNK_X, CHUNK_Y, CHUNK_Z],
            "encoding": "base64-uint16-le",
            "voxels": base64.b64encode(packed).decode("ascii"),
            "subvoxels": subs,  # [x_mm, y_mm, z_mm, size_mm, material_id]
        })

    def handle_edits(self):
        try:
            payload = self.read_body_json()
            scene = payload["scene"]
            edits = payload["edits"]
        except (ValueError, KeyError, json.JSONDecodeError):
            return self.send_error_json("bad edit payload")
        if scene not in SCENES:
            return self.send_error_json(f"unknown scene {scene!r}", 404)

        applied = 0
        max_id = len(MATERIALS)
        with EDITS_LOCK:
            store = EDITS[scene]
            substore = SUBVOXELS[scene]
            for e in edits[:8192]:
                try:
                    op = e.get("op", "set")
                    mat = int(e["id"])
                    if not 0 <= mat <= max_id:
                        continue
                    if op == "set":
                        # Full default-size (1000 mm) voxel on the base grid.
                        x, y, z = int(e["x"]), int(e["y"]), int(e["z"])
                        if not 0 <= y < CHUNK_Y:
                            continue
                        store[(x, y, z)] = mat
                        record_edit(scene,
                                    {"op": "set", "x": x, "y": y, "z": z,
                                     "id": mat})
                        applied += 1
                    elif op == "sub":
                        # Smaller voxel; coordinates and size in integer mm.
                        x, y, z = int(e["x"]), int(e["y"]), int(e["z"])
                        s = int(e["s"])
                        if s not in SUB_SIZES:
                            continue
                        if x % s or y % s or z % s:
                            continue
                        if not 0 <= y < CHUNK_Y * 1000:
                            continue
                        key = (x, y, z, s)
                        if mat == 0:
                            substore.pop(key, None)
                        else:
                            substore[key] = mat
                        record_edit(scene,
                                    {"op": "sub", "x": x, "y": y, "z": z,
                                     "s": s, "id": mat})
                        applied += 1
                except (KeyError, TypeError, ValueError, AttributeError):
                    continue
        if applied:
            save_state()
        self.send_json({"ok": True, "applied": applied})

    # ---- screens ----
    def handle_screens_get(self, query):
        scene = query.get("scene", [DEFAULT_SCENE])[0]
        if scene not in SCENES:
            return self.send_error_json(f"unknown scene {scene!r}", 404)
        self.send_json({"screens": list(SCENES[scene].screens.values())})

    def handle_screens_post(self):
        try:
            payload = self.read_body_json()
            scene_name = payload["scene"]
            action = payload.get("action", "update")
        except (ValueError, KeyError, json.JSONDecodeError):
            return self.send_error_json("bad screen payload")
        scene = SCENES.get(scene_name)
        if scene is None:
            return self.send_error_json(f"unknown scene {scene_name!r}", 404)

        if action == "update":
            sid = payload.get("id")
            content = payload.get("content") or {}
            ctype, data = content.get("type"), content.get("data", "")
            if sid not in scene.screens:
                return self.send_error_json(f"unknown screen {sid!r}", 404)
            if ctype not in ("markdown", "svg") or not isinstance(data, str) \
                    or len(data) > 200_000:
                return self.send_error_json("content must be markdown/svg")
            scene.set_screen_content(sid, ctype, data)
            save_state()
            return self.send_json(
                {"ok": True, "version": scene.screens[sid]["version"]})

        if action == "create":
            sid = str(payload.get("id", ""))[:64]
            try:
                origin = [int(v) for v in payload["origin"]]
                facing = payload["facing"]
                w, h = int(payload["w"]), int(payload["h"])
                content = payload.get("content") or {
                    "type": "markdown", "data": f"# {sid}"}
            except (KeyError, TypeError, ValueError):
                return self.send_error_json("bad screen geometry")
            if not sid or sid in scene.screens:
                return self.send_error_json("id missing or already exists")
            if facing not in ("+z", "-z", "+x", "-x") or \
                    not (1 <= w <= 24 and 1 <= h <= 24):
                return self.send_error_json("bad facing or size")
            if content.get("type") not in ("markdown", "svg"):
                return self.send_error_json("content must be markdown/svg")
            scene.add_screen(sid, origin, facing, w, h,
                             content["type"], str(content.get("data", "")))
            scene.screens[sid]["runtime"] = True
            # Write the panel voxels as edits so live clients pick them up.
            for (x, y, z), mat in scene.fixtures.items():
                if scene.screens[sid] and self._screen_owns_cell(
                        scene.screens[sid], x, y, z):
                    backend_set_block(scene_name, x, y, z, mat)
            save_state()
            return self.send_json({"ok": True, "screen": scene.screens[sid]})

        if action == "delete":
            sid = payload.get("id")
            screen = scene.screens.pop(sid, None)
            if screen is None:
                return self.send_error_json(f"unknown screen {sid!r}", 404)
            for x, y, z in self._screen_cells(screen):
                scene.fixtures.pop((x, y, z), None)
                backend_set_block(scene_name, x, y, z, 0)
            save_state()
            return self.send_json({"ok": True})

        return self.send_error_json(f"unknown action {action!r}")

    @staticmethod
    def _screen_cells(screen):
        x0, y0, z0 = screen["origin"]
        for i in range(screen["w"]):
            for j in range(screen["h"]):
                if screen["facing"] in ("+z", "-z"):
                    yield x0 + i, y0 + j, z0
                else:
                    yield x0, y0 + j, z0 + i

    def _screen_owns_cell(self, screen, x, y, z):
        return (x, y, z) in set(self._screen_cells(screen))

    # ---- events from actionable materials ----
    def handle_events(self):
        try:
            payload = self.read_body_json()
            scene = payload["scene"]
            events = payload["events"]
        except (ValueError, KeyError, json.JSONDecodeError):
            return self.send_error_json("bad events payload")
        if scene not in SCENES:
            return self.send_error_json(f"unknown scene {scene!r}", 404)
        accepted = []
        for e in events[:64]:
            try:
                action = e["action"]
                x, y, z = int(e["x"]), int(e["y"]), int(e["z"])
                on = e.get("state", "on") == "on"
            except (KeyError, TypeError, ValueError):
                continue
            if action not in ACTIONS:
                continue
            ev = log_event(scene, action, x, y, z, on)
            handle_game_event(scene, action, x, y, z, on)
            accepted.append(ev["seq"])
        self.send_json({"ok": True, "accepted": accepted})

    def handle_events_get(self, query):
        try:
            since = int(query.get("since", ["0"])[0])
        except ValueError:
            since = 0
        scene = query.get("scene", [None])[0]
        with EVENTS_LOCK:
            events = [e for e in EVENTS_LOG
                      if e["seq"] > since and
                      (scene is None or e["scene"] == scene)][:200]
            seq = EVENT_SEQ
        self.send_json({"events": events, "seq": seq})

    def handle_subscribe(self):
        try:
            payload = self.read_body_json()
            url = payload["url"]
        except (ValueError, KeyError, json.JSONDecodeError):
            return self.send_error_json("bad subscribe payload")
        if not isinstance(url, str) or not url.startswith(("http://",
                                                           "https://")):
            return self.send_error_json("url must be http(s)")
        with EVENTS_LOCK:
            if not any(s["url"] == url for s in SUBSCRIBERS):
                SUBSCRIBERS.append({"url": url, "failures": 0})
        self.send_json({"ok": True, "subscribers": len(SUBSCRIBERS)})

    # ---- sync: world + screen changes since a revision ----
    def handle_updates(self, query):
        scene = query.get("scene", [DEFAULT_SCENE])[0]
        if scene not in SCENES:
            return self.send_error_json(f"unknown scene {scene!r}", 404)
        since_raw = query.get("since", [None])[0]
        with EDITS_LOCK:
            rev = REV[scene]
            edits = None
            if since_raw is not None:
                try:
                    since = int(since_raw)
                except ValueError:
                    since = rev
                edits = [e for e in EDIT_LOG[scene] if e["rev"] > since][:500]
        with EVENTS_LOCK:
            seq = EVENT_SEQ
        out = {
            "rev": rev,
            "screens": {sid: s["version"]
                        for sid, s in SCENES[scene].screens.items()},
            "eventSeq": seq,
        }
        if edits is not None:
            out["edits"] = edits
        self.send_json(out)

    # ---- static files ----
    def handle_static(self, path):
        if path == "/":
            path = "/index.html"
        candidate = (STATIC_DIR / path.lstrip("/")).resolve()
        if not str(candidate).startswith(str(STATIC_DIR.resolve())) \
                or not candidate.is_file():
            return self.send_error_json("not found", 404)
        body = candidate.read_bytes()
        self.send_response(200)
        ctype = MIME_TYPES.get(candidate.suffix, "application/octet-stream")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser(description="Voxel world backend")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    load_state()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Voxel world backend: http://{args.host}:{args.port}")
    print(f"  materials: {len(MATERIALS)}   scenes: {', '.join(SCENES)}")
    print(f"  world state file: {STATE_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
