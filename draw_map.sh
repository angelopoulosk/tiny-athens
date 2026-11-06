#!/bin/bash
# Draws the map at 72% style + pixel snap (settings in config.json), in two stages:
#   1. the pilot area (about 2 h) -> tiles, so the site can be updated right away
#   2. one ring outward, area "ring1" (render ~15 min, then several hours of drawing) -> tiles
# No Gemini, costs nothing. Safe to stop with Ctrl+C and re-run; it resumes.
#   bash draw_map.sh
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export PYTHONUNBUFFERED=1
mkdir -p out
exec > >(tee -a out/run.log) 2>&1
step() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
echo; echo "===== draw_map.sh - $(date) ====="
caffeinate -i -w $$ &

step "1/5 Drawing the pilot area"
uv run scripts/generate.py --area pilot
step "2/5 Tiles for the pilot (Claude can upload these already)"
uv run scripts/make_tiles.py
touch out/PILOT_TILES_READY

step "3/5 Rendering one ring outward from Google's 3D tiles"
uv run scripts/render.py --area ring1 --no-extra
step "4/5 Drawing the ring (the pilot squares stay as they are)"
uv run scripts/generate.py --area ring1
step "5/5 Tiles for the whole map"
uv run scripts/make_tiles.py
touch out/RING1_TILES_READY
echo; echo "All done. Tell Claude: map done"
