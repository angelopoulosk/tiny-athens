"""The map as Gemini drew it: every teacher drawing on one map of the whole of Athens.

  uv run scripts/make_preview_tiles.py

The map covers the whole "world" area in config.json (all of Athens). Squares that
have an accepted Gemini drawing (pairs/targets/) are shown; everything else stays
empty and the viewer covers it with fog of war, so the map can be filled in square
by square over time. Each drawing was made on its own, so seams can show.
Writes viewer/tiles/ (map + matching 3D render) and info.json with the list of
drawn squares (the viewer only asks for tiles that exist, and draws the fog).
"""

from __future__ import annotations

import json
import math
import time

from common import PAIRS, RENDERS, VIEWER, atomic_write_text, load_config, parse_cell, shot_px
from make_tiles import build

# Camera projection fitted to the renderer (same numbers as viewer/planner.html, within ~0.4 px):
# global map pixel of a lat/lon at street level.
LAT0, LON0 = 37.9755, 23.7348
PX = (0.88112, 3.30103, 0.17542)
PY = (-2.32446, 0.62543, 0.13215)


def to_px(lat: float, lon: float) -> tuple[float, float]:
  n = (lat - LAT0) * 111320
  e = (lon - LON0) * 111320 * math.cos(math.radians(LAT0))
  return PX[0] * n + PX[1] * e + PX[2], PY[0] * n + PY[1] * e + PY[2]


def world_bbox(shot: int):
  w = load_config()["world"]
  pts = [to_px(la, lo) for la in (w["south"], w["north"]) for lo in (w["west"], w["east"])]
  xs, ys = [p[0] for p in pts], [p[1] for p in pts]
  return (math.floor(min(xs) / shot), math.floor(min(ys) / shot), math.floor(max(xs) / shot), math.floor(max(ys) / shot))


def render_file(i: int, j: int):
  for ext in ("png", "jpg"):
    p = RENDERS / f"{i}_{j}.{ext}"
    if p.exists():
      return p
  return None


def main():
  shot = shot_px()
  i0, j0, i1, j1 = world_bbox(shot)
  drawn = sorted(parse_cell(p.stem) for p in (PAIRS / "targets").glob("*.png"))
  drawn = [c for c in drawn if i0 <= c[0] <= i1 and j0 <= c[1] <= j1]
  n_world = (i1 - i0 + 1) * (j1 - j0 + 1)
  print(f"World: {i1 - i0 + 1} x {j1 - j0 + 1} = {n_world} squares; {len(drawn)} drawn by Gemini.")

  size = build("map", lambda i, j: PAIRS / "targets" / f"{i}_{j}.png", drawn, (i0, j0, i1, j1), lossless=False)
  rcells = [c for c in drawn if render_file(*c)]
  build("render", render_file, rcells, (i0, j0, i1, j1), lossless=False)
  ax, ay = to_px(37.9715, 23.7257)
  info = {**size, "origin_px": [i0 * shot, j0 * shot], "shot": shot, "world_squares": n_world,
          "cells": [[i - i0, j - j0] for i, j in drawn], "render_cells": [[i - i0, j - j0] for i, j in rcells],
          "start": [round(ax - i0 * shot), round(ay - j0 * shot), 5 * shot],  # opens on the Acropolis
          "fog": True, "preview": True, "version": int(time.time())}
  atomic_write_text(VIEWER / "tiles" / "info.json", json.dumps(info, separators=(",", ":")))
  print("Done: viewer/tiles (Gemini drawings + fog of war).")


if __name__ == "__main__":
  main()
