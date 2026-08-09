"""Channel logo/banner for MCSR Replayoffs: the same pixel-art replay/
refresh ring as remotion/pixelBadge.ts, rendered with the project's actual
Monocraft font and --panel-2/--panel-edge-light/--gold/--quartz palette, so
the channel art matches the video overlay exactly rather than approximating
it."""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = Path(__file__).resolve().parent.parent / "remotion/assets/fonts/Monocraft-Bold.ttf"

PANEL_EDGE = (13, 12, 16)       # --panel-edge, outermost background
PANEL_2 = (26, 24, 32)          # --panel-2, badge container fill
PANEL_EDGE_LIGHT = (60, 56, 68)  # --panel-edge-light, badge container border
CRIMSON = (226, 72, 63)         # --crimson
WARPED = (53, 214, 196)         # --warped
GOLD = (240, 201, 61)           # --gold
QUARTZ = (243, 237, 226)        # --quartz
QUARTZ_SHADE = tuple(int(v * 0.4) for v in QUARTZ)  # darker shade of QUARTZ, not flat black -> 3D bevel

BADGE_N = 64

# Two gaps (each with an arrowhead at its end), rotated 180 degrees from
# each other for perfect 2-fold symmetry -- the classic refresh/sync icon.
GAP1 = (300, 345)
GAP2 = (120, 165)
ARROW_SPAN = 30
ARROW_BULGE = 2.2


def build_ring_cells(n=BADGE_N):
    """Same geometry as remotion/pixelBadge.ts's buildBadgeRingCells."""
    c = (n - 1) / 2
    outer_r = n * 0.46
    inner_r = n * 0.3
    mid_r = (inner_r + outer_r) / 2
    half_thickness = (outer_r - inner_r) / 2

    def in_gap(ang, gap):
        return gap[0] <= ang <= gap[1]

    def in_arc1(ang):
        return ang > GAP1[1] or ang < GAP2[0]

    def arrow_wedge(ang, dist, gap_end):
        arrow_start = gap_end - ARROW_SPAN
        if not (arrow_start < ang <= gap_end):
            return False
        t = (gap_end - ang) / ARROW_SPAN  # 0 at the ring join, 1 at the tip
        half = half_thickness * ARROW_BULGE * (1 - t)
        return mid_r - half <= dist <= mid_r + half

    cells = []
    for y in range(n):
        for x in range(n):
            dx, dy = x - c, y - c
            dist = math.hypot(dx, dy)
            ang = (math.degrees(math.atan2(dy, dx)) + 360) % 360

            in_ring = inner_r <= dist <= outer_r and not in_gap(ang, GAP1) and not in_gap(ang, GAP2)
            in_arrow1 = arrow_wedge(ang, dist, GAP1[1])
            in_arrow2 = arrow_wedge(ang, dist, GAP2[1])
            if not (in_ring or in_arrow1 or in_arrow2):
                continue

            arc1 = in_arrow1 or (in_ring and in_arc1(ang))
            cells.append((x, y, CRIMSON if arc1 else WARPED))
    return cells


def _draw_monogram(sprite, sprite_size):
    """MC/SR monogram: a 2x2 grid of square cells (each letter horizontally
    stretched to roughly match its own height), slightly overlapping so the
    outlines fuse into one block, sized to sit on top of the ring rather
    than confined inside its empty center. Outline is a darker shade of the
    fill color (not flat black) for a subtle 3D-bevel look."""
    font_size = int(sprite_size * 0.34)
    font = ImageFont.truetype(str(FONT_PATH), font_size)
    outline_w = max(2, int(font_size * 0.09))
    pad = 2

    def render_char(ch):
        probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        bbox = probe.textbbox((0, 0), ch, font=font, stroke_width=outline_w)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        layer = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
        ldraw = ImageDraw.Draw(layer)
        ldraw.text(
            (pad - bbox[0], pad - bbox[1]), ch, font=font, fill=(*QUARTZ, 255),
            stroke_width=outline_w, stroke_fill=(*QUARTZ_SHADE, 255),
        )
        return layer

    glyphs = {ch: render_char(ch) for ch in "MCSR"}
    cell = max(im.height for im in glyphs.values())  # square cell = tallest natural glyph height
    glyphs = {ch: im.resize((cell, cell), Image.NEAREST) for ch, im in glyphs.items()}

    gap = -int(outline_w * 0.8)  # slight negative gap so outlines overlap and fuse
    block = cell * 2 + gap
    x0 = int(sprite_size / 2 - block / 2)
    y0 = int(sprite_size / 2 - block / 2)

    positions = {
        "M": (x0, y0), "C": (x0 + cell + gap, y0),
        "S": (x0, y0 + cell + gap), "R": (x0 + cell + gap, y0 + cell + gap),
    }
    for ch, (px, py) in positions.items():
        sprite.paste(glyphs[ch], (px, py), glyphs[ch])


def render_badge_sprite(px_per_cell):
    """Ring, upscaled to real pixels via NEAREST (crisp blocky edges), with
    the MC/SR monogram on top via real Monocraft font rendering."""
    size = BADGE_N * px_per_cell
    grid = Image.new("RGBA", (BADGE_N, BADGE_N), (0, 0, 0, 0))
    for x, y, color in build_ring_cells():
        grid.putpixel((x, y), (*color, 255))
    sprite = grid.resize((size, size), Image.NEAREST)
    _draw_monogram(sprite, size)
    return sprite


def badge_with_frame(px_per_cell, border_px):
    """The badge sprite inside the same panel-2/panel-edge-light container
    the video overlay's .badge div uses, so it reads identically."""
    inner = render_badge_sprite(px_per_cell)
    pad = int(inner.width * 0.19)  # svg is 62% of its container in CSS
    frame_size = inner.width + pad * 2
    frame = Image.new("RGB", (frame_size, frame_size), PANEL_2)
    draw = ImageDraw.Draw(frame)
    draw.rectangle([0, 0, frame_size - 1, frame_size - 1], outline=PANEL_EDGE_LIGHT, width=border_px)
    frame.paste(inner, (pad, pad), inner)
    return frame


def build_logo(path, size=800):
    frame = badge_with_frame(px_per_cell=max(1, size // BADGE_N), border_px=max(4, size // 130))
    frame = frame.resize((size, size), Image.LANCZOS if frame.width != size else Image.NEAREST)
    canvas = Image.new("RGB", (size, size), PANEL_EDGE)
    canvas.paste(frame, ((size - frame.width) // 2, (size - frame.height) // 2))
    canvas.save(path)


def build_banner(path, w=2560, h=1440):
    img = Image.new("RGB", (w, h), PANEL_EDGE)
    draw = ImageDraw.Draw(img)

    corner = Image.new("RGB", (w, h), PANEL_EDGE)
    cdraw = ImageDraw.Draw(corner)
    cdraw.polygon([(-200, -200), (500, -200), (-200, 500)], fill=CRIMSON)
    cdraw.polygon([(w + 200, h + 200), (w - 500, h + 200), (w + 200, h - 500)], fill=WARPED)
    img = Image.blend(img, corner, 0.08)
    draw = ImageDraw.Draw(img)

    badge = badge_with_frame(px_per_cell=6, border_px=5)
    badge_x, badge_y = 560, 570
    img.paste(badge, (badge_x, badge_y))

    text_x = badge_x + badge.width + 60
    word_font = ImageFont.truetype(FONT_PATH, 128)
    tag_font = ImageFont.truetype(FONT_PATH, 40)

    word_y = 630
    draw.text((text_x, word_y), "REPLAYOFFS", font=word_font, fill=QUARTZ)
    word_bbox = draw.textbbox((text_x, word_y), "REPLAYOFFS", font=word_font)

    tag_y = word_bbox[3] + 26
    draw.text((text_x, tag_y), "MCSR RANKED · TOP-BRACKET REPLAYS", font=tag_font, fill=GOLD)
    tag_bbox = draw.textbbox((text_x, tag_y), "MCSR RANKED · TOP-BRACKET REPLAYS", font=tag_font)

    div_y = tag_bbox[3] + 30
    div_w = 1420
    draw.rectangle([badge_x, div_y, badge_x + div_w // 2, div_y + 6], fill=CRIMSON)
    draw.rectangle([badge_x + div_w // 2, div_y, badge_x + div_w, div_y + 6], fill=WARPED)

    img.save(path)


if __name__ == "__main__":
    out_dir = Path(__file__).resolve().parent
    build_logo(str(out_dir / "logo.png"))
    build_banner(str(out_dir / "banner.png"))
    print("done")
