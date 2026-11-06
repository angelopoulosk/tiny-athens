"""Experiment 3: which way of calling Gemini keeps the look of the one-square teacher drawings?

  uv run scripts/test_style.py            # 2 Gemini calls (3.1 Flash, 2K), ~EUR 0.20

A) "2K block": one 2048 px drawing of 2 x 2 squares (i -4..-3, j -2..-1).
B) "square + context": one square drawn on its own, but Gemini also sees a 256 px border
   of the neighbouring squares, already drawn (their teacher drawings), and is asked to
   continue them. This is how the whole map could be drawn square by square without seams.

Saves out/test4k/style_compare.jpg: render | teacher (one square per call) | cut from the 4K
block | the new result, for every square that has a teacher drawing.
"""

from __future__ import annotations

import os
import sys
import time
from io import BytesIO

from PIL import Image, ImageDraw

from common import OUT, PAIRS, ROOT, cell_name, load_env, render_path
from make_pairs import PROMPT_FINE, STYLE_NOTE

SHOT = 1024
MODEL = "gemini-3.1-flash-image"
A_I0, A_J0 = -4, -2           # 2 x 2 block
K4_I0, K4_J0 = -5, -2         # the first 4K test block, for comparison
BORDER = 256

NOTE_BLOCK = (
  "This image is a 2 x 2 block of a city map. Draw the whole image edge to edge, keeping every building "
  "at its exact position and size; it will be cut into 4 squares and placed back on the map."
)
NOTE_CTX = (
  "The OUTER BORDER of this image (a frame about one fifth of the width on every side) is ALREADY DRAWN "
  "in the final style - it shows the neighbouring map squares. Keep that border exactly as it is. "
  "Redraw only the photo in the middle, in the very same style, colours and level of detail, so the "
  "border continues seamlessly into your drawing. Keep every building at its exact position and size."
)


def teacher(c):
  p = PAIRS / "targets" / f"{cell_name(*c)}.png"
  return Image.open(p).convert("RGB").resize((SHOT, SHOT)) if p.exists() else None


def render(c):
  return Image.open(render_path(*c)).convert("RGB").resize((SHOT, SHOT))


def gemini(client, contents, size):
  from google.genai import types

  cfg = types.GenerateContentConfig(
    response_modalities=["TEXT", "IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1", image_size=size)
  )
  t0 = time.time()
  resp = client.models.generate_content(model=MODEL, contents=contents, config=cfg)
  for cand in resp.candidates or []:
    for part in (cand.content.parts if cand.content else []) or []:
      if getattr(part, "inline_data", None) and part.inline_data.data:
        im = Image.open(BytesIO(part.inline_data.data)).convert("RGB")
        print(f"   got {im.size[0]} x {im.size[1]} px in {time.time() - t0:.0f} s", flush=True)
        return im
  sys.exit(f"Gemini returned no image. Text: {getattr(resp, 'text', '')}")


def main():
  load_env()
  key = os.environ.get("GEMINI_API_KEY", "")
  if not key or key.startswith("paste-"):
    sys.exit("GEMINI_API_KEY is missing from .env")
  from google import genai

  client = genai.Client(api_key=key)
  style = Image.open(ROOT / "assets" / "style_ref.png").convert("RGB").resize((768, 768), Image.LANCZOS)
  out = OUT / "test4k"
  out.mkdir(parents=True, exist_ok=True)
  results = {}  # cell -> (label, image)

  # A) 2 x 2 block at 2K
  cells = [(A_I0 + a, A_J0 + b) for b in range(2) for a in range(2)]
  big = Image.new("RGB", (2 * SHOT, 2 * SHOT))
  for (i, j) in cells:
    big.paste(render((i, j)), ((i - A_I0) * SHOT, (j - A_J0) * SHOT))
  print(f"A) 2K drawing of 2 x 2 squares ({MODEL})...", flush=True)
  d = gemini(client, [PROMPT_FINE + "\n\n" + NOTE_BLOCK, big, STYLE_NOTE, style], "2K").resize(big.size, Image.LANCZOS)
  d.save(out / "block2k.png")
  for (i, j) in cells:
    x, y = (i - A_I0) * SHOT, (j - A_J0) * SHOT
    results[(i, j)] = ("2K block (2x2)", d.crop((x, y, x + SHOT, y + SHOT)))

  # B) one square + already-drawn border: pick a square with a teacher drawing whose
  #    8 neighbours have the most teacher drawings.
  have = {tuple(map(int, p.stem.split("_"))) for p in (PAIRS / "targets").glob("*.png")}
  have = {c for c in have if render_path(*c).exists()}

  def score(c):
    return sum((c[0] + a, c[1] + b) in have for a in (-1, 0, 1) for b in (-1, 0, 1) if a or b)

  pool = [c for c in have if -6 <= c[0] <= 1 and -2 <= c[1] <= 1 and c not in results]
  ctr = max(pool, key=lambda c: (score(c), -abs(c[0] + 3) - abs(c[1])))
  print(f"B) square {cell_name(*ctr)} with an already-drawn border ({score(ctr)}/8 neighbours drawn)...", flush=True)
  S = SHOT + 2 * BORDER
  canvas = Image.new("RGB", (3 * SHOT, 3 * SHOT))
  for a in (-1, 0, 1):
    for b in (-1, 0, 1):
      c = (ctr[0] + a, ctr[1] + b)
      im = render(c) if (a, b) == (0, 0) else (teacher(c) or render(c))
      canvas.paste(im, ((a + 1) * SHOT, (b + 1) * SHOT))
  crop = canvas.crop((SHOT - BORDER, SHOT - BORDER, 2 * SHOT + BORDER, 2 * SHOT + BORDER))
  d = gemini(client, [PROMPT_FINE + "\n\n" + NOTE_CTX, crop, STYLE_NOTE, style], "2K").resize((S, S), Image.LANCZOS)
  d.save(out / "context_square.png")
  crop.save(out / "context_input.png")
  results[ctr] = ("square + drawn border", d.crop((BORDER, BORDER, BORDER + SHOT, BORDER + SHOT)))

  # Comparison sheet
  k4p = out / "drawing_3.1-flash-image.png"
  k4 = Image.open(k4p).convert("RGB") if k4p.exists() else None
  rows = [(c, lab, im) for c, (lab, im) in results.items() if teacher(c) is not None]
  T = 400
  sheet = Image.new("RGB", (4 * T, len(rows) * (T + 22) + 26), (30, 32, 36))
  dr = ImageDraw.Draw(sheet)
  dr.text((6, 7), "render | teacher (one square per call) | cut from the 4K block | new result", fill=(230, 230, 230))
  for r, (c, lab, im) in enumerate(rows):
    y = 26 + r * (T + 22)
    k = None
    if k4 is not None and 0 <= c[0] - K4_I0 < 4 and 0 <= c[1] - K4_J0 < 4:
      x0, y0 = (c[0] - K4_I0) * SHOT, (c[1] - K4_J0) * SHOT
      k = k4.crop((x0, y0, x0 + SHOT, y0 + SHOT))
    for n, pic in enumerate((render(c), teacher(c), k or Image.new("RGB", (SHOT, SHOT), (50, 50, 50)), im)):
      sheet.paste(pic.resize((T, T), Image.LANCZOS), (n * T, y + 18))
    dr.text((6, y + 3), f"{cell_name(*c)}   new result: {lab}", fill=(230, 230, 230))
  sheet.save(out / "style_compare.jpg", quality=90)
  print(f"Saved {out / 'style_compare.jpg'}. Tell Claude: style test done")


if __name__ == "__main__":
  main()
