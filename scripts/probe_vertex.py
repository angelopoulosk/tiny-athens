"""Quick check of Gemini on Vertex AI: is it reachable, and how long does an image take?

  uv run scripts/probe_vertex.py

1) a tiny text request (fractions of a cent), 2) one small 1K image with a one-line
prompt (~EUR 0.06), 3) the same at 2K with an input image like draw_squares.py sends
(~EUR 0.09). Prints how long each took and what came back.
"""

from __future__ import annotations

import os
import sys
import time
from io import BytesIO

from PIL import Image

from common import load_env, render_path


def main():
  load_env()
  from google import genai
  from google.genai import types

  project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
  loc = os.environ.get("GOOGLE_CLOUD_LOCATION", "global")
  if not project:
    sys.exit("GOOGLE_CLOUD_PROJECT is not set in .env")
  client = genai.Client(vertexai=True, project=project, location=loc,
                        http_options=types.HttpOptions(timeout=240_000))
  print(f"Vertex AI, project {project}, location {loc}")

  def run(label, model, contents, cfg=None):
    t0 = time.time()
    try:
      r = client.models.generate_content(model=model, contents=contents, config=cfg)
    except Exception as e:
      print(f"{label}: FAILED after {time.time() - t0:.0f} s: {str(e)[:300]}")
      return
    img = None
    for c in r.candidates or []:
      for p in (c.content.parts if c.content else []) or []:
        if getattr(p, "inline_data", None) and p.inline_data.data:
          img = Image.open(BytesIO(p.inline_data.data))
    fin = [str(getattr(c, "finish_reason", "")) for c in r.candidates or []]
    txt = ""
    try:
      txt = (r.text or "").strip().replace("\n", " ")[:120]
    except Exception:
      pass
    print(f"{label}: {time.time() - t0:.0f} s, image={img.size if img else None}, finish={fin}, text={txt!r}")

  run("1 text", "gemini-2.5-flash", "Reply with the single word: ok")
  img_cfg = lambda size: types.GenerateContentConfig(
    response_modalities=["TEXT", "IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1", image_size=size))
  run("2 image 1K", "gemini-3.1-flash-image", "A small isometric pixel-art house on a white background.", img_cfg("1K"))
  r = render_path(-3, 0)
  if r.exists():
    im = Image.open(r).convert("RGB")
    run("3 image 2K + input", "gemini-3.1-flash-image",
        ["Redraw this aerial photo as a soft painted isometric city illustration, same layout.", im], img_cfg("2K"))


if __name__ == "__main__":
  main()
