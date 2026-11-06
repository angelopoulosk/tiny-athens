"""Step 5: cut the finished map into a zoomable tile pyramid for the viewer.

  uv run scripts/make_tiles.py
  uv run python -m http.server 8000 -d viewer     # then open http://localhost:8000

Builds two Deep Zoom pyramids from every finished cell: the pixel-art map and
the matching 3D render (the viewer can switch between them).
"""

from __future__ import annotations

import json
import math
import shutil
import sys

from PIL import Image

from common import CELLS, VIEWER, atomic_write_text, cell_path, parse_cell, render_path, shot_px

TILE = 512


def build(name: str, src_fn, cells, bbox, lossless: bool) -> dict:
  i0, j0, i1, j1 = bbox
  shot = shot_px()
  W, H = (i1 - i0 + 1) * shot, (j1 - j0 + 1) * shot
  max_level = math.ceil(math.log2(max(W, H)))
  out = VIEWER / "tiles" / f"{name}_files"
  if out.exists():
    shutil.rmtree(out)
  have = set(cells)
  save_kw = {"lossless": True, "quality": 90} if lossless else {"quality": 85}

  def level_size(lv):
    s = 2 ** (max_level - lv)
    return math.ceil(W / s), math.ceil(H / s)

  # Full-resolution level: each 512 tile lies inside one 1024 cell.
  per = shot // TILE
  (out / str(max_level)).mkdir(parents=True)
  for row in range(math.ceil(H / TILE)):
    for col in range(math.ceil(W / TILE)):
      ci, cj = i0 + col // per, j0 + row // per
      if (ci, cj) not in have:
        continue
      img = Image.open(src_fn(ci, cj)).convert("RGB")
      ox, oy = (col % per) * TILE, (row % per) * TILE
      img.crop((ox, oy, ox + TILE, oy + TILE)).save(out / str(max_level) / f"{col}_{row}.webp", **save_kw)

  # Lower levels: halve 2 x 2 blocks of the level above.
  for lv in range(max_level - 1, -1, -1):
    (out / str(lv)).mkdir(parents=True)
    lw, lh = level_size(lv)
    for row in range(math.ceil(lh / TILE)):
      for col in range(math.ceil(lw / TILE)):
        block = Image.new("RGBA", (2 * TILE, 2 * TILE), (0, 0, 0, 0))
        any_child = False
        for dy in (0, 1):
          for dx in (0, 1):
            p = out / str(lv + 1) / f"{2 * col + dx}_{2 * row + dy}.webp"
            if p.exists():
              block.paste(Image.open(p).convert("RGBA"), (dx * TILE, dy * TILE))
              any_child = True
        if not any_child:
          continue
        tw, th = min(TILE, lw - col * TILE), min(TILE, lh - row * TILE)
        block = block.crop((0, 0, 2 * tw, 2 * th)).resize((tw, th), Image.BOX)
        block.save(out / str(lv) / f"{col}_{row}.webp", **save_kw)

  dzi = (
    f'<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="webp" Overlap="0" TileSize="{TILE}">'
    f'<Size Width="{W}" Height="{H}"/></Image>\n'
  )
  atomic_write_text(VIEWER / "tiles" / f"{name}.dzi", dzi)
  return {"width": W, "height": H}


def main():
  cells = sorted(parse_cell(p.stem) for p in CELLS.glob("*.png") if "tmp" not in p.stem)
  if not cells:
    raise SystemExit("No finished cells yet. Run scripts/generate.py first.")
  bbox = (min(c[0] for c in cells), min(c[1] for c in cells), max(c[0] for c in cells), max(c[1] for c in cells))
  print(f"{len(cells)} cells -> tiles...")
  size = build("map", cell_path, cells, bbox, lossless=True)
  rcells = [c for c in cells if render_path(*c).exists()]
  build("render", render_path, rcells, bbox, lossless=False)
  # origin_px: global pixel of the image's top-left corner (the viewer needs it to place live vehicles).
  origin = [bbox[0] * shot_px(), bbox[1] * shot_px()]
  atomic_write_text(VIEWER / "tiles" / "info.json", json.dumps({**size, "cells": len(cells), "origin_px": origin}))

  # Always refresh it: heights already measured are cached, so only new areas take time.
  if True:
    print("\nUpdating the GPS table for live transit (first time ~10 min, then quick)...")
    try:
      import make_geo
      make_geo.main()
    except SystemExit as e:
      print(f"(Skipped live-transit table: {e}. Run  uv run scripts/make_geo.py  later.)")
    except Exception as e:
      print(f"(Skipped live-transit table: {e}. Run  uv run scripts/make_geo.py  later.)")
  print("Done. View it with:\n  uv run python -m http.server 8000 -d viewer\nthen open http://localhost:8000")


if __name__ == "__main__":
  main()
