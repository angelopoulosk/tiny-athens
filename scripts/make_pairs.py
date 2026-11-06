"""Step 2: have Gemini redraw render shots as pixel art (the "teacher" drawings).

  uv run scripts/make_pairs.py

Each accepted drawing becomes training material for your own style model.
Every drawing is checked automatically against its render; failures are
retried, then dropped. Uses the free Gemini tier, so it waits ~7 s between
calls and stops politely if the daily quota runs out (just re-run tomorrow).
Open pairs/review.html afterwards and delete any drawing you don't like from
pairs/targets/.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import random
import sys
import time
from io import BytesIO

from PIL import Image

from common import (
  PAIRS,
  ROOT,
  atomic_save_image,
  cell_name,
  edge_match,
  flat_share,
  load_areas,
  load_config,
  load_env,
  render_path,
)

PROMPT = """Turn this aerial photo into isometric PIXEL ART, in the style of a late-1990s city-building video game such as SimCity 3000.

The result must NOT look like a photo. Replace every photographic texture with:
- clearly visible, chunky square pixels (each art pixel about 3-4 screen pixels wide), aligned to one grid;
- flat areas of solid colour from a limited palette of about 32 colours (warm whites and beiges for walls, terracotta for tiled roofs, mid greys for asphalt, a few deep greens for trees);
- crisp dark outlines along building edges and roof lines;
- simple shading in 2-3 flat tones per surface. No gradients, blur, noise or photo detail.

Keep the layout exactly: every building, street, tree and park stays in the same place, with the same shape and size, seen from the same angle, with identical framing (nothing cropped, moved or rescaled). Do not invent anything; plain areas stay plain. Leave out cars and people. No text."""

PROMPT_FINE = """Redraw this aerial photo as DETAILED isometric pixel art, like a high-quality pixel-art city poster.

It must NOT look like a photo:
- clean square pixels on one grid, each art pixel about 2 screen pixels wide;
- a rich but limited palette of about 64 colours, each surface in a few flat tones (light side, shadow side, roof);
- crisp 1-pixel dark outlines along building edges and roof lines;
- no gradients, blur, noise or photographic texture.

Keep ALL the detail and the layout exactly: every individual building, roof, rows of windows and balconies, street, tree and park stays in the same place, with the same shape and size, seen from the same angle, with identical framing (nothing cropped, moved or rescaled). Do not merge neighbouring buildings or simplify groups of houses into blobs. Do not invent anything. Leave out cars and people. No text."""

PROMPTS = {"chunky": None, "fine": PROMPT_FINE}  # None = PROMPT


STYLE_NOTE = (
  "The second image is only a STYLE sample: copy how it is drawn (pixel size, palette, outlines, shading), "
  "never what it shows. Draw only the content of the first image."
)


def pixel_snap(im: Image.Image, px: int = 3, colors: int = 40) -> Image.Image:
  """Snap a flat illustration onto a grid of px-sized square pixels with a limited palette."""
  w, h = im.size
  small = im.resize((w // px, h // px), Image.BOX)
  small = small.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
  return small.resize((w // px * px, h // px * px), Image.NEAREST).resize((w, h), Image.NEAREST)


def copy_distance(a: Image.Image, b: Image.Image) -> float:
  """Mean colour difference (0-255). Tiny = Gemini just handed back what we sent."""
  import numpy as np
  return float(np.abs(np.asarray(a, np.float32) - np.asarray(b.resize(a.size), np.float32)).mean())


MIN_COPY_DISTANCE = 18.0


def preblock(render: Image.Image) -> Image.Image:
  """Pre-block the photo into chunky flat pixels (4 px, 48 colours) before Gemini
  sees it - a strong hint that the answer should be pixel art, not a photo."""
  w, h = render.size
  small = render.resize((w // 4, h // 4), Image.BOX)
  small = small.quantize(colors=48, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
  return small.resize((w, h), Image.NEAREST)


class DailyQuotaExhausted(Exception):
  pass


def call_gemini(client, model, render: Image.Image, style: Image.Image | None, key: str = "", prompt: str | None = None) -> Image.Image | None:
  from google.genai import types

  contents = [prompt or PROMPT, render]
  if style is not None:
    contents += [STYLE_NOTE, style]
  try:
    cfg = types.GenerateContentConfig(
      response_modalities=["TEXT", "IMAGE"],
      image_config=types.ImageConfig(aspect_ratio="1:1"),
    )
  except Exception:  # older google-genai without ImageConfig
    cfg = types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"])

  for wait in (0, 30, 60, 120):
    if wait:
      print(f"      rate limited, waiting {wait}s")
      time.sleep(wait)
    try:
      resp = client.models.generate_content(model=model, contents=contents, config=cfg)
    except Exception as e:
      msg = str(e)
      if "API key not valid" in msg or "API_KEY_INVALID" in msg or "ACCESS_TOKEN_TYPE_UNSUPPORTED" in msg:
        sys.exit(
          f"Gemini refused the request with model '{model}'.\n{msg[:400]}\n\n"
          "Google gives this same 'API key not valid' error when a model has been retired.\n"
          "Set GEMINI_IMAGE_MODEL in .env to one of the image models listed above and run again."
        )
      if "403" in msg or "PERMISSION_DENIED" in msg:
        sys.exit(f"Gemini refused this key (permission denied). Full message:\n{msg[:400]}")
      if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
        print(f"      Gemini said: {msg[:300]}")
        if "PerDay" in msg or "per day" in msg.lower() or "daily" in msg.lower():
          raise DailyQuotaExhausted(msg) from e
        continue
      if "404" in msg or "not found" in msg.lower():
        sys.exit(f"Model '{model}' not found. Check GEMINI_IMAGE_MODEL in .env.\n{msg}")
      print(f"      Gemini error: {msg[:300]}")
      return None
    for cand in resp.candidates or []:
      for part in (cand.content.parts if cand.content else []) or []:
        if getattr(part, "inline_data", None) and part.inline_data.data:
          return Image.open(BytesIO(part.inline_data.data)).convert("RGB")
    return None
  raise DailyQuotaExhausted("still rate limited after several waits")


def pick_model(client, wanted: str) -> str:
  """Ask Google which models this key can use; if the configured image model
  is gone (retired models fail with a misleading 401), pick the newest image one."""
  try:
    names = [m.name.split("/", 1)[-1] for m in client.models.list()]
  except Exception as e:
    msg = str(e)
    if "401" in msg or "403" in msg or "API key" in msg:
      sys.exit(
        f"Google rejected GEMINI_API_KEY even for listing models, so the key itself isn't working.\n{msg[:400]}\n\n"
        "Make a new key at https://aistudio.google.com/apikey (keys starting with 'AQ.' are normal now),\n"
        "paste it into .env, and run again."
      )
    print(f"(Couldn't list models, using '{wanted}': {msg[:200]})")
    return wanted
  images = [n for n in names if "image" in n and "gemini" in n and "preview" not in n] or \
           [n for n in names if "image" in n and "gemini" in n]
  print("Image models your key can use: " + (", ".join(images) or "none"))
  if wanted in names:
    return wanted
  if not images:
    sys.exit("Your key works, but Google offers it no Gemini image models. Check https://aistudio.google.com.")
  def ver(n):
    import re
    return [float(x) for x in re.findall(r"\d+(?:\.\d+)?", n)] or [0]
  best = max((n for n in images if "flash" in n), key=ver, default=max(images, key=ver))
  print(f"'{wanted}' isn't available any more; using '{best}' instead.")
  return best


def write_review(log: list[dict]) -> None:
  rows = []
  for e in sorted(log, key=lambda e: (e["status"] != "accepted", e["name"])):
    tgt = f"targets/{e['name']}.png" if e["status"] == "accepted" else f"rejected/{e['name']}_{e['attempt']}.png"
    rows.append(
      f"<div class='row {e['status']}'><img src='../renders/{e['name']}.png'><img src='{tgt}'>"
      f"<p><b>{html.escape(e['name'])}</b> {e['status']} &middot; flat {e['flat']:.2f} &middot; edges {e['edge']:.2f}</p></div>"
    )
  page = f"""<!doctype html><meta charset=utf-8><title>Teacher drawings</title>
<style>body{{font:14px system-ui;background:#1d2024;color:#ddd;margin:16px}}
.row{{display:inline-block;margin:8px;padding:6px;background:#2a2e33;border-radius:6px}}
.row img{{width:300px;height:300px;image-rendering:pixelated;margin:2px}}
.rejected{{opacity:.55}} b{{color:#fff}}</style>
<h2>Teacher drawings: render (left) and drawing (right)</h2>
<p>Accepted drawings live in <code>pairs/targets/</code>. Delete any you don't like there before training.
Faded rows were rejected by the automatic checks.</p>
{''.join(rows)}"""
  (PAIRS / "review.html").write_text(page)


def run_test(client, key, style, tc):
  """Small paid experiment: 2 frames x (3 Pro, 3.1 Flash) with the detailed prompt.
  The sheet shows each raw drawing and the same drawing after a fine pixel snap."""
  from PIL import ImageDraw

  areas = load_areas()
  a = next(iter(areas.values()))
  frames = [tuple(a["cells"][len(a["cells"]) // 2]), tuple(a["train"][0] if a["train"] else a["margin"][0])]
  models = ["gemini-3-pro-image", "gemini-3.1-flash-image"]
  snap_px, snap_colors = 2, 64
  out = PAIRS / "test_fine"
  out.mkdir(parents=True, exist_ok=True)
  rows, results = [], []
  for (i, j) in frames:
    render = Image.open(render_path(i, j)).convert("RGB")
    row = [("render " + cell_name(i, j), render)]
    for m in models:
      print(f"{cell_name(i, j)}  {m}  (detailed prompt) ...", flush=True)
      t0 = time.time()
      try:
        d = call_gemini(client, m, render, style, key, prompt=PROMPT_FINE)
      except DailyQuotaExhausted as e:
        print(f"   quota/rate problem: {str(e)[:200]}")
        d = None
      if d is None:
        row += [(f"{m}: failed", Image.new("RGB", render.size, (60, 60, 60)))] * 2
        continue
      d = d.resize(render.size, Image.LANCZOS)
      sn = pixel_snap(d, snap_px, snap_colors)
      fs, em = flat_share(sn), edge_match(render, sn)
      ok = fs >= tc["min_flat_share"] and em >= tc["min_edge_match"]
      print(f"   {time.time() - t0:.0f}s  snapped: flat {fs:.2f}  edges {em:.2f}  -> {'PASS' if ok else 'fail'}", flush=True)
      results.append((m, fs, em, ok))
      d.save(out / f"{cell_name(i, j)}_{m}.png")
      sn.save(out / f"{cell_name(i, j)}_{m}_snapped.png")
      row += [(f"{m} raw", d), (f"{m} snapped  flat {fs:.2f} edges {em:.2f}", sn)]
      time.sleep(tc["seconds_between_calls"])
    rows.append(row)
  T = 400
  sheet = Image.new("RGB", (T * max(len(r) for r in rows), (T + 24) * len(rows)), (30, 32, 36))
  dr = ImageDraw.Draw(sheet)
  for y, row in enumerate(rows):
    for x, (label, im) in enumerate(row):
      sheet.paste(im.resize((T, T), Image.LANCZOS), (x * T, y * (T + 24) + 24))
      dr.text((x * T + 4, y * (T + 24) + 6), label, fill=(230, 230, 230))
  sheet.save(out / "compare.jpg", quality=90)
  print(f"\nSaved {out / 'compare.jpg'}")
  for m in models:
    r = [x for x in results if x[0] == m]
    if r:
      print(f"{m:24s} passed {sum(x[3] for x in r)}/{len(r)}, flat {sum(x[1] for x in r)/len(r):.2f}, edges {sum(x[2] for x in r)/len(r):.2f}")


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--max", type=int, default=None, help="max frames (default from config)")
  ap.add_argument("--test", action="store_true",
                  help="try 2 frames with Gemini 3 Pro and 3.1 Flash (detailed prompt) and save a comparison; 4 drawings")
  args = ap.parse_args()

  load_env()
  cfg = load_config()
  tc = cfg["teacher"]
  key = os.environ.get("GEMINI_API_KEY", "")
  if not key or key.startswith("paste-"):
    sys.exit("GEMINI_API_KEY is missing from .env")
  model = tc.get("model") or os.environ.get("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")

  from google import genai

  client = genai.Client(api_key=key)
  model = pick_model(client, model)
  style = None
  if tc.get("use_style_ref"):
    style = Image.open(ROOT / "assets" / "style_ref.png").convert("RGB").resize((768, 768), Image.LANCZOS)

  if args.test:
    run_test(client, key, style, tc)
    return

  # Frames: every rendered shot of every area (area, ring and training shots).
  areas = load_areas()
  if not areas:
    sys.exit("Nothing rendered yet. Run scripts/render.py first.")
  primary, secondary = [], []
  for a in areas.values():
    primary += [tuple(c) for c in a["cells"]]
    secondary += [tuple(c) for c in a["margin"]] + [tuple(c) for c in a["train"]]
  random.Random(1).shuffle(secondary)
  frames, seen = [], set()
  for c in primary + secondary:
    if c not in seen and render_path(*c).exists():
      seen.add(c)
      frames.append(c)
  frames = frames[: args.max or tc["max_frames"]]

  (PAIRS / "targets").mkdir(parents=True, exist_ok=True)
  (PAIRS / "rejected").mkdir(parents=True, exist_ok=True)
  log_path = PAIRS / "log.jsonl"
  log = [json.loads(line) for line in log_path.read_text().splitlines()] if log_path.exists() else []
  finished = {e["name"] for e in log if e["status"] == "accepted" or e.get("final")}

  todo = [c for c in frames if cell_name(*c) not in finished]
  print(f"{len(frames)} frames chosen, {len(todo)} still to draw (about {len(todo) * 25 // 60 + 1} min).")

  accepted = sum(1 for e in log if e["status"] == "accepted")
  try:
    for n, (i, j) in enumerate(todo, 1):
      name = cell_name(i, j)
      render = Image.open(render_path(i, j)).convert("RGB")
      sent = preblock(render) if tc.get("preblock") else render
      for attempt in range(tc["retries"] + 1):
        t0 = time.time()
        drawing = call_gemini(client, model, sent, style, key, prompt=PROMPTS.get(tc.get("prompt", "chunky")))
        if drawing is None:
          status, fs, em = "rejected", 0.0, 0.0
        else:
          drawing = drawing.resize(render.size, Image.LANCZOS)
          if tc.get("snap_px"):
            drawing = pixel_snap(drawing, tc["snap_px"], tc.get("snap_colors", 40))
          fs, em = flat_share(drawing), edge_match(render, drawing)
          copied = sent is not render and copy_distance(drawing, sent) < MIN_COPY_DISTANCE
          ok = fs >= tc["min_flat_share"] and em >= tc["min_edge_match"] and not copied
          status = "accepted" if ok else "rejected"
          if ok:
            atomic_save_image(drawing, PAIRS / "targets" / f"{name}.png")
          else:
            atomic_save_image(drawing, PAIRS / "rejected" / f"{name}_{attempt}.png")
        final = status == "accepted" or attempt == tc["retries"]
        entry = {"name": name, "attempt": attempt, "status": status, "flat": fs, "edge": em, "final": final}
        log.append(entry)
        with open(log_path, "a") as f:
          f.write(json.dumps(entry) + "\n")
        print(f"[{n}/{len(todo)}] {name} try {attempt + 1}: {status} (flat {fs:.2f}, edges {em:.2f})")
        time.sleep(max(0.0, tc["seconds_between_calls"] - (time.time() - t0)))
        if status == "accepted":
          accepted += 1
          break
  except DailyQuotaExhausted:
    print("\nThe free Gemini quota for today is used up. Run this again tomorrow; it picks up where it stopped.")
  except KeyboardInterrupt:
    print("\nStopped. Run again to continue.")
  finally:
    write_review(log)

  print(f"\n{accepted} accepted drawings in pairs/targets/. Review them: open pairs/review.html")
  scored = [e for e in log if e["flat"] > 0]
  if scored:
    fl = sorted(e["flat"] for e in scored)[len(scored) // 2]
    ed = sorted(e["edge"] for e in scored)[len(scored) // 2]
    print(f"Typical scores: flat {fl:.2f} (need {tc['min_flat_share']}), edges {ed:.2f} (need {tc['min_edge_match']}).")
    rate = accepted / max(1, len({e['name'] for e in log}))
    if rate < 0.3:
      print("Few drawings pass. If the rejected ones in review.html look fine to you, lower")
      print("min_flat_share / min_edge_match in config.json a little and run again.")
  if accepted < 40:
    print("Tip: aim for at least 60-100 before training.")


if __name__ == "__main__":
  main()
