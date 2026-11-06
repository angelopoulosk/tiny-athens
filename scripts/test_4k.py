"""Experiment: can Gemini draw a whole 4 x 4 block of squares in ONE 4K image?

  uv run scripts/test_4k.py                 # Gemini 3.1 Flash Image, ~EUR 0.15
  uv run scripts/test_4k.py --model gemini-3-pro-image   # ~EUR 0.25

Builds one 4096 x 4096 render from 16 neighbouring squares (pilot + the row above it),
asks Gemini to redraw it with the same prompt and style sample as the teacher drawings,
and saves a comparison sheet: for a few squares, render | teacher drawing (one square
per call) | the same square cut out of the 4K drawing. One Gemini call, nothing else
is changed. Safe to run while the Mac is drawing (it only uses the network).

Output: out/test4k/ (drawing_<model>.png, compare_<model>.jpg)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from io import BytesIO

from PIL import Image, ImageDraw

from common import OUT, PAIRS, ROOT, cell_name, load_env, render_path
from make_pairs import PROMPT_FINE, STYLE_NOTE

I0, J0, N = -5, -2, 4  # squares i = -5..-2, j = -2..1 (Acropolis / Plaka / Thissio)
SHOT = 1024

BIG_NOTE = (
  "This image is a large 4 x 4 block of a city map. Draw the WHOLE image at full detail, edge to edge, "
  "keeping every building at its exact position and size; the output will be cut into 16 squares and "
  "placed back on the map, so nothing may shift."
)


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--model", default="gemini-3.1-flash-image")
  args = ap.parse_args()

  cells = [(I0 + a, J0 + b) for b in range(N) for a in range(N)]
  missing = [c for c in cells if not render_path(*c).exists()]
  if missing:
    sys.exit(f"Renders missing for {missing}")
  big = Image.new("RGB", (N * SHOT, N * SHOT))
  for i, j in cells:
    big.paste(Image.open(render_path(i, j)).convert("RGB").resize((SHOT, SHOT)), ((i - I0) * SHOT, (j - J0) * SHOT))

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
  print(f"One 4K drawing of {len(cells)} squares with {args.model} (takes 1-3 min)...", flush=True)
  t0 = time.time()
  resp = client.models.generate_content(
    model=args.model, contents=[PROMPT_FINE + "\n\n" + BIG_NOTE, big, STYLE_NOTE, style], config=cfg
  )
  drawing = None
  for cand in resp.candidates or []:
    for part in (cand.content.parts if cand.content else []) or []:
      if getattr(part, "inline_data", None) and part.inline_data.data:
        drawing = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
  if drawing is None:
    sys.exit(f"Gemini returned no image. Text: {getattr(resp, 'text', '')}")
  print(f"Got {drawing.size[0]} x {drawing.size[1]} px in {time.time() - t0:.0f} s.")

  out = OUT / "test4k"
  out.mkdir(parents=True, exist_ok=True)
  tag = args.model.replace("gemini-", "")
  full = drawing.resize(big.size, Image.LANCZOS)
  full.save(out / f"drawing_{tag}.png")
  big.resize((2048, 2048), Image.LANCZOS).save(out / "render_block.jpg", quality=90)

  # Comparison sheet: squares that also have a one-square teacher drawing.
  pick = [c for c in cells if (PAIRS / "targets" / f"{cell_name(*c)}.png").exists()][:4] or cells[5:9]
  T = 512
  sheet = Image.new("RGB", (3 * T, len(pick) * (T + 24) + 24), (30, 32, 36))
  dr = ImageDraw.Draw(sheet)
  dr.text((6, 6), f"render  |  teacher (one square per call)  |  cut from ONE 4K drawing ({args.model})", fill=(230, 230, 230))
  for r, (i, j) in enumerate(pick):
    y = 24 + r * (T + 24)
    box = ((i - I0) * SHOT, (j - J0) * SHOT, (i - I0 + 1) * SHOT, (j - J0 + 1) * SHOT)
    tp = PAIRS / "targets" / f"{cell_name(i, j)}.png"
    teacher = Image.open(tp).convert("RGB") if tp.exists() else Image.new("RGB", (SHOT, SHOT), (60, 60, 60))
    for k, im in enumerate((Image.open(render_path(i, j)).convert("RGB"), teacher, full.crop(box))):
      sheet.paste(im.resize((T, T), Image.LANCZOS), (k * T, y + 20))
    dr.text((6, y + 4), cell_name(i, j), fill=(230, 230, 230))
  sheet.save(out / f"compare_{tag}.jpg", quality=90)
  print(f"Saved {out / f'compare_{tag}.jpg'} and the full drawing. Tell Claude: 4k test done")


if __name__ == "__main__":
  main()
