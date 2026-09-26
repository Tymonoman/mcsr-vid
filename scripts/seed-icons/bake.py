#!/usr/bin/env python3
"""Bake a seed-icon scene: a Minecraft 1.16.1 structure template plus edits, resolved through the
client jar's own blockstates -> models -> textures exactly as the game bakes a block, into a list of
textured faces that remotion/SeedScene.tsx draws. Stdlib only. The spec format is
scripts/seed-icons/README.md.

  python3 scripts/seed-icons/bake.py <spec.json> [--jar client.jar] [--out baked.json] [--size N]
  python3 scripts/seed-icons/bake.py --check <structures dir or .nbt/.json ...>   (resolve only)

Prints the baked file's path. Textures the scene uses are copied out of the jar, raw bytes, to
remotion/assets/minecraft/textures/<same path as in the jar>.
"""
import argparse, glob, gzip, hashlib, io, json, math, os, struct, sys, urllib.request, zipfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(REPO, "remotion", "seedIcons")
ASSETS = os.path.join(REPO, "remotion", "assets")  # Remotion's public dir; textures land in minecraft/textures/
DEFAULT_JAR = os.environ.get("MC_JAR") or os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "mcsr-vid", "client-1.16.1.jar"
)
MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"


def ensure_jar(path):
    """The 1.16.1 client jar, downloaded from Mojang's own manifest (sha1-checked) when missing."""
    if os.path.exists(path):
        return path
    print(f"downloading the 1.16.1 client jar to {path}", file=sys.stderr)
    get = lambda url: urllib.request.urlopen(url, timeout=60).read()
    version = next(v for v in json.loads(get(MANIFEST))["versions"] if v["id"] == "1.16.1")
    client = json.loads(get(version["url"]))["downloads"]["client"]
    data = get(client["url"])
    if hashlib.sha1(data).hexdigest() != client["sha1"]:
        sys.exit("client jar: sha1 mismatch")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".part", "wb") as f:
        f.write(data)
    os.replace(path + ".part", path)
    return path


# --- NBT (structure templates) -------------------------------------------------------------------


def nbt_read(f, t):
    if t == 1: return struct.unpack(">b", f.read(1))[0]
    if t == 2: return struct.unpack(">h", f.read(2))[0]
    if t == 3: return struct.unpack(">i", f.read(4))[0]
    if t == 4: return struct.unpack(">q", f.read(8))[0]
    if t == 5: return struct.unpack(">f", f.read(4))[0]
    if t == 6: return struct.unpack(">d", f.read(8))[0]
    if t == 7: n = nbt_read(f, 3); return list(f.read(n))
    if t == 8: n = struct.unpack(">H", f.read(2))[0]; return f.read(n).decode("utf-8")
    if t == 9:
        et = f.read(1)[0]; n = nbt_read(f, 3); return [nbt_read(f, et) for _ in range(n)]
    if t == 10:
        d = {}
        while True:
            et = f.read(1)[0]
            if et == 0: return d
            k = nbt_read(f, 8); d[k] = nbt_read(f, et)
    if t == 11: n = nbt_read(f, 3); return [nbt_read(f, 3) for _ in range(n)]
    if t == 12: n = nbt_read(f, 3); return [nbt_read(f, 4) for _ in range(n)]
    raise ValueError(t)


def nbt_load(raw):
    f = io.BytesIO(gzip.decompress(raw))
    assert f.read(1)[0] == 10
    nbt_read(f, 8)
    return nbt_read(f, 10)


# Never placed by the game: air, and the data markers (BlockIgnoreProcessor.STRUCTURE_AND_AIR).
SKIP = {"air", "cave_air", "void_air", "structure_void", "structure_block"}


def parse_state(s):
    """'minecraft:oak_stairs[facing=east,half=top]' -> ('oak_stairs', {'facing': 'east', 'half': 'top'})."""
    base, _, rest = s.partition("[")
    props = dict(kv.split("=", 1) for kv in rest.rstrip("]").split(",")) if rest.strip("]") else {}
    return base.replace("minecraft:", ""), props


def load_template(jar, ref, palette=0):
    """{(x,y,z): (name, props)} and the size, from a jar path ('shipwreck/with_mast'), an .nbt file,
    or a structures JSON ({size, blocks: [[x,y,z,name,props]]})."""
    if ref.endswith(".json"):
        d = json.load(open(ref))
        blocks = {(x, y, z): (n.replace("minecraft:", ""), p) for x, y, z, n, p in d["blocks"]}
        return {k: v for k, v in blocks.items() if v[0] not in SKIP}, d["size"]
    raw = open(ref, "rb").read() if ref.endswith(".nbt") else jar.z.read(f"data/minecraft/structures/{ref}.nbt")
    t = nbt_load(raw)
    pal = t["palettes"][palette] if "palettes" in t else t["palette"]
    states = [(p["Name"], p.get("Properties", {})) for p in pal]
    blocks = {}
    for b in t["blocks"]:
        n, props = states[b["state"]]
        if n == "minecraft:jigsaw":  # the game swaps a jigsaw for its final_state
            n, props = parse_state(b.get("nbt", {}).get("final_state", "minecraft:air"))
        n = n.replace("minecraft:", "")
        if n not in SKIP:
            blocks[tuple(b["pos"])] = (n, dict(props))
    return blocks, t["size"]


# --- edits ---------------------------------------------------------------------------------------


def box_cells(a, b):
    (x0, x1), (y0, y1), (z0, z1) = (sorted((a[i], b[i])) for i in range(3))
    return [(x, y, z) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1) for z in range(z0, z1 + 1)]


def bounds(blocks):
    if not blocks:
        return (0, 0, 0), (0, 0, 0)
    xs, ys, zs = zip(*blocks)
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def block_of(e):
    name, props = parse_state(e["block"])
    return name, {**props, **{k: str(v).lower() if isinstance(v, bool) else str(v) for k, v in e.get("props", {}).items()}}


def apply_edits(blocks, edits, nudges=None):
    """`nudges` collects the `nudge` edits: cell -> [dx, dy, dz] in blocks, fractions allowed."""
    nudges = {} if nudges is None else nudges
    for e in edits:
        op = e["op"]
        if op == "nudge":
            nudges[tuple(e["at"])] = e["by"]
        elif op == "set":
            blocks[tuple(e["at"])] = block_of(e)
        elif op == "fill":
            b = block_of(e)
            for c in box_cells(e["from"], e["to"]):
                if not e.get("onlyAir") or c not in blocks:
                    blocks[c] = b
        elif op in ("remove", "keep"):
            if "at" in e:
                cells = {tuple(e["at"])}
            elif "from" in e:
                cells = set(box_cells(e["from"], e["to"]))
            else:
                cells = set(blocks)
            names = {parse_state(n)[0] for n in e.get("blocks", [])}
            for c in list(blocks):
                inside = c in cells and (not names or blocks[c][0] in names)
                if inside == (op == "remove"):
                    del blocks[c]
        elif op == "replace":
            m = {k.replace("minecraft:", ""): v for k, v in e["map"].items()}
            for c, (n, p) in list(blocks.items()):
                if n in m:
                    nn, np_ = parse_state(m[n])
                    blocks[c] = (nn, {**p, **np_})
        elif op in ("ground", "water"):
            (x0, y0, z0), (x1, y1, z1) = bounds(blocks)
            m = e.get("margin", 1)
            if op == "ground":
                b = block_of({"block": e.get("block", "grass_block"), "props": e.get("props", {})})
                top = e.get("y", y0 - 1)
                cells = box_cells((x0 - m, top - e.get("depth", 1) + 1, z0 - m), (x1 + m, top, z1 + m))
            else:
                b = ("water", {"level": "0"})
                cells = box_cells((x0 - m, e.get("from", y0), z0 - m), (x1 + m, e["top"], z1 + m))
            for c in cells:
                if c not in blocks:
                    blocks[c] = b
        elif op == "shift":
            d = e["by"]
            for m in (blocks, nudges):
                moved = {(x + d[0], y + d[1], z + d[2]): v for (x, y, z), v in m.items()}
                m.clear()
                m.update(moved)
        else:
            sys.exit(f"unknown edit op {op!r}")
    return blocks


# --- geometry ------------------------------------------------------------------------------------

DIRS = {"down": (0, -1, 0), "up": (0, 1, 0), "north": (0, 0, -1), "south": (0, 0, 1), "west": (-1, 0, 0), "east": (1, 0, 0)}
# FaceInfo: each face's four vertices, 0 = the element's from, 1 = its to, per axis.
FACE_VERTS = {
    "down": [(0, 0, 1), (0, 0, 0), (1, 0, 0), (1, 0, 1)],
    "up": [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)],
    "north": [(1, 1, 0), (1, 0, 0), (0, 0, 0), (0, 1, 0)],
    "south": [(0, 1, 1), (0, 0, 1), (1, 0, 1), (1, 1, 1)],
    "west": [(0, 1, 0), (0, 0, 0), (0, 0, 1), (0, 1, 1)],
    "east": [(1, 1, 1), (1, 0, 1), (1, 0, 0), (1, 1, 0)],
}


def pos_uv(d, p):
    """The UV a point gets when the face's UV follows its position (a face with no uv, or uvlock)."""
    x, y, z = p
    return {
        "down": (x, 16 - z), "up": (x, z), "north": (16 - x, 16 - y),
        "south": (x, 16 - y), "west": (z, 16 - y), "east": (16 - z, 16 - y),
    }[d]


def default_uv(d, f, t):
    a, b = pos_uv(d, f), pos_uv(d, t)
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])]


def rot(p, axis, deg, origin=(8, 8, 8)):
    """Right-hand rotation of p about an axis through origin."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    x, y, z = (p[i] - origin[i] for i in range(3))
    if axis == "x": x, y, z = x, y * c - z * s, y * s + z * c
    elif axis == "y": x, y, z = x * c + z * s, y, -x * s + z * c
    else: x, y, z = x * c - y * s, x * s + y * c, z
    return (x + origin[0], y + origin[1], z + origin[2])


def nearest_dir(n):
    return max(DIRS, key=lambda d: sum(n[i] * DIRS[d][i] for i in range(3)))


def clean(v):
    r = round(v, 5)
    return 0.0 if r == 0 else r


class Face:
    __slots__ = ("tex", "corners", "uv", "normal", "shade", "tint", "glow", "centre", "cull")

    def __init__(self, tex, corners, uv, normal, shade, tint=None, glow=False, centre=None, cull=None):
        self.tex, self.corners, self.uv, self.normal = tex, corners, uv, normal
        self.shade, self.tint, self.glow, self.centre, self.cull = shade, tint, glow, centre, cull


def uv_corners(verts, uvs):
    """From four vertices with their (u,v), the three that carry (u0,v0), (u1,v0), (u0,v1)."""
    us, vs = [u for u, _ in uvs], [v for _, v in uvs]
    a = 0
    b = next((i for i in range(4) if i != a and abs(vs[i] - vs[a]) < 1e-6 and abs(us[i] - us[a]) > 1e-6), None)
    c = next((i for i in range(4) if i != a and abs(us[i] - us[a]) < 1e-6 and abs(vs[i] - vs[a]) > 1e-6), None)
    if b is None or c is None:  # a degenerate uv (one texel line): fall back to the vertex order
        b, c = 3, 1
    return [verts[a], verts[b], verts[c]], [us[a], vs[a], us[b], vs[c]]


# --- the jar's models ----------------------------------------------------------------------------

GRASS, FOLIAGE, WATER = "#91bd59", "#77ab2f", "#3f76e4"  # plains
TINTS = {
    **{n: GRASS for n in ("grass_block", "grass", "tall_grass", "fern", "large_fern", "sugar_cane", "potted_fern")},
    **{n: FOLIAGE for n in ("oak_leaves", "jungle_leaves", "acacia_leaves", "dark_oak_leaves", "vine")},
    "spruce_leaves": "#619961", "birch_leaves": "#80a755", "lily_pad": "#208030", "water": WATER,
}
EMISSIVE = {"lava", "fire", "soul_fire", "nether_portal", "magma_block", "glowstone", "sea_lantern",
            "shroomlight", "lantern", "soul_lantern", "end_rod", "beacon", "jack_o_lantern"}
# Full cubes that still let the faces behind them show (the game's non-occluding blocks).
SEE_THROUGH = ("glass", "leaves", "ice", "slime_block", "honey_block", "spawner", "beacon", "barrier")
# Missing properties take the block's default state.
DEFAULTS = {"axis": "y", "snowy": "false", "half": "bottom", "type": "bottom", "waterlogged": "false",
            "shape": "straight", "open": "false", "powered": "false", "facing": "north", "hinge": "left",
            "north": "false", "south": "false", "east": "false", "west": "false", "up": "false",
            "level": "0", "age": "0", "attachment": "floor", "face": "wall", "part": "foot", "lit": "false"}


class Jar:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.models, self.states, self.used = {}, {}, {}

    def read_json(self, path):
        return json.loads(self.z.read(f"assets/minecraft/{path}.json"))

    def blockstate(self, name):
        if name not in self.states:
            self.states[name] = self.read_json(f"blockstates/{name}")
        return self.states[name]

    def model(self, ref):
        """(textures, elements) with the parent chain applied."""
        ref = ref.replace("minecraft:", "")
        if ref not in self.models:
            if ref.startswith("builtin/"):
                self.models[ref] = ({}, [])
            else:
                j = self.read_json(f"models/{ref}")
                ptex, pel = self.model(j["parent"]) if "parent" in j else ({}, [])
                self.models[ref] = ({**ptex, **j.get("textures", {})}, j.get("elements", pel))
        return self.models[ref]

    def parts(self, name, props):
        """The blockstate's model applications for this state: [{model, x, y, uvlock}]."""
        bs = self.blockstate(name)
        full = {**DEFAULTS, **props}
        if "variants" in bs:
            best, score = None, (-1, "")
            for key, v in bs["variants"].items():
                want = dict(kv.split("=", 1) for kv in key.split(",")) if key else {}
                hits = sum(full.get(k) == val for k, val in want.items())
                if hits == len(want):
                    break
                if hits > score[0]:
                    best, score = v, (hits, key)
            else:
                print(f"warning: {name} {props}: no exact variant, using {score[1]!r}", file=sys.stderr)
                v = best
            return [v[0] if isinstance(v, list) else v]  # a list = weighted random models: the first
        out = []
        for part in bs["multipart"]:
            if "when" not in part or self.when(part["when"], full):
                a = part["apply"]
                out.append(a[0] if isinstance(a, list) else a)
        return out

    def when(self, cond, props):
        if "OR" in cond:
            return any(self.when(c, props) for c in cond["OR"])
        if "AND" in cond:
            return all(self.when(c, props) for c in cond["AND"])
        return all(props.get(k) in str(v).split("|") for k, v in cond.items())

    def texture(self, textures, ref):
        seen = 0
        while ref.startswith("#"):
            ref = textures.get(ref[1:], "missingno")
            seen += 1
            if seen > 20:
                break
        return ref.replace("minecraft:", "")

    def use(self, tex, uv_size=16):
        """Register a texture (jar path under textures/, no extension) the scene draws."""
        if tex not in self.used:
            self.z.getinfo(f"assets/minecraft/textures/{tex}.png")  # raises if the jar has no such texture
            self.used[tex] = uv_size
        return tex

    def occludes(self, name, props, cache={}):
        """A full opaque cube: hides a neighbour's face turned towards it (the model's cullface)."""
        key = (name, tuple(sorted(props.items())))
        if key not in cache:
            full = False
            if name not in ("water", "lava") and not any(s in name for s in SEE_THROUGH):
                try:
                    for p in self.parts(name, props):
                        for el in self.model(p["model"])[1]:
                            if el["from"] == [0, 0, 0] and el["to"] == [16, 16, 16] and "rotation" not in el \
                                    and len(el.get("faces", {})) == 6:
                                full = True
                except KeyError:
                    pass
            cache[key] = full
        return cache[key]

    def block_faces(self, name, props):
        """Every face of one block in its cell (texels, 0..16), before culling."""
        tint = TINTS.get(name)
        glow = name in EMISSIVE
        faces = []
        for part in self.parts(name, props):
            textures, elements = self.model(part["model"])
            rx, ry, lock = part.get("x", 0), part.get("y", 0), part.get("uvlock", False)

            def turn(p):
                return rot(rot(p, "x", -rx), "y", -ry)

            for el in elements:
                f, t = el["from"], el["to"]
                r = el.get("rotation")
                for d, face in el.get("faces", {}).items():
                    verts = [tuple((f, t)[k[i]][i] for i in range(3)) for k in FACE_VERTS[d]]
                    normal = DIRS[d]
                    if r:
                        sc = 1 / math.cos(math.radians(r["angle"])) if r.get("rescale") else 1
                        o = r["origin"]

                        def erot(p):
                            q = rot(p, r["axis"], r["angle"], o)
                            return tuple(o[i] + (q[i] - o[i]) * (1 if "xyz"[i] == r["axis"] else sc) for i in range(3))

                        verts = [erot(v) for v in verts]
                        normal = rot(normal, r["axis"], r["angle"], (0, 0, 0))
                    verts = [turn(v) for v in verts]
                    normal = rot(rot(normal, "x", -rx, (0, 0, 0)), "y", -ry, (0, 0, 0))
                    fd = nearest_dir(normal)
                    if lock and (rx or ry):
                        uvs = [pos_uv(fd, v) for v in verts]
                    else:
                        uv = face.get("uv") or default_uv(d, f, t)
                        k = [(uv[0], uv[1]), (uv[0], uv[3]), (uv[2], uv[3]), (uv[2], uv[1])]
                        rr = face.get("rotation", 0) // 90
                        uvs = [k[(i + rr) % 4] for i in range(4)]
                    corners, uvr = uv_corners(verts, uvs)
                    cull = face.get("cullface")
                    if cull:
                        c = rot(rot(DIRS[cull], "x", -rx, (0, 0, 0)), "y", -ry, (0, 0, 0))
                        cull = nearest_dir(c)
                    tex = self.use(self.texture(textures, face["texture"]))
                    shaded = el.get("shade", True) and not glow
                    faces.append(Face(tex, corners, uvr, normal, shaded,
                                      tint if "tintindex" in face else None, glow,
                                      tuple(sum(v[i] for v in verts) / 4 for i in range(3)), cull))
        return faces


# --- what has no model: fluids and block entities ------------------------------------------------


def box_face(d, f, t, tex, uv, tint=None, glow=False):
    verts = [tuple((f, t)[k[i]][i] for i in range(3)) for k in FACE_VERTS[d]]
    k = [(uv[0], uv[1]), (uv[0], uv[3]), (uv[2], uv[3]), (uv[2], uv[1])]
    corners, uvr = uv_corners(verts, k)
    centre = tuple((f[i] + t[i]) / 2 for i in range(3))
    return Face(tex, corners, uvr, DIRS[d], not glow, tint, glow, centre, d)


def fluid_faces(jar, name, props, above_same):
    """Water and lava: the game's fluid renderer, reduced to a box of the fluid's height."""
    level = int(props.get("level", "0"))
    h = 16 if above_same else (8 / 9 * 16 if level == 0 or level >= 8 else (8 - level) / 9 * 16)
    glow = name == "lava"
    tex = jar.use("block/lava_still" if glow else "block/water_still")
    tint = None if glow else WATER
    out = []
    for d in DIRS:
        uv = [0, 0, 16, 16] if d in ("up", "down") else [0, 16 - h, 16, 16]
        out.append(box_face(d, (0, 0, 0), (16, h, 16), tex, uv, tint, glow))
    return out


def modelpart_box(tex, u, v, frm, size):
    """ModelPart.Cube: a box and its texture unwrap at (u, v), as entity models lay it out."""
    (x0, y0, z0), (w, h, d) = frm, size
    x1, y1, z1 = x0 + w, y0 + h, z0 + d
    f4, f5, f6, f7, f8, f9 = u, u + d, u + d + w, u + d + 2 * w, u + 2 * d + w, u + 2 * d + 2 * w
    f10, f11, f12 = v, v + d, v + d + h
    v7, v_, v1, v2 = (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)
    v3, v4, v5, v6 = (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)
    polys = [("down", [v4, v3, v7, v_], f5, f10, f6, f11), ("up", [v1, v2, v6, v5], f6, f11, f7, f10),
             ("west", [v7, v3, v6, v2], f4, f11, f5, f12), ("north", [v_, v7, v2, v1], f5, f11, f6, f12),
             ("east", [v4, v_, v1, v5], f6, f11, f8, f12), ("south", [v3, v4, v5, v6], f8, f11, f9, f12)]
    out = []
    for dname, vs, ua, va, ub, vb in polys:
        # Polygon: vertex 0 gets (u2,v1), 1 (u1,v1), 2 (u1,v2), 3 (u2,v2)
        out.append((dname, [vs[1], vs[0], vs[2]], [ua, va, ub, vb]))
    return out


def entity_faces(jar, parts, transform, shade=True):
    """Faces of entity-model boxes [(texture, uvSize, u, v, from, size)] under a vertex transform."""
    faces = []
    for tex, size, u, v, frm, sz in parts:
        jar.use(tex, size)
        centre = transform(tuple(frm[i] + sz[i] / 2 for i in range(3)))
        for dname, corners, uv in modelpart_box(tex, u, v, frm, sz):
            if uv[0] == uv[2] or uv[1] == uv[3]:
                continue
            cs = [transform(c) for c in corners]
            o = transform((0, 0, 0))
            n = tuple(a - b for a, b in zip(transform(DIRS[dname]), o))
            fd = nearest_dir(n)
            faces.append(Face(tex, cs, uv, n, shade, None, False, centre, None))
    return faces


FACING_YROT = {"south": 0, "west": 90, "north": 180, "east": 270}


def chest_faces(jar, name, props):
    tex = {"chest": "entity/chest/normal", "trapped_chest": "entity/chest/trapped", "ender_chest": "entity/chest/ender"}[name]
    yrot = FACING_YROT[props.get("facing", "north")]
    # ChestRenderer (1.16): bottom 14x10x14 at y 0, lid 14x5x14 at y 9, latch 2x4x1 at y 7 on +z;
    # turned about the block's centre by -facing.toYRot().
    parts = [(tex, 64, 0, 19, (1, 0, 1), (14, 10, 14)), (tex, 64, 0, 0, (1, 9, 1), (14, 5, 14)),
             (tex, 64, 0, 0, (7, 7, 15), (2, 4, 1))]
    return entity_faces(jar, parts, lambda p: rot(p, "y", -yrot))


def bed_faces(jar, name, props):
    tex = f"entity/bed/{name[:-4]}"
    head = props.get("part", "foot") == "head"
    yrot = FACING_YROT[props.get("facing", "north")]

    # BedRenderer.renderPiece: translate(0, 9/16, 0) . rotX(90) . [about the centre] rotZ(180 + yRot).
    def tf(p):
        q = rot(rot(p, "z", 180 + yrot), "x", 90, (0, 0, 0))
        return (q[0], q[1] + 9, q[2])

    # ponytail: the four 3x3x3 legs are left out (hidden under the frame at any icon size).
    part = (tex, 64, 0, 0, (0, 0, 0), (16, 16, 6)) if head else (tex, 64, 0, 22, (0, 0, 0), (16, 16, 6))
    return entity_faces(jar, [part], tf)


def bell_faces(jar, name, props):
    tex = "entity/bell/bell_body"
    # BellRenderer: body 6x7x6 from (5,6,5), its lip 8x2x8 from (4,4,4).
    return entity_faces(jar, [(tex, 32, 0, 0, (5, 6, 5), (6, 7, 6)), (tex, 32, 0, 13, (4, 4, 4), (8, 2, 8))], lambda p: p)


ENTITY = {"chest": chest_faces, "trapped_chest": chest_faces, "ender_chest": chest_faces, "bell": bell_faces}


# --- bake ----------------------------------------------------------------------------------------


def bake_blocks(jar, blocks, problems=None):
    """All faces of a scene, culled against full opaque neighbours, in block units."""
    out = []
    occ = {c: jar.occludes(n, p) for c, (n, p) in blocks.items()}
    for (x, y, z), (name, props) in sorted(blocks.items()):
        try:
            if name in ("water", "lava"):
                above = blocks.get((x, y + 1, z), ("",))[0] == name
                faces = fluid_faces(jar, name, props, above)
            else:
                faces = jar.block_faces(name, props)
                if name in ENTITY:
                    faces += ENTITY[name](jar, name, props)
                elif name.endswith("_bed"):
                    faces += bed_faces(jar, name, props)
        except KeyError as e:
            if problems is None:
                raise
            problems.setdefault(f"{name} {json.dumps(props, sort_keys=True)}", str(e))
            continue
        if not faces and name != "air" and problems is not None:
            problems.setdefault(name, "no geometry")
        glassy = any(s in name for s in ("glass", "ice")) and "pane" not in name
        for fc in faces:
            if fc.cull:
                dx, dy, dz = DIRS[fc.cull]
                nb = (x + dx, y + dy, z + dz)
                nname = blocks.get(nb, ("",))[0]
                if occ.get(nb) or ((name in ("water", "lava") or glassy) and nname == name):
                    continue
            out.append((x, y, z, fc))
    return out


HORIZ = {"north": (0, 0, -1), "east": (1, 0, 0), "south": (0, 0, 1), "west": (-1, 0, 0)}
CCW = {"north": "west", "west": "south", "south": "east", "east": "north"}
OPP = {"north": "south", "south": "north", "east": "west", "west": "east"}
NO_CONNECT = ("leaves", "barrier", "pumpkin", "jack_o_lantern", "melon", "shulker_box")


def update_shapes(jar, blocks):
    """What the game does to every block a template places (Block.updateFromNeighbourShapes):
    stairs take their corner shape and fences / panes / iron bars their arms from the neighbours.
    Templates store stale values (every shipwreck stair is outer_right, no fence has an arm).
    Walls keep the template's state."""
    def at(c, d):
        return blocks.get((c[0] + HORIZ[d][0], c[1], c[2] + HORIZ[d][2]))

    def stair(b):
        return b and b[0].endswith("_stairs")

    for c, (n, p) in list(blocks.items()):  # StairsBlock.getStairsShape
        if not n.endswith("_stairs"):
            continue
        f, half = p.get("facing", "north"), p.get("half", "bottom")

        def different(d):
            o = at(c, d)
            return not stair(o) or o[1].get("facing", "north") != f or o[1].get("half", "bottom") != half

        shape = "straight"
        front, back = at(c, f), at(c, OPP[f])
        if stair(front) and front[1].get("half", "bottom") == half:
            d1 = front[1].get("facing", "north")
            if d1 not in (f, OPP[f]) and different(OPP[d1]):
                shape = "outer_left" if d1 == CCW[f] else "outer_right"
        if shape == "straight" and stair(back) and back[1].get("half", "bottom") == half:
            d2 = back[1].get("facing", "north")
            if d2 not in (f, OPP[f]) and different(d2):
                shape = "inner_left" if d2 == CCW[f] else "inner_right"
        blocks[c] = (n, {**p, "shape": shape})

    def sturdy(b, d):  # b's face turned towards -d is a full face
        if not b or any(s in b[0] for s in NO_CONNECT):
            return False
        if b[0].endswith("_stairs"):
            return b[1].get("facing", "north") == OPP[d] and not b[1].get("shape", "").startswith("outer")
        return jar.occludes(*b)

    for c, (n, p) in list(blocks.items()):  # FenceBlock.connectsTo, PaneBlock.attachsTo
        fence = n.endswith("_fence")
        pane = n.endswith("_pane") or n == "iron_bars"
        if not (fence or pane):
            continue
        q = dict(p)
        for d in HORIZ:
            o = at(c, d)
            if fence:
                ok = bool(o) and (
                    (o[0].endswith("_fence") and (o[0] == "nether_brick_fence") == (n == "nether_brick_fence"))
                    or (o[0].endswith("_fence_gate") and o[1].get("facing", "north") not in (d, OPP[d]))
                )
            else:
                ok = bool(o) and (o[0].endswith("_pane") or o[0] == "iron_bars" or o[0].endswith("_wall"))
            q[d] = "true" if ok or sturdy(o, d) else "false"
        blocks[c] = (n, q)
    return blocks


def bake(spec, jar, spec_dir):
    tpl = spec.get("template")
    if tpl:
        if tpl.endswith((".json", ".nbt")) and not os.path.isabs(tpl):
            tpl = os.path.join(spec_dir, tpl)
        blocks, size = load_template(jar, tpl, spec.get("palette", 0))
    else:
        blocks, size = {}, [0, 0, 0]
    nudges = {}
    apply_edits(blocks, spec.get("edits", []), nudges)
    update_shapes(jar, blocks)
    textures, index, faces = [], {}, []
    bare = set((spec.get("outline") or {}).get("exclude", []))  # left out of the outline (the ground)
    for x, y, z, fc in bake_blocks(jar, blocks):
        nx, ny, nz = nudges.get((x, y, z), (0, 0, 0))  # drawn moved; culled and ordered by its cell
        if fc.tex not in index:
            index[fc.tex] = len(textures)
            textures.append({"src": f"minecraft/textures/{fc.tex}.png", "uv": jar.used[fc.tex]})
        d = {
            "t": index[fc.tex],
            "p": [[clean(x + nx + c[0] / 16), clean(y + ny + c[1] / 16), clean(z + nz + c[2] / 16)] for c in fc.corners],
            "uv": [clean(v) for v in fc.uv],
            "n": [clean(v) for v in fc.normal],
            "c": [x, y, z],
            "o": [clean(x + nx + fc.centre[0] / 16), clean(y + ny + fc.centre[1] / 16), clean(z + nz + fc.centre[2] / 16)],
        }
        if fc.tint:
            d["tint"] = fc.tint
        if not fc.shade:
            d["flat"] = 1
        if fc.glow:
            d["g"] = 1
        if blocks[(x, y, z)][0] in bare:
            d["bare"] = 1
        faces.append(d)
    for tex in index:  # the textures, raw bytes out of the jar
        dst = os.path.join(ASSETS, "minecraft", "textures", tex + ".png")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        data = jar.z.read(f"assets/minecraft/textures/{tex}.png")
        if not os.path.exists(dst) or open(dst, "rb").read() != data:
            with open(dst, "wb") as f:
                f.write(data)
    return {
        "name": spec.get("name"),
        "template": spec.get("template"),
        "size": size,
        "view": spec.get("view", {}),
        "background": spec.get("background", "none"),
        **({"outline": spec["outline"]} if spec.get("outline") else {}),
        "textures": textures,
        "faces": faces,
    }


def check(jar, paths):
    """Resolve every block of every template; print what does not resolve."""
    files = []
    for p in paths:
        files += sorted(glob.glob(os.path.join(p, "*.json")) + glob.glob(os.path.join(p, "*.nbt"))) if os.path.isdir(p) else [p]
    problems, total = {}, 0
    for f in files:
        blocks, _ = load_template(jar, f)
        total += len(blocks)
        before = len(problems)
        bake_blocks(jar, blocks, problems)
        print(f"{os.path.basename(f)}: {len(blocks)} blocks" + (f", {len(problems) - before} new unresolved" if len(problems) > before else ""))
    print(f"{len(files)} templates, {total} blocks, {len(problems)} unresolved states")
    for k, v in sorted(problems.items()):
        print(f"  UNRESOLVED {k}: {v}")
    return not problems


def selftest(jar):
    """The game's conventions this file depends on, checked against the jar's own models."""
    def box(name, props, sel=lambda f: True):
        pts = [c for f in jar.block_faces(name, props) if sel(f) for c in f.corners]
        return [min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)]

    # Variant y rotation: stairs facing south have their high step on the +z half.
    lo, hi = box("oak_stairs", {"facing": "south"}, lambda f: max(c[1] for c in f.corners) > 8.01)
    assert lo[2] >= 8 - 1e-6 and hi[2] == 16, (lo, hi)
    # Variant x rotation: a top-half stair hangs its step under the slab, on the east half.
    lo, hi = box("oak_stairs", {"facing": "east", "half": "top"}, lambda f: min(c[1] for c in f.corners) < 7.99)
    assert lo[0] >= 8 - 1e-6, (lo, hi)
    # Element rotation: a wall torch facing east hangs on the west wall and leans east.
    lo, hi = box("wall_torch", {"facing": "east"}, lambda f: f.normal[1] > 0.9)
    assert lo[0] > 0 and lo[1] > 10, (lo, hi)
    # Axis: a log along x has its rings on the east and west faces.
    ends = {nearest_dir(f.normal) for f in jar.block_faces("oak_log", {"axis": "x"}) if f.tex == "block/oak_log_top"}
    assert ends == {"east", "west"}, ends
    # Block entities: a chest facing east has its latch at the east edge.
    latch = [c for f in chest_faces(jar, "chest", {"facing": "east"}) if abs(f.centre[1] - 9) < 1e-6 for c in f.corners]
    assert min(c[0] for c in latch) > 15 - 1e-6 and max(c[0] for c in latch) < 16 + 1e-6, latch
    # BedRenderer's transform: the mattress top lies at 9/16.
    faces = bed_faces(jar, "red_bed", {"facing": "south", "part": "head"})
    top = next(f for f in faces if f.normal[1] > 0.9)
    assert abs(max(c[1] for c in top.corners) - 9) < 1e-6
    # Neighbour shapes: an L of stairs turns its corner; a fence reaches a fence and a plank, not air.
    s = update_shapes(jar, {(0, 0, 0): ("oak_stairs", {"facing": "north", "shape": "outer_right"}),
                            (0, 0, -1): ("oak_stairs", {"facing": "west", "shape": "outer_right"}),
                            (5, 0, 0): ("oak_fence", {}), (6, 0, 0): ("spruce_fence", {}),
                            (5, 0, 1): ("oak_planks", {})})
    assert s[(0, 0, 0)][1]["shape"] == "outer_left" and s[(0, 0, -1)][1]["shape"] == "straight", s
    assert (s[(5, 0, 0)][1]["east"], s[(5, 0, 0)][1]["south"], s[(5, 0, 0)][1]["west"]) == ("true", "true", "false")
    print("bake.py selftest: ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", nargs="*")
    ap.add_argument("--jar", default=DEFAULT_JAR)
    ap.add_argument("--out")
    ap.add_argument("--size", type=int)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    jar = Jar(ensure_jar(a.jar))
    if a.selftest:
        return selftest(jar)
    if a.check:
        sys.exit(0 if check(jar, a.spec) else 1)
    if len(a.spec) != 1:
        ap.error("one spec file")
    spec = json.load(open(a.spec[0]))
    spec.setdefault("name", os.path.splitext(os.path.basename(a.spec[0]))[0])
    if a.size:
        spec.setdefault("view", {})["size"] = a.size
    baked = bake(spec, jar, os.path.dirname(os.path.abspath(a.spec[0])))
    out = a.out or os.path.join(OUT_DIR, spec["name"] + ".json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w") as f:
        json.dump(baked, f, separators=(",", ":"))
    print(out)


if __name__ == "__main__":
    main()
