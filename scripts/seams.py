"""Helpers for draw_squares.py: keep each new square lined up with its drawn neighbours.

- align_to_context(): Gemini sometimes shifts or rescales its drawing a little. The border
  of its output shows the neighbouring squares, which we already have, so we find the
  shift/scale that lines the two up (feature matching) and undo it.
- frame_lines(): Gemini sometimes draws the edge of the "already drawn" border as a long
  straight line. Such squares are rejected and drawn again.
- blend_into_neighbours(): feathers each drawn neighbour's edge (a few dozen px) toward
  Gemini's own version of it, so the join is a soft transition instead of a hard seam.
"""

from __future__ import annotations

import numpy as np
from PIL import Image


def _gray(im: Image.Image) -> np.ndarray:
  return np.asarray(im.convert("L"))


def align_to_context(out: Image.Image, canvas: Image.Image, mask: np.ndarray):
  """Warp `out` (same size as `canvas`) so its drawn-border area lines up with `canvas`.

  mask: bool array (canvas size), True where the canvas shows an already drawn neighbour.
  Returns (aligned image, info dict). If too few matches, returns `out` unchanged."""
  import cv2

  info = {"aligned": False}
  if mask.sum() < 5000:
    return out, info
  a, b = _gray(out), _gray(canvas)
  m8 = (cv2.dilate(mask.astype(np.uint8), np.ones((15, 15), np.uint8)) * 255)
  orb = cv2.ORB_create(nfeatures=4000, fastThreshold=10)
  ka, da = orb.detectAndCompute(a, m8)
  kb, db = orb.detectAndCompute(b, m8)
  if da is None or db is None or len(ka) < 20 or len(kb) < 20:
    return out, info
  matches = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da, db, k=2)
  good = [m for m, n in (p for p in matches if len(p) == 2) if m.distance < 0.8 * n.distance]
  if len(good) < 15:
    info["matches"] = len(good)
    return out, info
  src = np.float32([ka[m.queryIdx].pt for m in good])
  dst = np.float32([kb[m.trainIdx].pt for m in good])
  M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
  if M is None:
    return out, info
  scale = float(np.hypot(M[0, 0], M[1, 0]))
  rot = float(np.degrees(np.arctan2(M[1, 0], M[0, 0])))
  n_in = int(inl.sum()) if inl is not None else 0
  info.update(matches=len(good), inliers=n_in, scale=round(scale, 4), rot=round(rot, 2),
              dx=round(float(M[0, 2]), 1), dy=round(float(M[1, 2]), 1))
  if n_in < 12 or abs(scale - 1) > 0.08 or abs(rot) > 3:
    return out, info
  w, h = out.size
  warped = cv2.warpAffine(np.asarray(out), M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
  info["aligned"] = True
  return Image.fromarray(warped), info


def frame_lines(sq: Image.Image, min_frac: float = 0.33) -> list:
  """Long straight thin dark lines across the square (rows/columns), as Gemini draws
  when it outlines the panel it was given. Returns [("row"|"col", position), ...]."""
  g = _gray(sq).astype(np.int16)
  found = []
  for axis, name in ((0, "row"), (1, "col")):
    a = g if axis == 0 else g.T
    # A thin line: darker than both the pixels 3 above and 3 below it.
    up, mid, dn = a[:-6], a[3:-3], a[6:]
    dark = (up - mid > 25) & (dn - mid > 25)
    frac = dark.mean(axis=1)
    # Longest run along the line also has to be long (not just many scattered dark pixels).
    for k in np.where(frac > min_frac)[0]:
      row = dark[k]
      runs = np.diff(np.flatnonzero(np.diff(np.concatenate(([0], row.astype(np.int8), [0])))))[::2]
      if runs.size and runs.max() > 0.2 * row.size:
        found.append((name, int(k) + 3))
  # Merge adjacent hits.
  merged = []
  for n, p in found:
    if not merged or merged[-1][0] != n or p - merged[-1][1] > 3:
      merged.append((n, p))
  return merged


def blend_into_neighbours(out_S: Image.Image, border: int, shot: int, neighbours: dict, band: int = 48):
  """out_S: Gemini's aligned output at canvas size (shot + 2*border), centre = new square.
  neighbours: {"left"|"right"|"up"|"down": PIL image of that drawn neighbour}.
  Returns {side: blended neighbour image}: each neighbour's `band` px next to the new square
  fade toward Gemini's version of that strip, so the two meet without a hard seam."""
  o = np.asarray(out_S.convert("RGB")).astype(np.float32)
  res = {}
  for side, nb in neighbours.items():
    n = np.asarray(nb.convert("RGB").resize((shot, shot))).astype(np.float32)
    b = min(band, border)
    ramp = (np.arange(b, dtype=np.float32) + 1) / b          # 0 -> 1 toward the new square
    ramp = (ramp * ramp * (3 - 2 * ramp))
    if side == "left":    # neighbour's right edge
      strip = o[border:border + shot, border - b:border]
      n[:, shot - b:] = n[:, shot - b:] * (1 - ramp[None, :, None]) + strip * ramp[None, :, None]
    elif side == "right":  # neighbour's left edge
      strip = o[border:border + shot, border + shot:border + shot + b]
      r = ramp[::-1]
      n[:, :b] = n[:, :b] * (1 - r[None, :, None]) + strip * r[None, :, None]
    elif side == "up":     # neighbour's bottom edge
      strip = o[border - b:border, border:border + shot]
      n[shot - b:, :] = n[shot - b:, :] * (1 - ramp[:, None, None]) + strip * ramp[:, None, None]
    elif side == "down":   # neighbour's top edge
      strip = o[border + shot:border + shot + b, border:border + shot]
      r = ramp[::-1]
      n[:b, :] = n[:b, :] * (1 - r[:, None, None]) + strip * r[:, None, None]
    res[side] = Image.fromarray(np.clip(n, 0, 255).astype(np.uint8))
  return res
