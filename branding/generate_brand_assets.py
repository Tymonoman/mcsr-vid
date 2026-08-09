"""Channel logo/banner for MCSR RePlayoffs: the same pixel-art replay ring
as remotion/pixelBadge.ts, rendered with the project's actual Monocraft font
and --panel-2/--panel-edge-light/--gold/--quartz palette, so the channel art
matches the video overlay exactly rather than approximating it."""
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

BADGE_N = 32
GAP_START, GAP_END = 300, 345


def build_ring_cells(n=BADGE_N):
    """Same geometry as remotion/pixelBadge.ts's buildBadgeRingCells."""
    cells = []
    c = (n - 1) / 2
    outer_r = n * 0.46
    inner_r = n * 0.3
    for y in range(n):
        for x in range(n):
            dx, dy = x - c, y - c
            dist = math.hypot(dx, dy)
            if dist < inner_r or dist > outer_r:
                continue
            ang = (math.degrees(math.atan2(dy, dx)) + 360) % 360
            if GAP_START <= ang <= GAP_END:
                continue
            cells.append((x, y, WARPED if x < c else CRIMSON))
    tail_r = outer_r + 2
    for ang in (GAP_START - 6, GAP_START - 3, GAP_END + 3, GAP_END + 6):
        rad = math.radians(ang)
        x = round(c + tail_r * math.cos(rad))
        y = round(c + tail_r * math.sin(rad))
        if 0 <= x < n and 0 <= y < n:
            cells.append((x, y, WARPED if x < c else CRIMSON))
    return cells


def render_badge_sprite(px_per_cell):
    """Ring, upscaled to real pixels via NEAREST (crisp blocky edges), with
    the actual Monocraft 'MCSR' centered on top via real font rendering."""
    size = BADGE_N * px_per_cell
    grid = Image.new("RGBA", (BADGE_N, BADGE_N), (0, 0, 0, 0))
    for x, y, color in build_ring_cells():
        grid.putpixel((x, y), (*color, 255))
    sprite = grid.resize((size, size), Image.NEAREST)

    draw = ImageDraw.Draw(sprite)
    font_size = int(size * 0.155)
    font = ImageFont.truetype(FONT_PATH, font_size)
    text = "MCSR"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((size / 2 - tw / 2 - bbox[0], size / 2 - th / 2 - bbox[1]), text, font=font, fill=(*QUARTZ, 255))
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
    frame = badge_with_frame(px_per_cell=size // BADGE_N // 1, border_px=max(4, size // 130))
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

    badge = badge_with_frame(px_per_cell=11, border_px=5)
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
