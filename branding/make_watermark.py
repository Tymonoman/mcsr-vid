"""MCSR Replayoffs video watermark (Studio > Customisation > Branding > Video watermark).

Badge drawn by /app/branding/generate_brand_assets.py's own render_badge_sprite (the Python twin
of remotion/pixelBadge.ts); plates are the overlay's .plate look (panel fill, quartz border, hard
panel-edge drop, no blur); text is Monocraft Bold with the house 8-way hard outline.

YouTube shows the 150x150 upload at 40x40 CSS px and 70% opacity (player CSS .iv-branding img
{opacity:.7}; featuredChannel.watermark width/height 40), 12px from the player's right/bottom
edge (24px fullscreen) with controls hidden. Everything is drawn at 4x (600px) and LANCZOS'd
down, as build_logo() does.
"""
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # importing must not drop a __pycache__ into /app
sys.path.insert(0, "/app/branding")
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
import generate_brand_assets as brand  # noqa: E402

OUT = Path(__file__).resolve().parent
S = 4                 # working scale
SIZE = 150 * S
DROP = 5 * S          # hard drop, right/down only (the .plate box-shadow, scaled)
BORDER = 6 * S        # quartz plate border: 1.6 px at the 40 px display size
PLATE = SIZE - DROP
ALPHA = 255


def font(px):
    return ImageFont.truetype(str(brand.FONT_PATH), px)


def plate(img, box, fill):
    """The .plate look: fill, quartz border, hard panel-edge drop to the bottom-right."""
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    d.rectangle([x0 + DROP, y0 + DROP, x1 + DROP, y1 + DROP], fill=(*brand.PANEL_EDGE, ALPHA))
    d.rectangle(box, fill=(*brand.QUARTZ, ALPHA))
    d.rectangle([x0 + BORDER, y0 + BORDER, x1 - BORDER, y1 - BORDER], fill=(*fill, ALPHA))


def text_centered(img, cx, cy, s, px, fill=brand.QUARTZ):
    """Monocraft Bold with the house 8-way hard outline + offset drop (.row1 .name's text-shadow)."""
    d = ImageDraw.Draw(img)
    f = font(px)
    l, t, r, b = d.textbbox((0, 0), s, font=f)
    x, y = cx - (r - l) / 2 - l, cy - (b - t) / 2 - t
    o = max(S, round(px * 0.07))
    d.text((x, y + o * 2), s, font=f, fill=(0, 0, 0, 115))  # 0 7px 0 rgba(0,0,0,.45), scaled
    for dx in (-o, 0, o):
        for dy in (-o, 0, o):
            if dx or dy:
                d.text((x + dx, y + dy), s, font=f, fill=(*brand.PANEL_EDGE, ALPHA))
    d.text((x, y), s, font=f, fill=(*fill, ALPHA))


def badge(img, cx, cy, px_per_cell):
    sprite = brand.render_badge_sprite(px_per_cell)
    img.alpha_composite(sprite, (cx - sprite.width // 2, cy - sprite.height // 2))


def fit_px(s, width):
    """Largest Monocraft size whose advance (720/1080 em, monospaced) fits `width`."""
    return int(width / (len(s) * 720 / 1080))


def v_badge():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    plate(img, (0, 0, PLATE - 1, PLATE - 1), brand.PANEL_2)
    badge(img, PLATE // 2, PLATE // 2, 8)  # 512 px ring in a 532 px well
    return img


def v_badge_sub():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    plate(img, (0, 0, PLATE - 1, PLATE - 1), brand.PANEL_2)
    strip_h = 168
    strip_y = PLATE - BORDER - strip_h
    d = ImageDraw.Draw(img)
    d.rectangle([BORDER, strip_y, PLATE - 1 - BORDER, PLATE - 1 - BORDER], fill=(*brand.CRIMSON, ALPHA))
    d.rectangle([BORDER, strip_y - BORDER // 2, PLATE - 1 - BORDER, strip_y - 1], fill=(*brand.QUARTZ, ALPHA))
    inner_w = PLATE - 2 * BORDER - 2 * 18
    text_centered(img, PLATE // 2, strip_y + strip_h // 2, "SUBSCRIBE", fit_px("SUBSCRIBE", inner_w))
    well = strip_y - BORDER // 2 - BORDER
    badge(img, PLATE // 2, BORDER + well // 2, 5)  # 320 px ring in the 352 px well
    return img


def v_subscribe():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    plate(img, (0, 0, PLATE - 1, PLATE - 1), brand.CRIMSON)
    inner_w = PLATE - 2 * BORDER - 2 * 22
    px = fit_px("SCRIBE", inner_w)
    mid = PLATE // 2
    text_centered(img, mid, mid - px * 0.52, "SUB", px)
    text_centered(img, mid, mid + px * 0.52, "SCRIBE", px)
    return img


VARIANTS = {"badge": v_badge, "badge-sub": v_badge_sub, "subscribe": v_subscribe}


# ---------- previews ----------
def shown(wm, css_px, scale=1):
    """The watermark as the player draws it: css_px square (x DPR), 70% opacity."""
    w = wm.resize((css_px * scale, css_px * scale), Image.LANCZOS)
    a = w.getchannel("A").point(lambda v: int(v * 0.7))
    w.putalpha(a)
    return w


def player(frame, w, wm, css_px=40, inset=12, dpr=1):
    """Frame scaled to a w-wide 16:9 player at `dpr`, watermark at YouTube's spot (controls hidden)."""
    W, H = w * dpr, w * 9 // 16 * dpr
    p = frame.resize((W, H), Image.LANCZOS).convert("RGBA")
    m = shown(wm, css_px, dpr)
    p.alpha_composite(m, (W - inset * dpr - m.width, H - inset * dpr - m.height))
    return p.convert("RGB")


def label(img, s, x=0, y=0):
    d = ImageDraw.Draw(img)
    f = font(14)
    d.rectangle([x, y, x + d.textlength(s, font=f) + 10, y + 20], fill=brand.PANEL_EDGE)
    d.text((x + 5, y + 2), s, font=f, fill=brand.QUARTZ)


def preview(name, wm, frame):
    """One sheet: the 1280x720 desktop player at true size, a 3x zoom of its corner, the
    1920 fullscreen corner, a phone (390 CSS px player, DPR 3) corner, and light/dark swatches."""
    desk = player(frame, 1280, wm)
    sheet = Image.new("RGB", (1280, 720 + 380), brand.PANEL_EDGE)
    sheet.paste(desk, (0, 0))
    label(sheet, f"{name}: 1280x720 desktop player, 40 px @ 70%, true size")

    zoom = desk.crop((1280 - 200, 720 - 120, 1280, 720)).resize((600, 360), Image.NEAREST)
    sheet.paste(zoom, (0, 730))
    full = player(frame, 1920, wm, inset=24).crop((1920 - 300, 1080 - 180, 1920, 1080))
    sheet.paste(full, (610, 730))
    phone = player(frame, 390, wm, css_px=12, dpr=3)  # proportional to the 1280 player: 40/1280*390
    pc = phone.crop((phone.width - 360, phone.height - 180, phone.width, phone.height))
    sheet.paste(pc, (920, 730))

    # light/dark: 40 px and 80 px (2x DPR) on white, mid-grey, black and a bright footage patch
    x = 610
    y = 730 + 190
    bright = frame.resize((1920, 1080)).crop((1100, 250, 1240, 390))
    for bg in [(255, 255, 255), (128, 128, 128), (0, 0, 0), None]:
        tile = bright.resize((140, 160)) if bg is None else Image.new("RGB", (140, 160), bg)
        t = tile.convert("RGBA")
        t.alpha_composite(shown(wm, 40), (8, 8))
        t.alpha_composite(shown(wm, 40, 2), (52, 72))
        sheet.paste(t.convert("RGB"), (x, y)); x += 150
    label(sheet, "3x zoom, desktop corner", 0, 730)
    label(sheet, "fullscreen 1920", 610, 730)
    label(sheet, "phone, 1:1 device px", 920, 730)
    label(sheet, "40 px and 80 px (2x DPR) on white / grey / black / footage", 610, 1080)
    sheet.save(OUT / f"preview-{name}.jpg", quality=92)


# Where the watermark lands on the 1920x1080 stage, per player width (CSS px) and state. The
# player draws it 40 CSS px square at `inset` from the right edge and `bottom` from the bottom
# (player CSS: .ytp-iv-player-content right 12/24, bottom 12/24 hidden, controls height + 14 shown).
FOOTPRINTS = [  # (label, player width, inset, bottom)
    ("1280 hidden", 1280, 12, 12),
    ("1280 controls", 1280, 12, 86),
    ("fullscreen hidden", 1920, 24, 24),
    ("fullscreen controls", 1920, 24, 110),
    ("854 hidden", 854, 12, 12),
    ("854 controls", 854, 12, 86),
]
TIMER = (1518, 892, 1836, 936)  # gold RTA figure "4:53.967", measured off final-14037392.mp4


def footprints():
    out = []
    for name, w, inset, bottom in FOOTPRINTS:
        k = 1920 / w
        x1, y1 = 1920 - inset * k, 1080 - bottom * k
        out.append((name, round(x1 - 40 * k), round(y1 - 40 * k), round(x1), round(y1)))
    return out


def footprint_sheet(frame):
    img = frame.copy()
    d = ImageDraw.Draw(img)
    d.rectangle(TIMER, outline=brand.WARPED, width=2)
    for name, *box in footprints():
        d.rectangle(box, outline=brand.CRIMSON if "controls" in name else brand.QUARTZ, width=2)
    img.crop((1440, 734, 1920, 1080)).resize((960, 692), Image.NEAREST).save(OUT / "footprint.jpg", quality=92)


if __name__ == "__main__":
    frame = Image.open(OUT / "frame-300-1080.png").convert("RGB")
    for name, make in VARIANTS.items():
        big = make()
        assert big.getpixel((SIZE - 1, 0))[3] == 0 and big.getpixel((0, SIZE - 1))[3] == 0, "corners must be clear"
        wm = big.resize((150, 150), Image.LANCZOS)
        path = OUT / f"watermark-{name}.png"
        wm.save(path, optimize=True)
        assert path.stat().st_size < 1_000_000
        preview(name, wm, frame)
        print(path, path.stat().st_size, "bytes")
    footprint_sheet(frame)
    for name, *box in footprints():
        clear = box[0] > TIMER[2] or box[1] > TIMER[3] or box[3] < TIMER[1]
        print(f"{name:20} x {box[0]}-{box[2]} y {box[1]}-{box[3]}  {'clear of timer' if clear else 'OVERLAPS timer'}")
