"""Temporary map: stitch the Gemini teacher drawings into viewer tiles.

  uv run scripts/make_preview_tiles.py

Uses each area's squares and the ring around them. Squares without an accepted
drawing are filled from the 3D render. Each drawing was made on its own, so
seams show; the viewer labels this as a preview. scripts/make_tiles.py replaces
it with the real, seamless map later.
"""

from __future__ import annotations

import json

from common import PAIRS, VIEWER, atomic_write_text, load_areas, render_path, shot_px
from make_tiles import build


def main():
  areas = load_areas()
  if not areas:
    raise SystemExit("Nothing rendered yet. Run scripts/render.py first.")
  cells = sorted({tuple(c) for a in areas.values() for c in a["cells"] + a["margin"]})
  cells = [c for c in cells if render_path(*c).exists()]
  drawn = {c for c in cells if (PAIRS / "targets" / f"{c[0]}_{c[1]}.png").exists()}

  def src(i, j):
    return PAIRS / "targets" / f"{i}_{j}.png" if (i, j) in drawn else render_path(i, j)

  bbox = (min(c[0] for c in cells), min(c[1] for c in cells), max(c[0] for c in cells), max(c[1] for c in cells))
  print(f"{len(cells)} squares: {len(drawn)} drawings, {len(cells) - len(drawn)} filled from the render.")
  size = build("map", src, cells, bbox, lossless=False)
  build("render", render_path, cells, bbox, lossless=False)
  info = {**size, "cells": len(cells), "origin_px": [bbox[0] * shot_px(), bbox[1] * shot_px()], "preview": True}
  atomic_write_text(VIEWER / "tiles" / "info.json", json.dumps(info))
  print("Done: viewer/tiles (preview).")


if __name__ == "__main__":
  main()
