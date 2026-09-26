#!/usr/bin/env bash
# Bake a seed-icon scene spec and render it to a PNG: render.sh <spec.json> <out.png> [size]
# The jar comes from $MC_JAR or bake.py's cache (downloaded from Mojang when missing).
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 <spec.json> <out.png> [size]" >&2; exit 2; }
spec=$(realpath "$1")
out=$(realpath -m "$2")
cd "$(dirname "$0")/../.."
baked=$(python3 scripts/seed-icons/bake.py "$spec" ${3:+--size "$3"})
mkdir -p "$(dirname "$out")"
npm run --silent still -- SeedIconScene "$out" --props="$baked" --log=error
echo "$out"
