#!/bin/bash
# Grows the map one ring outward (area "ring1" in config.json) and spends at most
# 40 Gemini calls (about €3) on extra teacher drawings for those new streets.
#   bash expand_ring1.sh
# If the pilot run is still going, this waits for it to finish first.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export PYTHONUNBUFFERED=1
mkdir -p out
exec > >(tee -a out/run.log) 2>&1
step() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }

while pgrep -f "run_all.sh" >/dev/null; do
  echo "Waiting for the pilot run to finish... ($(date +%H:%M))"; sleep 60
done
echo; echo "===== expand_ring1.sh - $(date) ====="
caffeinate -i -w $$ &

step "1/5 Rendering the new ring (about 15 min)"
uv run scripts/render.py --area ring1 --no-extra

step "2/5 Gemini drawings for the new streets (max 40 calls, about €3)"
uv run scripts/make_pairs.py --area ring1 --calls 40

step "3/5 Retraining the style model on old + new drawings (about 3 h)"
[ -d out/lora/final ] && [ ! -d out/lora_pilot_final ] && cp -R out/lora/final out/lora_pilot_final
uv run scripts/train_lora.py --restart

step "4/5 Drawing the whole ring, pilot included, in the new style"
uv run scripts/generate.py --area ring1 --redo

step "5/5 Making the zoomable tiles"
uv run scripts/make_tiles.py
echo; echo "All done. Tell Claude 'ring done' and it uploads the new map."
