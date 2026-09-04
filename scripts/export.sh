#!/usr/bin/env bash
# Render a cut .kdenlive to a finished MP4, headlessly, on the lab.
#   npm run export -- media/<id>/match-<id>.kdenlive [out.mp4]
#   RANGE=119 npm run export -- ...      # first N frames only, for a smoke test
set -euo pipefail

PROJECT="${1:?usage: export.sh <project.kdenlive> [out.mp4]}"
OUT="${2:-$(dirname "$PROJECT")/final.mp4}"
PART="${OUT%.mp4}.part.mp4"
MELT="$(command -v melt || command -v melt-7)"

# CPU, deliberately. The container has a working VAAPI encoder (iHD 23.1.1,
# VAProfileH264Main/VAEntrypointEncSliceLP on /dev/dri/renderD128) but melt cannot
# drive it: its avformat consumer never sets up the hwframes context, so
# vcodec=h264_vaapi dies with "A hardware frames reference is required to associate
# the encoding device" (SIGSEGV, exit 139). Reaching it would mean piping raw
# 1080p60 out of melt into a separate ffmpeg -vaapi_device ... hwupload stage —
# ~3 Gbit/s through a pipe on two cores, plus separate audio muxing.
#
# Not worth it: encoding is not the bottleneck. Measured, 1800 frames at
# preset=veryfast took 2m51s wall for 4m57s CPU, and that time is melt decoding two
# 1080p60 H.264 streams plus a 3.9 GB ProRes 4444 alpha overlay and compositing
# them. The encoder is a rounding error on that.
#
# No `profile=`: melt hands unprefixed options to the audio encoder too, and aac
# rejects "main". Matches the desktop's measured output otherwise (1080p60,
# ~8.3 Mbps, AAC stereo 160k).
CODEC=(vcodec=libx264 preset=veryfast)
rm -f "$PART"
rc=0
# MLT's Qt module backs qimage (the PNG bands) and qtblend (split-screen
# positioning) and hard-fails without X11, even though melt is a CLI tool.
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -u)}"
mkdir -p "$RUNTIME_DIR" && chmod 700 "$RUNTIME_DIR"
XDG_RUNTIME_DIR="$RUNTIME_DIR" xvfb-run -a "$MELT" "$PROJECT" ${RANGE:+out=$RANGE} \
  -consumer "avformat:$PART" "${CODEC[@]}" \
  vb=8300k pix_fmt=yuv420p acodec=aac ab=160k channels=2 \
  threads=2 real_time=-1 || rc=$?

if [ "$rc" -eq 137 ]; then
  echo "export: killed by the OOM killer (exit 137) — lower threads= or free memory" >&2
  exit 137
elif [ "$rc" -ne 0 ]; then
  echo "export: melt failed (exit $rc)" >&2
  exit "$rc"
fi

# Promote only after ffprobe agrees it's a real video. Same reason as
# src/atomicOutput.ts: every stage check is existsSync, so a truncated file under
# the final name would be trusted forever.
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name \
  -show_entries format=duration -of csv=p=0 "$PART" >/dev/null
mv "$PART" "$OUT"
echo "export: $OUT"
