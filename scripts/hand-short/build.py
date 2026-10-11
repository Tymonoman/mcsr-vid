#!/usr/bin/env python3
"""Build a hand-made, branded Short from a spec the session writes after watching the match.

The operator, 11 Oct 2026: "you're gonna make the shorts from now on" — the session watches each
match, picks the moment and the words itself; this script only assembles the result the same way
every time, from the match's own overlay renders (so the look is the long-form's, not a copy):

  - the player's nameplate band: the crimson (left) or warped (right) half of overlay-top.png
  - the MC/SR badge from the same band
  - the gold RTA clock: overlay-timer.mp4, whose timeline is match time + 10 s (ANCHOR_SEC)
  - hook / turn / captions on the channel's plates (Monocraft, --panel fill, hard pixel shadow)
  - an end slate: checker, badge, MCSR REPLAYOFFS, the question in gold, FULL MATCH ON THE CHANNEL

Layout (1080x1920): band 0-114, face cam 114-600, game 600-1920; clock on the face cam's left
wall, badge at its top right; captions at y 1340 (or 1650 when a dialog fills the middle).
YouTube's own Shorts UI covers the top-right corner, a column on the right and the bottom ~20%,
so nothing important is placed there.

Spec (JSON):
  { "matchId": 14074004, "nickname": "silverrruns", "side": "left",
    "fromSec": 104, "toSec": 126,                 # match time
    "faceCrop": [2, 455, 540, 243],                # x y w h in the 1920x1080 POV clip (aspect 2.222)
    "gameX": 542, "gameW": 876,                    # horizontal crop of the game, full height
    "hook": "HE WAS WINNING...", "hookTo": 3.2,
    "turn": {"text": "EVERYTHING. GONE.", "from": 10.0, "to": 12.4},
    "captions": [{"text": "OH MY GOD", "from": 6.6, "to": 7.5, "low": false}],
    "mute": [[16.36, 16.66]],
    "endQuestion": "CAN HE STILL WIN?", "endFrom": 19.0,
    "out": "/path/short.mp4" }
Times in hook/turn/captions/mute/endFrom are seconds into the Short (0 = fromSec).

  python3 scripts/hand-short/build.py spec.json            # build out + out.beats.png
  python3 scripts/hand-short/build.py spec.json --words    # word timings of the window (Groq Whisper)
"""
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFont

BOLD = "/app/remotion/assets/fonts/Monocraft-Bold.ttf"
PANEL, EDGE, EDGE_L = (0x22, 0x1F, 0x27), (0x0D, 0x0C, 0x10), (0x3C, 0x38, 0x44)
CRIMSON, GOLD, QUARTZ = (0xE2, 0x48, 0x3F), (0xF0, 0xC9, 0x3D), (0xF3, 0xED, 0xE2)
W, H = 1080, 1920
ANCHOR_SEC = 10  # overlay-timer.mp4 / the Kdenlive timeline: match start is at 10 s


def run(cmd):
    subprocess.run(cmd, check=True)


def plate(text, size, fg, border, path, pad=(30, 18), shadow=8, bw=6, max_w=1000):
    f = ImageFont.truetype(BOLD, size)
    while f.getbbox(text)[2] + 2 * pad[0] + 2 * bw > max_w and size > 30:
        size -= 2
        f = ImageFont.truetype(BOLD, size)
    l, t, r, b = f.getbbox(text)
    w, h = r - l + 2 * pad[0] + 2 * bw, b - t + 2 * pad[1] + 2 * bw
    im = Image.new("RGBA", (w + shadow, h + shadow), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([shadow, shadow, w - 1 + shadow, h - 1 + shadow], fill=EDGE + (255,))
    d.rectangle([0, 0, w - 1, h - 1], fill=border + (255,))
    d.rectangle([bw, bw, w - 1 - bw, h - 1 - bw], fill=PANEL + (255,))
    tx, ty = bw + pad[0] - l, bw + pad[1] - t
    d.text((tx + 4, ty + 4), text, font=f, fill=EDGE + (255,))
    d.text((tx, ty), text, font=f, fill=fg + (255,))
    im.save(path)


def brand(spec, mdir, tmp):
    top = Image.open(os.path.join(mdir, "overlay-top.png")).convert("RGBA")  # 1920x194
    half = (0, 0, 870, 92) if spec["side"] == "left" else (1050, 0, 1920, 92)
    top.crop(half).resize((W, round(92 * W / 870)), Image.NEAREST).save(f"{tmp}/band.png")
    top.crop((878, 6, 1042, 168)).resize((150, 148), Image.NEAREST).save(f"{tmp}/badge.png")
    plate(spec["hook"], 70, QUARTZ, CRIMSON, f"{tmp}/hook.png")
    if spec.get("turn"):
        plate(spec["turn"]["text"], 74, CRIMSON, EDGE_L, f"{tmp}/turn.png")
    for i, c in enumerate(spec.get("captions", [])):
        plate(c["text"], 50, QUARTZ, EDGE_L, f"{tmp}/cap{i}.png", pad=(22, 14), shadow=6, bw=4, max_w=880)
    end = Image.new("RGBA", (W, H), PANEL + (255,))
    d = ImageDraw.Draw(end)
    cs = 40
    for y in range(0, H, cs):
        for x in range(0, W, cs):
            if (x // cs + y // cs) % 2 == 0:
                d.rectangle([x, y, x + cs - 1, y + cs - 1], fill=(0x27, 0x24, 0x2D, 255))
    end.alpha_composite(top.crop((878, 6, 1042, 168)).resize((328, 324), Image.NEAREST), ((W - 328) // 2, 470))

    def ctext(y, text, size, fill):
        f = ImageFont.truetype(BOLD, size)
        while f.getbbox(text)[2] > W - 80 and size > 30:
            size -= 2
            f = ImageFont.truetype(BOLD, size)
        l, t, r, b = f.getbbox(text)
        x = (W - (r - l)) // 2 - l
        d.text((x + 5, y + 5), text, font=f, fill=EDGE + (255,))
        d.text((x, y), text, font=f, fill=fill + (255,))

    ctext(850, "MCSR REPLAYOFFS", 64, QUARTZ)
    ctext(1010, spec.get("endQuestion", "WHO TOOK IT?"), 80, GOLD)
    ctext(1130, "FULL MATCH ON THE CHANNEL", 46, QUARTZ)
    end.save(f"{tmp}/end.png")


def clip_start(spec, mdir):
    sync = json.load(open(os.path.join(mdir, "sync.json")))
    return float(sync[spec["side"]]) + spec["fromSec"]  # clip time of fromSec (clipTimeFor at match time)


def words(spec):
    mdir = f"/media/{spec['matchId']}"
    dur = spec["toSec"] - spec["fromSec"]
    with tempfile.TemporaryDirectory() as tmp:
        mp3 = f"{tmp}/win.mp3"
        run(["ffmpeg", "-v", "error", "-y", "-ss", str(clip_start(spec, mdir)), "-t", str(dur),
             "-i", os.path.join(mdir, f"{spec['nickname']}.mp4"), "-vn", "-ac", "1", "-ar", "16000", mp3])
        key = next(l.split("=", 1)[1].strip().strip('"\'') for l in open("/app/.env") if l.startswith("GROQ_API_KEY="))
        out = subprocess.run(["curl", "-s", "--max-time", "60", "https://api.groq.com/openai/v1/audio/transcriptions",
                              "-H", f"Authorization: Bearer {key}", "-F", f"file=@{mp3}", "-F", "model=whisper-large-v3",
                              "-F", "response_format=verbose_json", "-F", "timestamp_granularities[]=word", "-F", "language=en"],
                             check=True, capture_output=True, text=True).stdout
        j = json.loads(out)
        print(j.get("text", ""))
        for w in j.get("words", []):
            print(f"{w['start']:6.2f} {w['end']:6.2f} {w['word']}")


def build(spec):
    mdir = f"/media/{spec['matchId']}"
    dur = spec["toSec"] - spec["fromSec"]
    fx, fy, fw, fh = spec["faceCrop"]
    gx, gw = spec["gameX"], spec["gameW"]
    gh = round(gw * 1320 / 1080)
    with tempfile.TemporaryDirectory() as tmp:
        brand(spec, mdir, tmp)
        inputs = ["-ss", str(clip_start(spec, mdir)), "-t", str(dur), "-i", os.path.join(mdir, f"{spec['nickname']}.mp4"),
                  "-ss", str(spec["fromSec"] + ANCHOR_SEC), "-t", str(dur), "-i", os.path.join(mdir, "overlay-timer.mp4"),
                  "-i", f"{tmp}/band.png", "-i", f"{tmp}/badge.png", "-i", f"{tmp}/hook.png"]
        g = [
            "[0:v]split=2[a][b]",
            f"[a]crop={fw}:{fh}:{fx}:{fy},scale=1080:486:flags=lanczos[face]",
            f"[b]crop={gw}:{min(gh, 1080)}:{gx}:{max(0, (1080 - gh) // 2)},scale=1080:1320:flags=lanczos[game]",
            f"color=c=0x221F27:s={W}x{H}:r=60:d={dur}[bg]",
            "[bg][2:v]overlay=0:0[l0]", "[l0][face]overlay=0:114[l1]", "[l1][game]overlay=0:600[l2]",
            "[1:v]fps=60,scale=336:242:flags=area[clock]", "[l2][clock]overlay=14:340:eof_action=pass[l3]",
            "[l3][3:v]overlay=914:128[l4]",
            f"[l4][4:v]overlay=(W-w)/2:700:enable='between(t,0,{spec.get('hookTo', 3.2)})'[s0]",
        ]
        n, last = 5, "s0"
        if spec.get("turn"):
            inputs += ["-i", f"{tmp}/turn.png"]
            t = spec["turn"]
            g.append(f"[{last}][{n}:v]overlay=(W-w)/2:760:enable='between(t,{t['from']},{t['to']})'[s{n}]")
            last, n = f"s{n}", n + 1
        for i, c in enumerate(spec.get("captions", [])):
            inputs += ["-i", f"{tmp}/cap{i}.png"]
            y = 1650 if c.get("low") else 1340
            g.append(f"[{last}][{n}:v]overlay=(W-w)/2:{y}:enable='between(t,{c['from']},{c['to']})'[s{n}]")
            last, n = f"s{n}", n + 1
        inputs += ["-loop", "1", "-framerate", "60", "-t", str(dur), "-i", f"{tmp}/end.png"]
        ef = spec.get("endFrom", dur - 3)
        g.append(f"[{n}:v]format=rgba,fade=t=in:st={ef}:d=0.35:alpha=1[endf]")
        g.append(f"[{last}][endf]overlay=0:0:enable='gte(t,{ef})'[v]")
        mutes = "".join(f"volume=0:enable='between(t,{a},{b})'," for a, b in spec.get("mute", []))
        g.append(f"[0:a]{mutes}loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[au]")
        with open(f"{tmp}/graph.txt", "w") as fh_:
            fh_.write(";\n".join(g))
        out = spec["out"]
        run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex_script", f"{tmp}/graph.txt", "-map", "[v]", "-map", "[au]",
             "-t", str(dur), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "60", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out])
    beats = [0.8, spec.get("turn", {}).get("from", dur * 0.45) + 0.6] + [c["from"] + 0.3 for c in spec.get("captions", [])][:3] + [dur - 1]
    sel = "+".join(f"eq(n\\,{int(t * 60)})" for t in beats)
    run(["ffmpeg", "-v", "error", "-y", "-i", out, "-vf", f"select='{sel}',scale=360:640,tile={len(beats)}x1",
         "-frames:v", "1", "-vsync", "vfr", out + ".beats.png"])
    print("built", out, "and", out + ".beats.png")


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    for k in ("matchId", "nickname", "side", "fromSec", "toSec", "faceCrop", "gameX", "gameW", "hook", "out"):
        assert k in spec, f"spec is missing {k}"
    assert spec["side"] in ("left", "right") and 12 <= spec["toSec"] - spec["fromSec"] <= 60, "side left|right, 12-60 s"
    words(spec) if "--words" in sys.argv else build(spec)
