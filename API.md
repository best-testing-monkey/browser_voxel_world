# Backend API

The Python backend owns the world. Everything the browser shows can also be
driven programmatically over plain HTTP + JSON — place and remove voxels,
draw on screens, and react to sensor events.

Base URL: `http://127.0.0.1:8000` (or wherever `server.py` runs).

## World

### `GET /api/config`
Materials catalog (1032 entries: id, name, category, color, plus optional
`action` / `flammable` / `emissive` (light level 1–15, colour taken from
the material colour) / `translucent` (passes and tints light) flags),
scenes with spawn points and POIs, voxel size chain
(`[1000, 500, 100, 50, 10]` mm), and the fluid rule table.

### `GET /api/chunk?scene=S&cx=N&cz=N`
One 16×1024×16 chunk: `voxels` is a base64 little-endian uint16 array of
material ids (0 = air) for the 1000 mm base grid, `subvoxels` is a list of
`[x_mm, y_mm, z_mm, size_mm, material_id]` smaller voxels.

### `POST /api/edits` — place and remove voxels
```json
{"scene": "granite_hills", "edits": [
  {"op": "set", "x": 10, "y": 35, "z": 10, "id": 90},
  {"op": "sub", "x": 10500, "y": 35500, "z": 10250, "s": 250, "id": 2},
  {"op": "set", "x": 10, "y": 36, "z": 10, "id": 0}
]}
```
- `op:"set"`: a full 1000 mm voxel on the base grid (coordinates in blocks).
  `id: 0` removes.
- `op:"sub"`: a smaller voxel; coordinates and size in integer millimetres,
  aligned to the size (`x % s == 0`), size one of 500/100/50/10.
- Edits persist to `world_state.json` and are pushed to connected browsers
  within ~2 s (they poll `GET /api/updates`).

### `GET /api/updates?scene=S&since=REV`
Everything that changed after revision `REV`: world edits (same op format),
current screen versions, and the latest event sequence number. Poll this to
mirror world state. A completed schematic import (see below) shows up as a
single `{"op": "bulk", "bbox": [...]}` entry rather than one edit per cell.

## Schematic import

Load a Minecraft `.schem` (Sponge/WorldEdit, versions 1–3) or legacy
`.schematic` (MCEdit) file and paste it into the world, centered on a
target block. Decompression, NBT parsing, block-name resolution, and
placement all run server-side (`schematic_import.py`) as a background job,
since a large structure can take a while to process — upload the file,
then poll for progress.

### `POST /api/schematic/import?scene=S&tx=&ty=&tz=&nx=&ny=&nz=`
Body: the raw file bytes (gzip-, zlib-compressed, or raw NBT — whatever the
file is on disk), up to 64 MiB.

- `tx,ty,tz`: the target block (integers, base grid) — the schematic is
  centered on this cell in all three axes.
- `nx,ny,nz`: the outward face normal at the target (e.g. `0,1,0` for a
  floor hit) — determines the 90°-increment rotation (a floor/ceiling hit
  keeps the structure unrotated).

Response: `{"jobId": "..."}` immediately; parsing/placing continues in a
background thread.

### `GET /api/schematic/status?jobId=ID`
```json
{"status": "running", "processed": 128000, "total": 216000,
 "result": null, "error": null}
```
`status` is `"running"`, `"done"`, or `"error"`. When `"done"`, `result` is
`{"cells": N, "unmapped": [...], "bbox": [x0, y0, z0, x1, y1, z1]}` —
`unmapped` lists block names/legacy ids with no catalog equivalent (they
fell back to Stone); `bbox` is the half-open world-space region touched.
When `"error"`, `error` explains why (e.g. exceeding the 512-per-axis
dimension cap, or an unrecognized file format).

Placement is written directly into the scene's edit store — same effect as
many `POST /api/edits` calls, including replacing existing voxels with air
where the schematic has air — and persists to `world_state.json` like any
other edit.

## Worlds

Beyond the three built-in scenes (Granite Hills, Material Museum, Glass
Cathedral — read-only, can't be renamed or deleted), you can create your own
worlds from three generator types.

### `GET /api/worlds`
```json
{"worlds": [
  {"id": "granite_hills", "title": "Granite Hills", "type": null,
   "builtin": true, "spawn": [8.5, 33.0, 8.5], "params": {}},
  {"id": "my_flat_world", "title": "My Flat World", "type": "flat",
   "builtin": false, "spawn": [8.5, 6.0, 8.5],
   "params": {"material": 90, "height": 4}}
]}
```
`id` is the stable scene name used everywhere else (`scene=` on
`/api/chunk`, `/api/edits`, `/api/updates`, ...) — renaming a world never
changes it.

### `POST /api/worlds` — create / rename / delete
Create:
```json
{"action": "create", "title": "My Flat World", "type": "flat",
 "params": {"material": "Grass Block", "height": 4}}
```
- `type: "flat"` — `params: {material, height}` (height in blocks, default
  4): every chunk is `height` layers of `material` over air.
- `type: "perlin"` — `params: {material, seed, amplitude}`: rolling hills
  of `material`, generalizing Granite Hills' generator.
- `type: "single_block"` — `params: {material}`: exactly one voxel at a
  fixed origin in an otherwise empty void; you spawn standing on it.

`material` must be a material name string (validated against the catalog —
unknown/missing names 400); the server resolves and stores it as an id, as
shown in the `GET /api/worlds` example above. The server slugifies `title`
into a unique `id`
(lowercase, non-alphanumeric → `_`, collisions get a numeric suffix).
Response: `{"ok": true, "world": {...}}` (same shape as a `GET /api/worlds`
entry).

Rename:
```json
{"action": "rename", "id": "my_flat_world", "title": "New Title"}
```
Only `title` changes — chunk/edit storage keeps using `id`.

Delete:
```json
{"action": "delete", "id": "my_flat_world"}
```
Drops the world's edits and chunk cache. Any client still viewing a
deleted world falls back to the default scene on its next poll.

All three actions return **400** if `id` refers to a built-in scene or an
unknown id.

## Screens

Screens are panels of Screen voxels the backend draws on. Content types:
`markdown` and `svg`.

### `GET /api/screens?scene=S`
All screens with geometry, content and a version counter.

### `POST /api/screens`
```json
{"scene": "granite_hills", "action": "update", "id": "board",
 "content": {"type": "markdown", "data": "# Hello\nfrom *Python*"}}
```
Actions:
- `update` — replace a screen's content (markdown or svg, ≤ 200 kB).
- `create` — new screen:
  `{"action": "create", "id": "info2", "origin": [x, y, z],
    "facing": "+z", "w": 6, "h": 4, "content": {...}}`
  (facing one of `+z -z +x -x`, size up to 24×24 blocks). The panel's
  voxels are placed for you.
- `delete` — remove the screen and its panel voxels.

Browsers re-render a screen whenever its version changes.

## Sensor events (buttons)

Actionable materials generate events: `touch` (right-click), `light`
(a player's view ray rests on it), `pressure` (a player is above it).
Each event has `state: "on" | "off"`.

### `GET /api/events?since=SEQ[&scene=S]`
Poll for events. Returns `{"events": [{seq, scene, action, x, y, z, state,
ts}], "seq": latest}`.

### `POST /api/subscribe`
```json
{"url": "http://localhost:9000/hook"}
```
Webhook push: the backend POSTs `{"event": {...}}` to your URL for every
event. Subscribers are dropped after 5 consecutive delivery failures.

### Server-side hook
`handle_game_event(scene, action, x, y, z, on)` in `server.py` runs for
every event in-process — the demo uses it to rewrite the Sensor Board
screen and toggle indicator blocks. Edit it to build your own logic.

## World clock (day/night)

The backend owns the apparent time of day. Clients render the sun, moon,
stars and sky colours from it. The default clock runs at **4× realtime**
(one full day every 6 hours).

### `GET /api/time`
`{"apparentHours": 14.53, "speed": 4.0}` — hours are 0–24.

### `POST /api/time` — set apparent time and/or clock speed
```json
{"time": "18:30", "speed": 60}
```
`time` accepts decimal hours (`18.5`) or `"HH:MM"`; `speed` is the
multiplier over realtime (0 freezes the sky, up to 86400 = one day per
second). Both fields are optional. The clock persists across restarts and
is echoed in every `GET /api/updates` response, so browsers resync within
~2 s.

## Fluids

Fluid behaviour is configured by the backend (`fluids` in `/api/config`)
and simulated in the browser as 5 cm cells: faucet material ids, colors,
what lava+water freezes into, which "hot" materials water cools, and the
burn chance for flammables. Fluid *effects* (obsidian, burned wood, cooled
magma) come back through `POST /api/edits` and persist.

Fluid presence is unbounded — cells are never despawned to make room.
`maxCellsPerType` is a per-tick movement budget: when more cells are in
motion than the budget, a rotating window of that many cells is stepped
each tick, so heavy flows slow down instead of losing volume. Cells that
stop moving for `settleAfterTicks` ticks are promoted to a settled tier:
excluded from simulation and from the movement budget, re-rendered only
on change, and woken when the world changes around them.

## Example: Python client

```python
import json, urllib.request

BASE = "http://127.0.0.1:8000"

def post(path, payload):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))

def get(path):
    return json.load(urllib.request.urlopen(BASE + path))

# build a small gold tower
gold = next(m["id"] for m in get("/api/config")["materials"]
            if m["name"] == "Gold Block")
post("/api/edits", {"scene": "granite_hills", "edits": [
    {"op": "set", "x": 0, "y": 35 + i, "z": 0, "id": gold} for i in range(5)
]})

# write to the sensor board
post("/api/screens", {"scene": "granite_hills", "action": "update",
                      "id": "board",
                      "content": {"type": "markdown",
                                  "data": "# Tower built\nby a script"}})

# react to button presses
seq = 0
while True:
    data = get(f"/api/events?since={seq}")
    for ev in data["events"]:
        print("sensor:", ev["action"], ev["state"], "at",
              (ev["x"], ev["y"], ev["z"]))
    seq = data["seq"]
```
