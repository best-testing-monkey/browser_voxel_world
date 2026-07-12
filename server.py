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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from materials import MATERIALS
from worldgen import build_scenes, DEFAULT_SCENE, CHUNK_X, CHUNK_Y, CHUNK_Z

STATIC_DIR = Path(__file__).parent / "static"

SCENES = build_scenes(len(MATERIALS))

# In-memory edit store: {scene: {(x, y, z): material_id}}. Edits are applied on
# top of generated chunks, so a reloaded page sees the same modified world.
EDITS = {name: {} for name in SCENES}
EDITS_LOCK = threading.Lock()

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
        return self.handle_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/edits":
            return self.handle_edits()
        self.send_error_json("not found", 404)

    # ---- API handlers ----
    def handle_config(self):
        self.send_json({
            "materials": MATERIALS,
            "scenes": [s.meta() for s in SCENES.values()],
            "defaultScene": DEFAULT_SCENE,
            "chunkSize": [CHUNK_X, CHUNK_Y, CHUNK_Z],
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
        self.send_json({
            "scene": scene,
            "cx": cx,
            "cz": cz,
            "size": [CHUNK_X, CHUNK_Y, CHUNK_Z],
            "encoding": "base64-uint16-le",
            "voxels": base64.b64encode(packed).decode("ascii"),
        })

    def handle_edits(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
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
            for e in edits[:4096]:
                try:
                    x, y, z = int(e["x"]), int(e["y"]), int(e["z"])
                    mat = int(e["id"])
                except (KeyError, TypeError, ValueError):
                    continue
                if not (0 <= y < CHUNK_Y and 0 <= mat <= max_id):
                    continue
                store[(x, y, z)] = mat
                applied += 1
        self.send_json({"ok": True, "applied": applied})

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

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Voxel world backend: http://{args.host}:{args.port}")
    print(f"  materials: {len(MATERIALS)}   scenes: {', '.join(SCENES)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
