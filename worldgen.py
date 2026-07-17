"""Server-side scene generation for the voxel world.

The backend dictates the contents of every scene: the client only asks for
chunks and renders what it gets. Chunks are CHUNK_X x CHUNK_Y x CHUNK_Z
uint16 material-id grids (0 = air), indexed as x + z*CHUNK_X + y*CHUNK_X*CHUNK_Z.
"""

import math
import random

from materials import NAME_TO_ID, GRANITE_ID

CHUNK_X = 16
CHUNK_Y = 64
CHUNK_Z = 16

# Voxel sizes are integers in millimetres. The base grid cell (a default
# voxel) is 1000 mm; voxels can be subdivided into smaller voxels down to
# MIN_VOXEL_SIZE_MM (1 cm). Each size in the chain divides the previous one,
# so any larger voxel can be exactly decomposed into smaller ones.
VOXEL_SIZE_MM = 1000                        # default voxel edge length
MIN_VOXEL_SIZE_MM = 10                      # 1 cm, the smallest voxel
VOXEL_SIZES_MM = [1000, 500, 100, 50, 10]   # subdivision chain (2,5,2,5)

assert all(a % b == 0 for a, b in zip(VOXEL_SIZES_MM, VOXEL_SIZES_MM[1:]))
assert VOXEL_SIZES_MM[0] == VOXEL_SIZE_MM
assert VOXEL_SIZES_MM[-1] == MIN_VOXEL_SIZE_MM


class Perlin2D:
    """Classic 2D Perlin gradient noise with a seeded permutation table."""

    def __init__(self, seed=0):
        rng = random.Random(seed)
        perm = list(range(256))
        rng.shuffle(perm)
        self.perm = perm + perm

    @staticmethod
    def _fade(t):
        return t * t * t * (t * (t * 6 - 15) + 10)

    @staticmethod
    def _grad(h, x, y):
        # 8 gradient directions
        h &= 7
        u = x if h < 4 else y
        v = y if h < 4 else x
        return (u if h & 1 == 0 else -u) + ((v if h & 2 == 0 else -v) * 2.0)

    def noise(self, x, y):
        xi = math.floor(x) & 255
        yi = math.floor(y) & 255
        xf = x - math.floor(x)
        yf = y - math.floor(y)
        u = self._fade(xf)
        v = self._fade(yf)
        p = self.perm
        aa = p[p[xi] + yi]
        ab = p[p[xi] + yi + 1]
        ba = p[p[xi + 1] + yi]
        bb = p[p[xi + 1] + yi + 1]
        x1 = self._lerp(self._grad(aa, xf, yf), self._grad(ba, xf - 1, yf), u)
        x2 = self._lerp(self._grad(ab, xf, yf - 1),
                        self._grad(bb, xf - 1, yf - 1), u)
        return self._lerp(x1, x2, v)  # roughly in [-2, 2] with this grad set

    @staticmethod
    def _lerp(a, b, t):
        return a + t * (b - a)

    def fbm(self, x, y, octaves=4, lacunarity=2.0, gain=0.5):
        total, amp, freq, norm = 0.0, 1.0, 1.0, 0.0
        for _ in range(octaves):
            total += self.noise(x * freq, y * freq) * amp
            norm += amp
            amp *= gain
            freq *= lacunarity
        return total / norm


class Scene:
    def __init__(self, name, title, description, spawn, look=(0.785, -0.25),
                 builtin=False, world_type=None, params=None):
        self.name = name          # stable id, never changes (rename-safe)
        self.title = title        # mutable display name
        self.description = description
        self.spawn = spawn  # [x, y, z]
        self.look = look    # (yaw, pitch) radians
        self.builtin = builtin    # True for the 3 demo scenes: no rename/delete
        self.world_type = world_type  # "flat"|"perlin"|"single_block", or None
        self.params = params or {}    # generator params, for persistence
        # Backend-placed blocks layered over generated terrain (screens,
        # sensors, ...): {(x, y, z): material_id}
        self.fixtures = {}
        # Display surfaces the backend can draw markdown/SVG on:
        # {id: {origin, facing, w, h, content, version}}
        self.screens = {}
        # Named points of interest (e.g. sensor positions), for the client
        # and for tests: {name: [x, y, z]}
        self.pois = {}

    def generate_chunk(self, cx, cz):
        raise NotImplementedError

    def add_screen(self, sid, origin, facing, w, h, ctype, data,
                   screen_material_id=None):
        """Declare a screen surface of w x h blocks. `facing` is one of
        +z/-z/+x/-x. The screen's voxels are added as fixtures so the panel
        physically exists in the world."""
        self.screens[sid] = {
            "id": sid,
            "origin": list(origin),
            "facing": facing,
            "w": w,
            "h": h,
            "content": {"type": ctype, "data": data},
            "version": 1,
        }
        mat = screen_material_id or NAME_TO_ID["Screen"]
        x0, y0, z0 = origin
        for i in range(w):
            for j in range(h):
                if facing in ("+z", "-z"):
                    self.fixtures[(x0 + i, y0 + j, z0)] = mat
                else:
                    self.fixtures[(x0, y0 + j, z0 + i)] = mat

    def set_screen_content(self, sid, ctype, data):
        screen = self.screens[sid]
        screen["content"] = {"type": ctype, "data": data}
        screen["version"] += 1

    def meta(self):
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "spawn": self.spawn,
            "look": list(self.look),
            "chunkSize": [CHUNK_X, CHUNK_Y, CHUNK_Z],
            "pois": self.pois,
            "builtin": self.builtin,
            "worldType": self.world_type,
            "params": self.params,
        }


DEMO_MARKDOWN = """# Sensor Board

This screen is rendered from **Markdown** sent by the *Python backend*.

- `Touch Sensor` (red): right-click it
- `Light Sensor` (yellow): look at it
- `Pressure Plate` (teal): hover over it

> Trigger a sensor and the backend rewrites this screen.

Touches: 0 · Light: 0 · Pressure: 0
"""

DEMO_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="g" cx="50%" cy="42%" r="65%">
      <stop offset="0%" stop-color="#284a75"/>
      <stop offset="100%" stop-color="#0b1020"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <g stroke="#7fc8ff" stroke-width="3" fill="none" opacity="0.9">
    <circle cx="256" cy="220" r="120"/>
    <circle cx="256" cy="220" r="84"/>
    <circle cx="256" cy="220" r="48"/>
  </g>
  <g fill="#ffd94a">
    <circle cx="256" cy="100" r="10"/>
    <circle cx="376" cy="220" r="10"/>
    <circle cx="256" cy="340" r="10"/>
    <circle cx="136" cy="220" r="10"/>
  </g>
  <polygon points="256,180 271,225 256,270 241,225" fill="#d9484c"/>
  <text x="256" y="420" text-anchor="middle" font-family="sans-serif"
        font-size="34" fill="#e8eaf0">SVG from Python</text>
  <text x="256" y="460" text-anchor="middle" font-family="sans-serif"
        font-size="20" fill="#8b98a7">POST /api/screens to change me</text>
</svg>"""


class GraniteHills(Scene):
    """Default scene: rolling Perlin-noise hills made entirely of granite."""

    def __init__(self):
        super().__init__(
            "granite_hills",
            "Granite Hills",
            "Rolling Perlin-noise hills carved from solid granite.",
            spawn=[8.5, 40.0, 8.5],
            builtin=True,
        )
        self.perlin = Perlin2D(seed=1337)
        self.base_height = 22
        self.amplitude = 14
        self.scale = 1 / 48.0
        self._build_demo_installation()

    def _build_demo_installation(self):
        """A screen wall plus one of each actionable sensor near spawn,
        wired up by the backend event handler in server.py."""
        base_y = 1 + max(self.height_at(x, z)
                         for x in range(3, 17) for z in range(2, 10))

        self.add_screen(
            "board", (4, base_y, 3), "+z", 6, 4, "markdown", DEMO_MARKDOWN)
        self.add_screen(
            "art", (11, base_y, 3), "+z", 4, 4, "svg", DEMO_SVG)

        touch = (5, self.height_at(5, 7) + 1, 7)
        light = (8, self.height_at(8, 7) + 1, 7)
        pressure = (11, self.height_at(11, 7) + 1, 7)
        self.fixtures[touch] = NAME_TO_ID["Touch Sensor"]
        self.fixtures[light] = NAME_TO_ID["Light Sensor"]
        self.fixtures[pressure] = NAME_TO_ID["Pressure Plate"]

        # Lamp post: light colour/strength is governed by the stained glass
        # panes around the lamp (see the lamp handling in the client).
        gy = self.height_at(15, 12) + 1
        lamp = (15, gy + 2, 12)
        self.fixtures[(15, gy, 12)] = NAME_TO_ID["Iron Block"]
        self.fixtures[(15, gy + 1, 12)] = NAME_TO_ID["Iron Block"]
        self.fixtures[lamp] = NAME_TO_ID["Lamp"]
        self.fixtures[(14, gy + 2, 12)] = NAME_TO_ID["Blue Stained Glass"]
        self.fixtures[(16, gy + 2, 12)] = NAME_TO_ID["Orange Stained Glass"]

        # Fluid faucets on iron stands: sand, water and lava pour out as
        # 5 cm fluid voxels. Water and lava are close enough to make
        # obsidian where the streams meet; wooden planks under the lava
        # faucet demonstrate burning.
        faucets = [("Sand Faucet", "sand_faucet", 20),
                   ("Water Faucet", "water_faucet", 24),
                   ("Lava Faucet", "lava_faucet", 27)]
        for name, key, fx in faucets:
            fz = 8
            fy = self.height_at(fx, fz) + 5
            self.fixtures[(fx, fy, fz)] = NAME_TO_ID[name]
            self.pois[key] = [fx, fy, fz]
        wy = self.height_at(27, 8)
        for dx in range(-1, 2):
            for dz in range(-1, 2):
                self.fixtures[(27 + dx, wy + 1, 8 + dz)] = \
                    NAME_TO_ID["Oak Planks"]

        self.pois.update({
            "touch_sensor": list(touch),
            "light_sensor": list(light),
            "pressure_plate": list(pressure),
            "screen_board": [4, base_y, 3],
            "screen_art": [11, base_y, 3],
            "lamp": list(lamp),
        })

    def height_at(self, wx, wz):
        n = self.perlin.fbm(wx * self.scale, wz * self.scale, octaves=4)
        h = self.base_height + n * self.amplitude
        return max(1, min(CHUNK_Y - 2, int(round(h))))

    def generate_chunk(self, cx, cz):
        voxels = [0] * (CHUNK_X * CHUNK_Y * CHUNK_Z)
        for z in range(CHUNK_Z):
            for x in range(CHUNK_X):
                wx = cx * CHUNK_X + x
                wz = cz * CHUNK_Z + z
                h = self.height_at(wx, wz)
                col = x + z * CHUNK_X
                layer = CHUNK_X * CHUNK_Z
                for y in range(h + 1):
                    voxels[col + y * layer] = GRANITE_ID
        return voxels


class MaterialMuseum(Scene):
    """A flat gallery that lays out every material as a pillar on a grid,
    proving the catalog really holds 1024+ entries."""

    def __init__(self, material_count):
        super().__init__(
            "material_museum",
            "Material Museum",
            "Every material in the catalog on display, one pillar each.",
            spawn=[48.5, 16.0, -10.0],
            look=(math.pi, -0.28),  # face the pillar lattice (+z)
            builtin=True,
        )
        self.material_count = material_count
        self.floor_id = NAME_TO_ID["Polished Andesite"]
        self.spacing = 3
        self.per_row = 32

    def generate_chunk(self, cx, cz):
        voxels = [0] * (CHUNK_X * CHUNK_Y * CHUNK_Z)
        layer = CHUNK_X * CHUNK_Z
        floor_y = 4
        for z in range(CHUNK_Z):
            for x in range(CHUNK_X):
                wx = cx * CHUNK_X + x
                wz = cz * CHUNK_Z + z
                col = x + z * CHUNK_X
                for y in range(floor_y + 1):
                    voxels[col + y * layer] = self.floor_id
                # Pillar lattice starts at the origin heading +x/+z.
                if wx >= 0 and wz >= 0 and \
                        wx % self.spacing == 0 and wz % self.spacing == 0:
                    ix = wx // self.spacing
                    iz = wz // self.spacing
                    if ix < self.per_row:
                        mat = iz * self.per_row + ix + 1  # ids start at 1
                        if mat <= self.material_count:
                            for y in range(floor_y + 1, floor_y + 3):
                                voxels[col + y * layer] = mat
        return voxels


class GlassCathedral(Scene):
    """A sine-wave landscape of stained glass and quartz — a second
    backend-authored scene to show scenes really come from Python."""

    def __init__(self):
        super().__init__(
            "glass_cathedral",
            "Glass Cathedral",
            "Interfering sine ridges of stained glass, quartz and gold.",
            spawn=[8.5, 42.0, 8.5],
            builtin=True,
        )
        dyes = ["Red", "Orange", "Yellow", "Lime", "Cyan",
                "Blue", "Purple", "Magenta"]
        self.bands = [NAME_TO_ID[f"{d} Stained Glass"] for d in dyes]
        self.quartz = NAME_TO_ID["Quartz Block"]
        self.gold = NAME_TO_ID["Gold Block"]

    def generate_chunk(self, cx, cz):
        voxels = [0] * (CHUNK_X * CHUNK_Y * CHUNK_Z)
        layer = CHUNK_X * CHUNK_Z
        for z in range(CHUNK_Z):
            for x in range(CHUNK_X):
                wx = cx * CHUNK_X + x
                wz = cz * CHUNK_Z + z
                h = int(18 + 9 * math.sin(wx * 0.12)
                        + 9 * math.cos(wz * 0.09)
                        + 4 * math.sin((wx + wz) * 0.05))
                h = max(2, min(CHUNK_Y - 2, h))
                col = x + z * CHUNK_X
                ridge = (wx // 8 + wz // 8) % 2 == 0
                for y in range(h + 1):
                    if y < 3:
                        mat = self.gold
                    elif ridge and y == h:
                        mat = self.quartz
                    else:
                        mat = self.bands[(y // 3) % len(self.bands)]
                    voxels[col + y * layer] = mat
        return voxels


class FlatWorld(Scene):
    """A user-created flat plain: `height` layers of one material."""

    def __init__(self, name, title, material_id, height=4):
        height = max(1, min(CHUNK_Y - 2, int(height)))
        super().__init__(
            name, title, f"Flat plain, {height} layers thick.",
            spawn=[8.5, height + 2.0, 8.5],
            world_type="flat", params={"material": material_id,
                                       "height": height},
        )
        self.material_id = material_id
        self.height = height

    def generate_chunk(self, cx, cz):
        layer = CHUNK_X * CHUNK_Z
        voxels = [0] * (CHUNK_X * CHUNK_Y * CHUNK_Z)
        for y in range(self.height):
            for i in range(layer):
                voxels[i + y * layer] = self.material_id
        return voxels


class PerlinWorld(Scene):
    """A user-created Perlin-noise hill world of a chosen material —
    the same generator as GraniteHills, parametrized instead of hardcoded."""

    def __init__(self, name, title, material_id, seed=0,
                 base_height=22, amplitude=14, scale=48):
        super().__init__(
            name, title, "Rolling Perlin-noise hills.",
            spawn=[8.5, base_height + amplitude + 4.0, 8.5],
            world_type="perlin",
            params={"material": material_id, "seed": seed,
                    "baseHeight": base_height, "amplitude": amplitude,
                    "scale": scale},
        )
        self.material_id = material_id
        self.perlin = Perlin2D(seed=seed)
        self.base_height = base_height
        self.amplitude = amplitude
        self.scale = 1 / float(scale)

    def height_at(self, wx, wz):
        n = self.perlin.fbm(wx * self.scale, wz * self.scale, octaves=4)
        h = self.base_height + n * self.amplitude
        return max(1, min(CHUNK_Y - 2, int(round(h))))

    def generate_chunk(self, cx, cz):
        voxels = [0] * (CHUNK_X * CHUNK_Y * CHUNK_Z)
        layer = CHUNK_X * CHUNK_Z
        for z in range(CHUNK_Z):
            for x in range(CHUNK_X):
                wx = cx * CHUNK_X + x
                wz = cz * CHUNK_Z + z
                h = self.height_at(wx, wz)
                col = x + z * CHUNK_X
                for y in range(h + 1):
                    voxels[col + y * layer] = self.material_id
        return voxels


class SingleBlockWorld(Scene):
    """A void world containing exactly one voxel; the player spawns
    standing on it (stepping off is the point)."""

    ORIGIN = (8, 32, 8)

    def __init__(self, name, title, material_id):
        ox, oy, oz = self.ORIGIN
        super().__init__(
            name, title, "A single block floating in an endless void.",
            spawn=[ox + 0.5, oy + 1.0, oz + 0.5],
            world_type="single_block", params={"material": material_id},
        )
        self.material_id = material_id

    def generate_chunk(self, cx, cz):
        voxels = [0] * (CHUNK_X * CHUNK_Y * CHUNK_Z)
        ox, oy, oz = self.ORIGIN
        if cx == ox // CHUNK_X and cz == oz // CHUNK_Z:
            layer = CHUNK_X * CHUNK_Z
            lx, lz = ox - cx * CHUNK_X, oz - cz * CHUNK_Z
            voxels[lx + lz * CHUNK_X + oy * layer] = self.material_id
        return voxels


WORLD_TYPES = {"flat": FlatWorld, "perlin": PerlinWorld,
               "single_block": SingleBlockWorld}


def build_world(world_type, name, title, params):
    """Construct a custom (non-builtin) Scene from a type name + params
    dict, as produced by /api/worlds or reloaded from world_state.json."""
    cls = WORLD_TYPES[world_type]
    material_id = params["material"]
    if cls is FlatWorld:
        return FlatWorld(name, title, material_id,
                          height=params.get("height", 4))
    if cls is PerlinWorld:
        return PerlinWorld(name, title, material_id,
                            seed=params.get("seed", 0),
                            base_height=params.get("baseHeight", 22),
                            amplitude=params.get("amplitude", 14),
                            scale=params.get("scale", 48))
    return SingleBlockWorld(name, title, material_id)


def build_scenes(material_count):
    scenes = [GraniteHills(), MaterialMuseum(material_count), GlassCathedral()]
    return {s.name: s for s in scenes}


DEFAULT_SCENE = "granite_hills"
