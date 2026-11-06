#!/bin/bash
# Runs the whole pilot from start to finish:
#   setup (if needed) -> render -> Gemini drawings -> train -> preview -> generate -> tiles
# Run from the project folder:   bash run_all.sh            (or: bash run_all.sh centre)
# Safe to re-run at any time: every step skips or resumes what is already done.
# Everything is also written to out/run.log.
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export PYTHONUNBUFFERED=1   # show progress live (output goes through tee)
AREA="${1:-pilot}"
mkdir -p out
exec > >(tee -a out/run.log) 2>&1
echo
echo "===== run_all.sh $AREA - $(date) ====="

step() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }

if [ ! -d .venv ] || [ ! -d render/node_modules ]; then
  step "First run: setting everything up"
  bash setup.sh
fi

if [ ! -f .env ] || grep -q "paste-your" .env; then
  [ -f .env ] || cp .env.example .env
  echo
  echo "Put your two API keys in .env first (see GUIDE.md step 1). Opening it now..."
  open -e .env
  echo "Save it, then run:  bash run_all.sh"
  exit 1
fi

# Keep the Mac awake until this script ends.
caffeinate -i -w $$ &

step "1/6 Rendering '$AREA' from Google's 3D tiles"
uv run scripts/render.py --area "$AREA"

step "2/6 Teacher drawings from Gemini"
uv run scripts/make_pairs.py
n=$(ls pairs/targets/*.png 2>/dev/null | wc -l | tr -d ' ')
if [ "$n" -lt 40 ]; then
  echo
  echo "Only $n good drawings so far (need about 40+; the free daily Gemini quota may be used up)."
  echo "Run  bash run_all.sh  again tomorrow and it continues from here."
  exit 0
fi

step "3/6 Training the style model ($n drawings)"
uv run scripts/train_lora.py

step "4/6 Preview of one patch"
uv run scripts/generate.py --area "$AREA" --preview

step "5/6 Drawing the whole area"
uv run scripts/generate.py --area "$AREA"

step "6/6 Making the zoomable tiles"
uv run scripts/make_tiles.py

echo
echo "All done. Overview: out/map_$AREA.jpg"
echo "To explore it:  uv run python -m http.server 8000 -d viewer   then open http://localhost:8000"
open "out/map_$AREA.jpg" 2>/dev/null || true
