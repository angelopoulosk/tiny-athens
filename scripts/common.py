"""Shared helpers. Nothing in here imports torch, so it loads fast."""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
RENDERS = ROOT / "renders"  # renders/{i}_{j}.png, one per shot of the global lattice
PAIRS = ROOT / "pairs"  # teacher drawings
OUT = ROOT / "out"
CELLS = OUT / "cells"  # finished pixel-art map, one png per shot cell
AREAS_JSON = OUT / "areas.json"
VIEWER = ROOT / "viewer"


def load_config() -> dict:
  return json.loads(CONFIG_PATH.read_text())


def load_env() -> None:
  from dotenv import load_dotenv

  load_dotenv(ROOT / ".env")


def shot_px() -> int:
  return int(load_config()["camera"]["shot_px"])


# ---------------------------------------------------------------- cells / areas


def cell_name(i: int, j: int) -> str:
  return f"{i}_{j}"


def parse_cell(name: str) -> tuple[int, int]:
  a, b = name.split("_")
  return int(a), int(b)


def area_cells(center_px: tuple[float, float], shots_x: int, shots_y: int, shot: int):
  """Cells of an area centred on a global pixel position, snapped to the lattice."""
  ci = int(np.floor(center_px[0] / shot))
  cj = int(np.floor(center_px[1] / shot))
  i0 = ci - shots_x // 2
  j0 = cj - shots_y // 2
  return [(i, j) for j in range(j0, j0 + shots_y) for i in range(i0, i0 + shots_x)]


def ring(cells) -> list[tuple[int, int]]:
  """The cells touching an area from outside (8-neighbourhood)."""
  s = set(cells)
  out = set()
  for i, j in s:
    for di in (-1, 0, 1):
      for dj in (-1, 0, 1):
        c = (i + di, j + dj)
        if c not in s:
          out.add(c)
  return sorted(out)


def load_areas() -> dict:
  if not AREAS_JSON.exists():
    return {}
  return json.loads(AREAS_JSON.read_text())


def save_areas(data: dict) -> None:
  atomic_write_text(AREAS_JSON, json.dumps(data, indent=2))


def render_path(i: int, j: int) -> Path:
  return RENDERS / f"{cell_name(i, j)}.png"


def cell_path(i: int, j: int) -> Path:
  return CELLS / f"{cell_name(i, j)}.png"


# ---------------------------------------------------------------- files


def atomic_write_text(path: Path, text: str) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  tmp = path.with_suffix(path.suffix + ".tmp")
  tmp.write_text(text)
  os.replace(tmp, path)


def atomic_save_image(img: Image.Image, path: Path, **kw) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  tmp = path.with_name(path.stem + ".tmp" + path.suffix)
  img.save(tmp, **kw)
  os.replace(tmp, path)


def assemble(cells_dir_fn, x0: int, y0: int, w: int, h: int, shot: int, mode="RGB"):
  """Build a canvas for global pixel box (x0, y0, w, h) from per-cell images.

  cells_dir_fn(i, j) -> Path. Missing cells stay black. Returns (array, have_mask)
  where have_mask is True for pixels that came from an existing cell.
  """
  ch = 3 if mode == "RGB" else 4
  canvas = np.zeros((h, w, ch), np.uint8)
  have = np.zeros((h, w), bool)
  i_lo, i_hi = x0 // shot, (x0 + w - 1) // shot
  j_lo, j_hi = y0 // shot, (y0 + h - 1) // shot
  for j in range(j_lo, j_hi + 1):
    for i in range(i_lo, i_hi + 1):
      p = cells_dir_fn(i, j)
      if not p.exists():
        continue
      img = np.asarray(Image.open(p).convert(mode))
      cx0, cy0 = i * shot, j * shot
      ax0, ay0 = max(x0, cx0), max(y0, cy0)
      ax1, ay1 = min(x0 + w, cx0 + shot), min(y0 + h, cy0 + shot)
      if ax1 <= ax0 or ay1 <= ay0:
        continue
      canvas[ay0 - y0 : ay1 - y0, ax0 - x0 : ax1 - x0] = img[ay0 - cy0 : ay1 - cy0, ax0 - cx0 : ax1 - cx0]
      have[ay0 - y0 : ay1 - y0, ax0 - x0 : ax1 - x0] = True
  return canvas, have


# ---------------------------------------------------------------- teacher checks


def flat_share(img: Image.Image, tol: int = 10) -> float:
  """Share of pixels whose 3x3 neighbourhood is flat. Pixel art scores high,
  a photo with a filter over it scores low (tiny.london: good 0.42-0.55)."""
  import cv2

  a = np.asarray(img.convert("RGB"))
  k = np.ones((3, 3), np.uint8)
  spread = np.zeros(a.shape[:2], np.int16)
  for c in range(3):
    ch = a[:, :, c]
    spread = np.maximum(spread, cv2.dilate(ch, k).astype(np.int16) - cv2.erode(ch, k).astype(np.int16))
  return float((spread <= tol).mean())


def edge_match(render: Image.Image, drawing: Image.Image, size: int = 512) -> float:
  """How well the drawing keeps the render's structure: F1 of Canny edges,
  each allowed to be a few pixels off. Shifted or invented scenes score low."""
  import cv2

  def edges(im):
    g = np.asarray(im.convert("L").resize((size, size), Image.BILINEAR))
    g = cv2.GaussianBlur(g, (5, 5), 0)
    return cv2.Canny(g, 50, 140) > 0

  er, ed = edges(render), edges(drawing)
  if er.sum() == 0 or ed.sum() == 0:
    return 0.0
  k = np.ones((5, 5), np.uint8)

  def f1(a, b):
    a_d = cv2.dilate(a.astype(np.uint8), k) > 0
    b_d = cv2.dilate(b.astype(np.uint8), k) > 0
    p = (b & a_d).sum() / max(1, b.sum())
    r = (a & b_d).sum() / max(1, a.sum())
    return 0.0 if p + r == 0 else 2 * p * r / (p + r)

  # Subtract what a drawing of the wrong place would score, so dense scenes
  # don't pass just because edges are everywhere. 0 = no better than chance.
  s = size // 4
  chance = np.mean([f1(er, np.roll(ed, d, axis=ax)) for d in (s, -s) for ax in (0, 1)])
  score = (f1(er, ed) - chance) / max(1e-6, 1 - chance)
  return float(max(0.0, score))


# ---------------------------------------------------------------- joint sampler grid


def window_positions(length: int, win: int, stride: int, shift: int = 0) -> list[int]:
  """Window starts covering [0, length) with the given stride, offset by shift.
  Always includes the first and last possible position so nothing is missed."""
  if length <= win:
    return [0]
  last = length - win
  pos = set(range(shift % stride, last + 1, stride))
  pos.add(0)
  pos.add(last)
  return sorted(pos)


def tent(win: int) -> np.ndarray:
  """2D weight: rises from near 0 at the window edge, flat over the middle half."""
  x = np.arange(win) + 0.5
  r = np.minimum(x, win - x) / (win / 4)
  w1 = np.clip(r, 0.0, 1.0)
  return np.outer(w1, w1).astype(np.float32)
