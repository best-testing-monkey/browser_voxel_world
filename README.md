# Browser Voxel World

A browser 3D voxel world demo: a **Three.js** frontend driven by a **Python
backend** that dictates the contents of every scene. No dependencies to
install — the backend is pure Python standard library and Three.js is
vendored into the repo.

![stack](https://img.shields.io/badge/frontend-Three.js%20r160-blue)
![stack](https://img.shields.io/badge/backend-Python%203%20stdlib-green)

## Run it

```bash
python3 server.py            # defaults to http://127.0.0.1:8000
# or: python3 server.py --port 9000 --host 0.0.0.0
```

Open http://127.0.0.1:8000 in a browser, pick a scene, and click **Play**.

## Features

- **WASD** movement, **mouse look** (pointer lock), Space/Shift to fly
  up/down, hold F to sprint.
- **Create / Destroy / Store blocks**: left click mines the targeted voxel
  and stores it in your inventory (press **Q** to view), right click places
  a block from the active hotbar slot (stored blocks are consumed first,
  then supply is creative/infinite), middle click picks the targeted
  material into the hotbar.
- **1024+ materials** (press **E** for the searchable browser): the
  Minecraft block palette (including all 16-color dyed families), modern
  building & construction materials, crafting materials, the full periodic
  table of 118 elements, rocks & gemstones, wood species, metals & alloys,
  textiles, plastics, historical building materials, stone finishes and
  paint swatches.
- **Backend-dictated scenes** — the browser only asks for chunks and renders
  what Python sends:
  - **Granite Hills** (default): rolling Perlin-noise hills made entirely of
    granite. The Perlin noise is generated server-side in pure Python.
  - **Material Museum**: every one of the 1024 materials on a pillar.
  - **Glass Cathedral**: interfering sine ridges of stained glass and gold.
- **Persistent edits**: block changes are POSTed back to the backend and
  re-applied when chunks reload, so a page refresh keeps your edits (for the
  lifetime of the server process).

## Architecture

```
┌────────────────────────┐   GET /api/config     ┌──────────────────────────┐
│ Browser (Three.js)     │ ───────────────────▶  │ Python backend           │
│  static/js/main.js     │   materials + scenes  │  server.py   (stdlib)    │
│                        │                       │  materials.py (1024+)    │
│  - chunk meshing       │   GET /api/chunk      │  worldgen.py  (Perlin)   │
│  - pointer lock + WASD │ ───────────────────▶  │                          │
│  - voxel raycasting    │   uint16 voxels (b64) │  scenes generate chunks  │
│  - hotbar/inventory UI │                       │  16 × 64 × 16            │
│                        │   POST /api/edits     │                          │
│                        │ ───────────────────▶  │  in-memory edit store    │
└────────────────────────┘                       └──────────────────────────┘
```

- Chunks are `16 × 64 × 16` grids of `uint16` material ids (0 = air),
  transferred base64-encoded and meshed client-side with face culling.
- Rendering uses a single vertex-colored `MeshLambertMaterial`; a
  deterministic per-voxel brightness jitter gives stone its speckled look,
  so 1024 materials cost one draw-call material, not 1024.
- Block targeting uses Amanatides & Woo voxel traversal (exact grid
  raycasting), not mesh intersection.

## Files

| Path | Purpose |
| --- | --- |
| `server.py` | HTTP server: static files + JSON API (`/api/config`, `/api/chunk`, `/api/edits`) |
| `materials.py` | Builds the 1024+ material catalog |
| `worldgen.py` | Perlin noise + the scene generators |
| `static/index.html` | UI shell: HUD, hotbar, material browser, inventory |
| `static/js/main.js` | Game client: streaming, meshing, controls, editing |
| `static/vendor/three.module.js` | Vendored Three.js r160 |
