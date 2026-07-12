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
    def __init__(self, name, title, description, spawn, look=(0.785, -0.25)):
        self.name = name
        self.title = title
        self.description = description
        self.spawn = spawn  # [x, y, z]
        self.look = look    # (yaw, pitch) radians

    def generate_chunk(self, cx, cz):
        raise NotImplementedError

    def meta(self):
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "spawn": self.spawn,
            "look": list(self.look),
            "chunkSize": [CHUNK_X, CHUNK_Y, CHUNK_Z],
        }


class GraniteHills(Scene):
    """Default scene: rolling Perlin-noise hills made entirely of granite."""

    def __init__(self):
        super().__init__(
            "granite_hills",
            "Granite Hills",
            "Rolling Perlin-noise hills carved from solid granite.",
            spawn=[8.5, 40.0, 8.5],
        )
        self.perlin = Perlin2D(seed=1337)
        self.base_height = 22
        self.amplitude = 14
        self.scale = 1 / 48.0

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


def build_scenes(material_count):
    scenes = [GraniteHills(), MaterialMuseum(material_count), GlassCathedral()]
    return {s.name: s for s in scenes}


DEFAULT_SCENE = "granite_hills"
