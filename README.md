# Browser Voxel World

A browser 3D voxel world demo: a **Three.js** frontend driven by a **Python
backend** that dictates the contents of every scene. No dependencies to
install — the backend is pure Python standard library and Three.js is
vendored into the repo.

With API calls to make it useable for algorythmic art or visualisation of data.

![stack](https://img.shields.io/badge/frontend-Three.js%20r160-blue)
![stack](https://img.shields.io/badge/backend-Python%203%20stdlib-green)

This is a vibe coding experiment: The challenge is to make this without touching code. Security is mostly ignored, except for specified url/IP to limit access. 

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
  (Space/Left Shift for up/down, no gravity).
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
- **Voxel lighting**: Minecraft-style flood-fill light with *coloured*
  RGB channels. Skylight is occluded by terrain — dug holes and caves are
  dark — and scales with the day/night cycle. Light-emitting materials
  (Lamp, Glowstone, Sea Lantern, lava, froglights…, levels defined in the
  backend material catalog via the `emissive` field) flood block-light in
  their own colour, so caves are lit by light materials. Light passing
  through stained glass is filtered per colour channel: sunlight through
  a blue pane is blue, and a lamp behind orange glass casts orange light.
- **Lamps**: the Lamp material additionally drives a real point light;
  its colour and strength are governed by the glass around it (stained
  glass tints, clear glass brightens, tinted glass dims).
- **Fluids**: Sand/Water/Lava Faucet blocks pour 5 cm fluid voxels
  (deliberately a touch slower than the real stuff). Cross effects are
  backend-configured: lava + water freezes to obsidian, wood burns in
  lava, small wooden voxels float up through water, water cools magma to
  coal — and those effects are persisted world edits. Fluid is
  **unlimited in presence**: nothing is ever despawned to make room.
  `maxCellsPerType` (default 4000) is a per-tick *movement budget* — when
  more cells are in motion than the budget, each tick steps a rotating
  window of that many cells, so more moving fluid simply moves slower.
  Cells that reach equilibrium (no movement for `settleAfterTicks`) move
  to a **settled tier**: they cost nothing per tick, don't consume the
  movement budget, and re-render only when the pool changes. Settled
  cells wake when disturbed — a neighbour vacates, a block is placed or
  mined nearby (mining under a pile causes an avalanche), or a reaction
  partner arrives.
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
- **World management** — press **M** to create, rename, and delete your own
  worlds, alongside the three built-in scenes above (which can't be renamed
  or deleted). Three generator types:
  - **Flat plain**: a chosen material, N blocks thick, over an otherwise
    empty void.
  - **Perlin noise**: rolling hills of a chosen material, with adjustable
    seed and amplitude (a generalization of Granite Hills' generator).
  - **Single block in a void**: exactly one voxel, and nothing else — you
    spawn standing on top of it, in open air, so falling off is the point.

  Renaming only changes a world's display title; its underlying id (used for
  chunk/edit storage) never changes. Custom worlds persist across restarts
  in `world_state.json`; deleting one falls back every connected browser to
  the default scene with a toast. See [API.md](API.md#worlds) for the
  scriptable `GET/POST /api/worlds` endpoint.
- **Minecraft schematic import** — press **Right Shift+L** while looking at a
  block to load a `.schem` (Sponge/WorldEdit, versions 1–3) or legacy
  `.schematic` (MCEdit) file from disk. The structure is pasted **centered
  on the targeted block in all three axes** and rotated in 90° increments
  to face away from the surface you clicked (a floor/ceiling hit keeps it
  unrotated); existing voxels in the pasted volume are replaced, including
  with air where the schematic has air. Blocks with no equivalent in this
  engine's catalog (stairs, fences, and other shaped blocks that aren't
  full cubes — see composite objects below for the ones modeled here) fall
  back to Stone, and a summary toast plus a `console.warn` list what was
  substituted. Capped at 512 blocks per axis (width/height/length). Parsing
  is entirely client-side (a small dependency-free DEFLATE/gzip/zlib decoder
  and NBT reader in `static/js/inflate.js` / `nbt.js`) — the backend only
  ever sees the resulting `POST /api/edits`, same as if a player built it
  by hand.
- **Composite object materials** — beyond single-color solid blocks, some
  Minecraft materials are *shapes* built from many small voxels: stairs,
  slabs, fences, panes, doors, trapdoors, pressure plates, buttons,
  torches, lanterns, chains, ladders, and poles. Each is defined in
  `objects/{slug}.txt` (e.g. `objects/oak_stairs.txt`) as a simple list of
  colored cells in **10 mm units**:
  ```
  # X Y Z RRGGBB
  10 15 20 FF0000
  11 15 20 00FF00
  ```
  Alpha is optional (`RRGGBBAA`); `00` skips the cell entirely, anything
  else is treated as solid. Cell colors are resolved to catalog "swatch"
  materials (reusing an existing material if the color matches exactly),
  and torches/lanterns propagate their emissive glow and glass panes their
  translucency onto those swatches. Objects place like any other material —
  right-click puts them in the normal adjacent cell — but decompose
  immediately into their constituent sub-voxels, individually minable like
  any other voxel, and always consume exactly one inventory unit regardless
  of how many cells make up the shape. If an object's `.txt` file is
  missing, it still appears in the material browser but placing it shows a
  toast and logs a console error instead of doing anything. Colored
  variant families (carpet/bed/banner/candle × 16 dye colors) aren't
  authored as objects in this pass — only the 14 shapes above ship by
  default; adding more just means dropping in another `.txt` file.

## Architecture

```
┌────────────────────────┐   GET /api/config     ┌──────────────────────────┐
│ Browser (Three.js)     │ ───────────────────▶  │ Python backend           │
│  static/js/main.js     │   materials + scenes  │  server.py   (stdlib)    │
│                        │                       │  materials.py (1024+)    │
│  - chunk meshing       │   GET /api/chunk      │  worldgen.py  (Perlin)   │
│  - pointer lock + WASD │ ───────────────────▶  │                          │
│  - voxel raycasting    │   uint16 voxels (b64) │  scenes generate chunks  │
│  - hotbar/inventory UI │                       │  16 × 1024 × 16          │
│                        │   POST /api/edits     │                          │
│                        │ ───────────────────▶  │  in-memory edit store    │
└────────────────────────┘                       └──────────────────────────┘
```

- Chunks are `16 × 1024 × 16` grids of `uint16` material ids (0 = air),
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
| `server.py` | HTTP server: static files + JSON API (`/api/config`, `/api/chunk`, `/api/edits`, `/api/worlds`) |
| `materials.py` | Builds the 1024+ material catalog, including composite object materials |
| `worldgen.py` | Perlin noise, the built-in scenes, and the Flat/Perlin/SingleBlock world generators |
| `objects/*.txt` | Composite object shape definitions (stairs, fences, panes, torches, ...) |
| `static/index.html` | UI shell: HUD, hotbar, material browser, inventory, world manager |
| `static/js/main.js` | Game client: streaming, meshing, controls, editing, world manager UI |
| `static/js/inflate.js` | Dependency-free DEFLATE/gzip/zlib decoder for schematic files |
| `static/js/nbt.js` | Minecraft NBT (Named Binary Tag) reader |
| `static/js/schematic.js` | `.schem` / `.schematic` parsing, block mapping, and placement math |
| `static/vendor/three.module.js` | Vendored Three.js r160 |
