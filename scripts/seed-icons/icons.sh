#!/usr/bin/env bash
# Render the thumbnail's seed-type icons: remotion/assets/seed-icons/<TYPE>.png (what SeedIconMC
# draws) and <TYPE>-alt.png (the other projection, the operator's to swap in by renaming).
# icons.sh [TYPE...] renders only those.
set -euo pipefail
cd "$(dirname "$0")/../.."
declare -A ICON=(
  [VILLAGE]=VILLAGE-house-iso [VILLAGE-alt]=VILLAGE-house-2d
  [SHIPWRECK]=SHIPWRECK-2d-seabed [SHIPWRECK-alt]=SHIPWRECK-iso-sea
  [DESERT_TEMPLE]=DESERT_TEMPLE-2d [DESERT_TEMPLE-alt]=DESERT_TEMPLE-iso-bare
  [RUINED_PORTAL]=RUINED_PORTAL-2d-close [RUINED_PORTAL-alt]=RUINED_PORTAL-iso-close
  [BURIED_TREASURE]=BURIED_TREASURE
)
want=("$@")
for out in "${!ICON[@]}"; do
  if [ ${#want[@]} -gt 0 ] && [[ ! " ${want[*]} " =~ " ${out%-alt} " ]]; then continue; fi
  scripts/seed-icons/render.sh "scripts/seed-icons/scenes/${ICON[$out]}.json" "remotion/assets/seed-icons/$out.png" 1024
done
