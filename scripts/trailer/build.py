#!/usr/bin/env python3
"""Build the channel trailer: a 45-60 s montage of moments cut from exported long-forms.

The operator, 22 Oct 2026: "you can draft some insane finishes or moment into a clip as a channel
trailer". Each segment is lifted from a match's own export (final-<id>.mp4, overlay and splits
included: that IS the channel's look), the pair + what is happening on a plate for the first
seconds, game audio normalised (no music), 0.3 s cross-cuts, then the end card. Finishes are
allowed; a caption never names a winner, a score, a nickname, elo or a rank. Cut a finish before
the game's own Victory/Defeat screen.

Spec (JSON; from/to are MATCH seconds, 0 = match start, same clock as the RTA column):
  { "segments": [ {"matchId": 13906935, "from": 578.5, "to": 584.3, "pov": "both",
                   "caption": "HACKINGNOISES vs ROMUXII · 4.2 SECONDS BETWEEN THEM"} ],
    "endCard": {"line1": "every big MCSR Ranked match, both POVs, same day",
                "line2": "new matches every day · subscribe"},
    "out": "/path/trailer.mp4" }
"pov": "both" keeps the whole frame; "left"/"right" fills the frame with that POV's game half.

  python3 scripts/trailer/build.py spec.json        # out + out's check-sheet.png
  python3 scripts/trailer/build.py --selftest
"""
import json, os, subprocess, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hand-short"))
from build import BOLD, EDGE, EDGE_L, GOLD, PANEL, QUARTZ, plate, run  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

W, H = 1920, 1080
FPS, CUT, CAPTION_SEC, END_SEC = 60, 0.3, 3.5, 5.0
LOGO = "/app/branding/logo.png"
# The export's frame at 1920x1080: identity band 0-194, both games 194-733 (960 wide each), splits below.
GAME_TOP, GAME_H = 194, 539


def source(mid):
    for root in ("/media", "/archive"):  # freeLocalCopies moves a public match's export to the NAS
        p = f"{root}/{mid}/final-{mid}.mp4"
        if os.path.exists(p):
            return p
    raise SystemExit(f"no final-{mid}.mp4 under /media or /archive")


def match_start(mid):
    for root in ("/media", "/archive"):
        p = f"{root}/{mid}/final-{mid}.json"
        if os.path.exists(p):
            return float(json.load(open(p))["matchStartSec"])
    return 10.0  # exportMatchStartSec's own fallback without a record


def offsets(durations, cut=CUT):
    """xfade offsets: segment i starts fading in `cut` before the previous one ends."""
    out, total = [], 0.0
    for d in durations[:-1]:
        total += d - cut
        out.append(round(total, 3))
    return out


def end_card(spec, path):
    im = Image.new("RGBA", (W, H), PANEL + (255,))
    d = ImageDraw.Draw(im)
    cs = 40
    for y in range(0, H, cs):
        for x in range(0, W, cs):
            if (x // cs + y // cs) % 2 == 0:
                d.rectangle([x, y, x + cs - 1, y + cs - 1], fill=(0x27, 0x24, 0x2D, 255))
    logo = Image.open(LOGO).convert("RGBA").resize((300, 300), Image.NEAREST)
    im.alpha_composite(logo, ((W - 300) // 2, 150))

    def ctext(y, text, size, fill):
        f = ImageFont.truetype(BOLD, size)
        while f.getbbox(text)[2] > W - 160 and size > 24:
            size -= 2
            f = ImageFont.truetype(BOLD, size)
        l, t, r, b = f.getbbox(text)
        x = (W - (r - l)) // 2 - l
        d.text((x + 5, y + 5), text, font=f, fill=EDGE + (255,))
        d.text((x, y), text, font=f, fill=fill + (255,))

    ctext(500, "MCSR REPLAYOFFS", 80, QUARTZ)
    ctext(650, spec["endCard"]["line1"], 44, GOLD)
    ctext(740, spec["endCard"]["line2"], 40, QUARTZ)
    im.save(path)


def segment(seg, i, tmp):
    src, dur = source(seg["matchId"]), seg["to"] - seg["from"]
    plate(seg["caption"], 56, QUARTZ, EDGE_L, f"{tmp}/cap{i}.png", pad=(26, 16), shadow=8, bw=5, max_w=1800)
    pov = seg.get("pov", "both")
    if pov == "both":
        pre = f"scale={W}:{H}:flags=lanczos"
    else:  # the game half, in the export's own pixels: 1080p or the 1440p upscale (iw/1920)
        x = 0 if pov == "left" else "iw/2"
        pre = f"crop=iw/2:{GAME_H}*iw/1920:{x}:{GAME_TOP}*iw/1920,scale={W}:{H}:flags=lanczos"
    graph = (f"[0:v]{pre},fps={FPS}[g];[g][1:v]overlay=(W-w)/2:590:enable='lt(t,{CAPTION_SEC})',format=yuv420p[v];"
             f"[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[a]")
    out = f"{tmp}/seg{i}.mkv"
    run(["ffmpeg", "-v", "error", "-y", "-ss", str(match_start(seg["matchId"]) + seg["from"]), "-t", str(dur), "-i", src,
         "-i", f"{tmp}/cap{i}.png", "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", str(dur),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "pcm_s16le", out])
    return out, dur


def build(spec):
    out = spec["out"]
    with tempfile.TemporaryDirectory() as tmp:
        parts = [segment(s, i, tmp) for i, s in enumerate(spec["segments"])]
        end_card(spec, f"{tmp}/end.png")
        n = len(parts)
        inputs = [a for p, _ in parts for a in ("-i", p)]
        inputs += ["-loop", "1", "-framerate", str(FPS), "-t", str(END_SEC), "-i", f"{tmp}/end.png",
                   "-f", "lavfi", "-t", str(END_SEC), "-i", "anullsrc=r=48000:cl=stereo"]
        durs = [d for _, d in parts] + [END_SEC]
        offs = offsets(durs)
        # every xfade input on one timebase (mkv 1/1000, png 1/60 and the xfade chain's own differ)
        g = [f"[{i}:v]format=yuv420p,fps={FPS},settb=AVTB[s{i}]" for i in range(n + 1)]
        v, a = "[s0]", "[0:a]"
        for i in range(1, n + 1):
            nv = f"[s{i}]"
            na = f"[{i}:a]" if i < n else f"[{n + 1}:a]"
            g.append(f"{v}{nv}xfade=transition=fade:duration={CUT}:offset={offs[i - 1]}[v{i}]")
            g.append(f"{a}{na}acrossfade=d={CUT}[a{i}]")
            v, a = f"[v{i}]", f"[a{i}]"
        run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(g), "-map", v, "-map", a,
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(FPS), "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out])
    # check sheet: the middle of every segment, then the end card
    mids = [(offs[i - 1] if i else 0) + durs[i] / 2 for i in range(n)] + [offs[-1] + END_SEC - 0.5]
    sel = "+".join(f"eq(n\\,{int(t * FPS)})" for t in mids)
    cols = min(4, len(mids))
    sheet = os.path.join(os.path.dirname(out), "check-sheet.png")
    run(["ffmpeg", "-v", "error", "-y", "-i", out, "-vf", f"select='{sel}',scale=480:270,tile={cols}x{-(-len(mids) // cols)}",
         "-frames:v", "1", "-vsync", "vfr", sheet])
    total = sum(durs) - CUT * n
    print(f"built {out} ({total:.1f} s, {n} segments) and {sheet}")


def selftest():
    assert offsets([6.0, 6.0, 5.0]) == [5.7, 11.4]
    assert offsets([10.0]) == []
    print("ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit()
    spec = json.load(open(sys.argv[1]))
    assert spec.get("segments") and spec.get("endCard") and spec.get("out"), "spec needs segments, endCard, out"
    for s in spec["segments"]:
        assert s.get("pov", "both") in ("left", "right", "both") and 2 <= s["to"] - s["from"] <= 15, f"bad segment {s}"
        assert s["caption"] == s["caption"].strip() and " vs " in s["caption"], f"caption must read 'A vs B · what': {s}"
    build(spec)
