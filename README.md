# Browser Voxel World

A browser 3D voxel world demo: a **Three.js** frontend driven by a **Python
backend** that dictates the contents of every scene. No dependencies to
install — the backend is pure Python standard library and Three.js is
vendored into the repo.

![stack](https://img.shields.io/badge/frontend-Three.js%20r160-blue)
![stack](https://img.shields.io/badge/backend-Python%203%20stdlib-green)

## Run it

```bash
uv run server.py             # defaults to http://127.0.0.1:8000
# or plain Python — there are zero dependencies:
python3 server.py
# options:
python3 server.py --port 9000 --host 0.0.0.0
```

Open http://127.0.0.1:8000 in a browser, pick a scene, and click **Play**.
Requires Python ≥ 3.9 (declared via PEP 723 metadata in `server.py` and in
`pyproject.toml`); the backend is pure standard library, so `uv run` has
nothing to install and starts instantly.

## Features

- **WASD** movement, **mouse look** (pointer lock), hold F to sprint.
  You start in **walk mode**: gravity pulls you down, Space jumps, and
  WASD still steers mid-air. **Double-tap Space** to toggle **fly mode**
  (Space/Shift for up/down, no gravity).
- **Create / Destroy / Store blocks**: left click mines the targeted voxel
  and stores it in your inventory (press **Q** to view), right click places
  a block from the active hotbar slot (stored blocks are consumed first,
  then supply is creative/infinite), middle click picks the targeted
  material into the hotbar.
- **Variable-size voxels, measured in integer millimetres**: the default
  voxel is 1000 mm; press **G / V** to cycle the working size through
  1000 → 500 → 100 → 50 → 10 mm (1 cm is the minimum). Every size divides
  the previous one, so voxels can be exactly *comprised of smaller voxels*:
  mining a big voxel with a smaller size **carves** it — the removed piece
  goes to your inventory and the remainder is decomposed into the largest
  aligned sub-voxels that fill it (e.g. taking a 10 mm bite out of a
  1000 mm granite block yields 7×500 + 124×100 + 7×50 + 124×10 mm voxels).
- **Persistent world**: every edit is POSTed to the backend, which stores
  it in `world_state.json` — changes survive both page reloads *and server
  restarts*.
- **Screen surfaces**: panels of Screen voxels the backend draws
  **Markdown or SVG** onto (`GET/POST /api/screens`). Content is versioned;
  browsers re-render within ~2 s of a change. The demo scene has a
  markdown Sensor Board and an SVG art panel.
- **Actionable materials**: the red **Touch Sensor** (right-click), yellow
  **Light Sensor** (look at it) and teal **Pressure Plate** (hover above
  it) POST events to the backend (`/api/events`). Poll them, receive them
  by webhook (`/api/subscribe`), or handle them in-process — the demo
  handler rewrites the Sensor Board and toggles indicator blocks.
- **Lamps**: the Lamp material is a real point light; its colour and
  strength are governed by the glass around it (stained glass tints,
  clear glass brightens, tinted glass dims).
- **Fluids**: Sand/Water/Lava Faucet blocks pour 5 cm fluid voxels
  (deliberately a touch slower than the real stuff). Cross effects are
  backend-configured: lava + water freezes to obsidian, wood burns in
  lava, small wooden voxels float up through water, water cools magma to
  coal — and those effects are persisted world edits. Fluid cells that
  reach equilibrium (no movement for ~1 s) move to a **settled tier**:
  they cost nothing per tick, don't count against the active cap
  (`maxCellsPerType`, default 4000), and are only re-rendered when the
  pool changes. Settled cells wake again when disturbed — a neighbour
  vacates, a block is placed or mined nearby (mining under a pile causes
  an avalanche), or a reaction partner arrives. At the active cap,
  faucets recycle the oldest moving cell instead of stalling.
- **Day/night cycle**: procedural sky with a visible sun, moon and stars,
  running at 4× realtime by default. The backend owns the clock —
  `POST /api/time {"time": "18:30", "speed": 60}` sets the apparent time
  and clock speed, and all connected browsers follow within ~2 s.
- **Collision**: you can't move through solid matter — base voxels or
  sub-voxels of any size. Movement resolves per axis so you slide along
  walls; press **N** to toggle no-clip for free flight.
- **Full backend API** — see [API.md](API.md) for placing/removing voxels,
  driving screens, subscribing to sensor events and setting the clock
  from your own code.
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
- Sub-voxels (all sizes below 1000 mm) live in a sparse overlay keyed by
  their integer mm origin and size — `(x_mm, y_mm, z_mm, size_mm) → id` —
  sent alongside each chunk and meshed as scaled boxes in the same
  vertex-colored geometry.
- World edits (`op:"set"` for the base grid, `op:"sub"` for smaller voxels)
  are validated server-side and written atomically to `world_state.json`
  after every batch, then reloaded at startup.
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
