#!/bin/bash
# Two quick previews of the same patch with the style pushed harder (about 10 min each).
# Results land in out/previews/. Tell Claude "previews done".
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
export PYTHONUNBUFFERED=1
caffeinate -i -w $$ &
for s in 0.72 0.82; do
  echo; echo "==> Preview with strength $s"
  uv run scripts/generate.py --area pilot --preview --strength $s
done
echo; echo "Done. Tell Claude: previews done"
