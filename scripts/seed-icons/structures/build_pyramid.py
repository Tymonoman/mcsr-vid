"""Author desert_pyramid.json by replaying 1.16.1 DesertPyramidPiece.postProcess (above ground, y>=0).

The game writes the piece in a local frame and, for the SOUTH orientation, mirrors
blockstates LEFT_RIGHT (so a stair coded FACING NORTH comes out facing +z). The JSON is
that local frame with the mirror applied: entrance at z=0, facings as they end up in the world.
"""
import json, os

W = D = 21
g = {}  # (x,y,z) -> (name, props)
MIRROR = {"north": "south", "south": "north"}

def put(name, x, y, z, **props):
    if y < 0:
        return  # underground (trap chamber) is never seen
    if "facing" in props:
        props["facing"] = MIRROR.get(props["facing"], props["facing"])
    if name == "air":
        g.pop((x, y, z), None)
    else:
        g[(x, y, z)] = (name, props)

def box(x0, y0, z0, x1, y1, z1, edge, inner):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            for z in range(z0, z1 + 1):
                inside = y not in (y0, y1) and x not in (x0, x1) and z not in (z0, z1)
                put(inner if inside else edge, x, y, z)

def stair(f):
    return dict(facing=f, half="bottom", shape="straight", waterlogged="false")

S, CUT, CH, O, B, AIR = "sandstone", "cut_sandstone", "chiseled_sandstone", "orange_terracotta", "blue_terracotta", "air"
ST = "sandstone_stairs"
N, So, E, Wd = stair("north"), stair("south"), stair("east"), stair("west")

box(0, -4, 0, W - 1, 0, D - 1, S, S)
for i in range(1, 10):
    box(i, i, i, W - 1 - i, i, D - 1 - i, S, S)
    box(i + 1, i, i + 1, W - 2 - i, i, D - 2 - i, AIR, AIR)
# towers
box(0, 0, 0, 4, 9, 4, S, AIR); box(1, 10, 1, 3, 10, 3, S, S)
put(ST, 2, 10, 0, **N); put(ST, 2, 10, 4, **So); put(ST, 0, 10, 2, **E); put(ST, 4, 10, 2, **Wd)
box(W - 5, 0, 0, W - 1, 9, 4, S, AIR); box(W - 4, 10, 1, W - 2, 10, 3, S, S)
put(ST, W - 3, 10, 0, **N); put(ST, W - 3, 10, 4, **So); put(ST, W - 5, 10, 2, **E); put(ST, W - 1, 10, 2, **Wd)
# entrance
box(8, 0, 0, 12, 4, 4, S, AIR); box(9, 1, 0, 11, 3, 4, AIR, AIR)
for x, y in [(9, 1), (9, 2), (9, 3), (10, 3), (11, 3), (11, 2), (11, 1)]:
    put(CUT, x, y, 1)
box(4, 1, 1, 8, 3, 3, S, AIR); box(4, 1, 2, 8, 2, 2, AIR, AIR)
box(12, 1, 1, 16, 3, 3, S, AIR); box(12, 1, 2, 16, 2, 2, AIR, AIR)
# hall floor, well opening, pillars
box(5, 4, 5, W - 6, 4, D - 6, S, S); box(9, 4, 9, 11, 4, 11, AIR, AIR)
for x, z in [(8, 8), (12, 8), (8, 12), (12, 12)]:
    box(x, 1, z, x, 3, z, CUT, CUT)
# side platforms and side doors
box(1, 1, 5, 4, 4, 11, S, S); box(W - 5, 1, 5, W - 2, 4, 11, S, S)
box(6, 7, 9, 6, 7, 11, S, S); box(W - 7, 7, 9, W - 7, 7, 11, S, S)
box(5, 5, 9, 5, 7, 11, CUT, CUT); box(W - 6, 5, 9, W - 6, 7, 11, CUT, CUT)
for x, y, z in [(5, 5, 10), (5, 6, 10), (6, 6, 10), (W - 6, 5, 10), (W - 6, 6, 10), (W - 7, 6, 10)]:
    put(AIR, x, y, z)
# tower stairways
box(2, 4, 4, 2, 6, 4, AIR, AIR); box(W - 3, 4, 4, W - 3, 6, 4, AIR, AIR)
put(ST, 2, 4, 5, **N); put(ST, 2, 3, 4, **N); put(ST, W - 3, 4, 5, **N); put(ST, W - 3, 3, 4, **N)
box(1, 1, 3, 2, 2, 3, S, S); box(W - 3, 1, 3, W - 2, 2, 3, S, S)
put(S, 1, 1, 2); put(S, W - 2, 1, 2)
put("sandstone_slab", 1, 2, 2, type="bottom", waterlogged="false"); put("sandstone_slab", W - 2, 2, 2, type="bottom", waterlogged="false")
put(ST, 2, 1, 2, **Wd); put(ST, W - 3, 1, 2, **E)
# side colonnades
box(4, 3, 5, 4, 3, 17, S, S); box(W - 5, 3, 5, W - 5, 3, 17, S, S)
box(3, 1, 5, 4, 2, 16, AIR, AIR); box(W - 6, 1, 5, W - 5, 2, 16, AIR, AIR)
for z in range(5, 18, 2):
    put(CUT, 4, 1, z); put(CH, 4, 2, z); put(CUT, W - 5, 1, z); put(CH, W - 5, 2, z)
# floor star
for x, z in [(10, 7), (10, 8), (9, 9), (11, 9), (8, 10), (12, 10), (7, 10), (13, 10), (9, 11), (11, 11), (10, 12), (10, 13)]:
    put(O, x, 0, z)
put(B, 10, 0, 10)
# tower patterns: rows y=2..8, (left, mid, right)
PAT = {2: (CUT, O, CUT), 3: (CUT, O, CUT), 4: (O, CH, O), 5: (CUT, O, CUT), 6: (O, CH, O), 7: (O, O, O), 8: (CUT, CUT, CUT)}
for x in (0, W - 1):
    for y, row in PAT.items():
        for dz, b in enumerate(row):
            put(b, x, y, 1 + dz)
for k in (2, W - 3):
    for y, row in PAT.items():
        for dx, b in enumerate(row):
            put(b, k - 1 + dx, y, 0)
# above the entrance
box(8, 4, 0, 12, 6, 0, CUT, CUT)
put(AIR, 8, 6, 0); put(AIR, 12, 6, 0)
put(O, 9, 5, 0); put(CH, 10, 5, 0); put(O, 11, 5, 0)

blocks = [[x, y, z, n, p] for (x, y, z), (n, p) in sorted(g.items(), key=lambda kv: (kv[0][1], kv[0][2], kv[0][0]))]
out = {
    "source": "authored: 1.16.1 net.minecraft.world.level.levelgen.structure.DesertPyramidPiece.postProcess replayed above ground "
              "(y>=0; the trap chamber below is omitted). Entrance at z=0 (front faces -z); SOUTH orientation, blockstates mirrored "
              "LEFT_RIGHT as the game does. Checked against minecraft.wiki Desert_Pyramid_JE2_BE2.png and Desert_pyramid_front.png.",
    "size": [W, 11, D],
    "blocks": blocks,
}
dst = os.path.join(os.path.dirname(__file__), "desert_pyramid.json")
json.dump(out, open(os.path.normpath(dst), "w"))
print(len(blocks), "blocks ->", os.path.normpath(dst))
