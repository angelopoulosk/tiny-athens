"""Experiment 2: do two neighbouring 4K Gemini blocks join without a visible seam?

  uv run scripts/test_4k_seam.py            # one Gemini call, ~EUR 0.15

Block A = the first test (squares i -5..-2, j -2..1, out/test4k/drawing_3.1-flash-image.png).
Block B = squares i -2..1, same rows, so the column i = -2 is drawn by BOTH blocks.
For block B, Gemini gets the render with that shared column already replaced by block A's
drawing and is asked to continue it, so colours and style carry over. The two blocks are
then joined with a soft cross-fade across the shared column.

Output in out/test4k/: drawing_B.png, joined.jpg (7 x 4 squares), seam.jpg (close-ups:
hard cut vs cross-fade).
"""

from __future__ import annotations

import os
import sys
import time
from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

from common import OUT, ROOT, load_env, render_path
from make_pairs import PROMPT_FINE, STYLE_NOTE

SHOT, N = 1024, 4
A_I0, B_I0, J0 = -5, -2, -2
MODEL = "gemini-3.1-flash-image"

NOTE_B = (
  "This image is a large 4 x 4 block of a city map. Its LEFT quarter (the first 1024 px column) is "
  "ALREADY DRAWN in the final style: keep that strip exactly as it is, and redraw the rest of the image "
  "(still a photo) in the very same style, colours and level of detail, so the strip continues seamlessly "
  "into your drawing. Keep every building at its exact position and size; the output will be cut into "
  "16 squares and placed back on the map, so nothing may shift."
)


def block_render(i0):
  big = Image.new("RGB", (N * SHOT, N * SHOT))
  for a in range(N):
    for b in range(N):
      p = render_path(i0 + a, J0 + b)
      if not p.exists():
        sys.exit(f"Render missing: {p}")
      big.paste(Image.open(p).convert("RGB").resize((SHOT, SHOT)), (a * SHOT, b * SHOT))
  return big


def main():
  out = OUT / "test4k"
  a_path = out / "drawing_3.1-flash-image.png"
  if not a_path.exists():
    sys.exit("Run scripts/test_4k.py first (block A).")
  A = Image.open(a_path).convert("RGB")

  # Input for block B: its render, with the shared column (i = -2) taken from block A.
  big = block_render(B_I0)
  shared = A.crop(((B_I0 - A_I0) * SHOT, 0, (B_I0 - A_I0 + 1) * SHOT, N * SHOT))
  big.paste(shared, (0, 0))

  load_env()
  key = os.environ.get("GEMINI_API_KEY", "")
  if not key or key.startswith("paste-"):
    sys.exit("GEMINI_API_KEY is missing from .env")
  from google import genai
  from google.genai import types

  client = genai.Client(api_key=key)
  style = Image.open(ROOT / "assets" / "style_ref.png").convert("RGB").resize((768, 768), Image.LANCZOS)
  cfg = types.GenerateContentConfig(
    response_modalities=["TEXT", "IMAGE"],
    image_config=types.ImageConfig(aspect_ratio="1:1", image_size="4K"),
  )
  print(f"Drawing block B (4K, {MODEL}, takes 1-3 min)...", flush=True)
  t0 = time.time()
  resp = client.models.generate_content(
    model=MODEL, contents=[PROMPT_FINE + "\n\n" + NOTE_B, big, STYLE_NOTE, style], config=cfg
  )
  B = None
  for cand in resp.candidates or []:
    for part in (cand.content.parts if cand.content else []) or []:
      if getattr(part, "inline_data", None) and part.inline_data.data:
        B = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
  if B is None:
    sys.exit(f"Gemini returned no image. Text: {getattr(resp, 'text', '')}")
  print(f"Got {B.size[0]} x {B.size[1]} px in {time.time() - t0:.0f} s.")
  B = B.resize((N * SHOT, N * SHOT), Image.LANCZOS)
  B.save(out / "drawing_B.png")

  # Join: canvas 7 squares wide. A covers columns 0-3, B covers 3-6; column 3 is shared.
  W = (B_I0 - A_I0 + N) * SHOT
  ox = (B_I0 - A_I0) * SHOT  # where B starts
  a = np.zeros((N * SHOT, W, 3), np.float32)
  b = np.zeros_like(a)
  a[:, : N * SHOT] = np.asarray(A, np.float32)
  b[:, ox:] = np.asarray(B, np.float32)
  x = np.arange(W)
  wb = np.clip((x - ox) / SHOT, 0, 1)[None, :, None]  # 0 -> 1 across the shared column
  joined = a * (1 - wb) + b * wb
  hard = np.where((x < ox + SHOT // 2)[None, :, None], a, b)
  Image.fromarray(joined.astype(np.uint8)).resize((W // 4, N * SHOT // 4), Image.LANCZOS).save(out / "joined.jpg", quality=90)
  Image.fromarray(joined.astype(np.uint8)).save(out / "joined_full.png")

  # Close-ups around the shared column, 2 crops x (hard cut, cross-fade).
  cx = ox + SHOT // 2
  T = 768
  sheet = Image.new("RGB", (2 * T, 2 * (T + 24) + 24), (30, 32, 36))
  dr = ImageDraw.Draw(sheet)
  dr.text((6, 6), "left: hard cut in the middle of the shared column | right: soft cross-fade", fill=(230, 230, 230))
  for r, cy in enumerate((SHOT, 3 * SHOT)):
    box = (cx - 768, cy - 768, cx + 768, cy + 768)
    for k, im in enumerate((hard, joined)):
      sheet.paste(Image.fromarray(im.astype(np.uint8)).crop(box).resize((T, T), Image.LANCZOS), (k * T, 24 + r * (T + 24) + 20))
  sheet.save(out / "seam.jpg", quality=90)
  print(f"Saved {out / 'joined.jpg'} and {out / 'seam.jpg'}. Tell Claude: seam test done")


if __name__ == "__main__":
  main()
