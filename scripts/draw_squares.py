"""Draw the map square by square with Gemini, growing outward from what's already drawn.

  uv run scripts/draw_squares.py --next 5 --dry-run     # which squares, and the cost; nothing spent
  uv run scripts/draw_squares.py --next 100              # draw them (stops at --max-euros, default 5)
  uv run scripts/make_preview_tiles.py --source drawn    # then build the site's tiles from them

Each square is drawn on its own, but Gemini sees it framed by a border of its neighbours:
the ones already drawn (so it continues them and the edges match) and the 3D photo where a
neighbour isn't drawn yet. A fixed style sample (one of the teacher drawings, set in
config.json "draw"."style_sample") goes with every request, so the look stays the same from
the first square to the last. The first square (the seed) has no drawn neighbours yet.

Order: the free square with the most drawn neighbours next to the map, closest to the seed
first - the map grows as one compact patch. Missing 3D renders are made on the way.

Gemini runs on Vertex AI when GOOGLE_CLOUD_PROJECT is set in .env (uses Google Cloud credit,
incl. the free trial; log in once with  gcloud auth application-default login ), otherwise on
AI Studio with GEMINI_API_KEY. Output: drawn/<i>_<j>.png, a log in drawn/log.jsonl.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from io import BytesIO
from pathlib import Path

from PIL import Image

from common import ROOT, cell_name, edge_match, load_config, load_env, parse_cell, render_path, shot_px
from make_pairs import PROMPT_FINE, STYLE_NOTE, copy_distance, MIN_COPY_DISTANCE
from make_preview_tiles import world_bbox

DRAWN = ROOT / "drawn"
LOG = DRAWN / "log.jsonl"
BORDER = 256  # px of each neighbour shown around the square

NOTE_CONTEXT = (
  "The image is one map square (the middle) with a border of its neighbouring squares around it "
  "(about one fifth of the width on every side). Parts of the border that are ALREADY DRAWN in the "
  "final style must be continued seamlessly: same style, colours, line weight and level of detail, "
  "and every road, roof line and park edge must line up across the join. Parts of the border that are "
  "still a photo just show what is there. Redraw the whole image as described, keeping every building "
  "at its exact position and size; only the middle square will be used."
)
NOTE_SEED = "This is the first square of a large map; set the style exactly like the style sample."


def log_entries():
  if not LOG.exists():
    return []
  return [json.loads(line) for line in LOG.read_text().splitlines() if line.strip()]


def drawn_cells():
  return {parse_cell(p.stem) for p in DRAWN.glob("*.png") if "_" in p.stem and "tmp" not in p.stem}


def plan(drawn: set, seed, bbox, skip: set, n: int):
  """The next n squares, in drawing order (assuming each one succeeds)."""
  i0, j0, i1, j1 = bbox
  have, order = set(drawn), []
  for _ in range(n):
    if not have:
      cand = {seed}
    else:
      cand = {(i + a, j + b) for i, j in have for a in (-1, 0, 1) for b in (-1, 0, 1)}
      cand = {c for c in cand if c not in have and c not in skip and i0 <= c[0] <= i1 and j0 <= c[1] <= j1}
    if not cand:
      break

    def score(c):
      side = sum((c[0] + a, c[1] + b) in have for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1)))
      diag = sum((c[0] + a, c[1] + b) in have for a, b in ((1, 1), (1, -1), (-1, 1), (-1, -1)))
      return (-(2 * side + diag), math.hypot(c[0] - seed[0], c[1] - seed[1]), c)

    c = min(cand, key=score)
    order.append(c)
    have.add(c)
  return order


def make_client():
  load_env()
  from google import genai

  project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
  if project and not project.startswith("paste-"):
    loc = os.environ.get("GOOGLE_CLOUD_LOCATION", "global")
    print(f"Gemini on Vertex AI (project {project}, {loc}) - uses your Google Cloud credit.")
    return genai.Client(vertexai=True, project=project, location=loc), "vertex"
  key = os.environ.get("GEMINI_API_KEY", "")
  if not key or key.startswith("paste-"):
    sys.exit("Set GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY (AI Studio) in .env")
  print("Gemini on AI Studio (GEMINI_API_KEY).")
  return genai.Client(api_key=key), "aistudio"


def call(client, models, contents):
  from google.genai import types

  cfg = types.GenerateContentConfig(
    response_modalities=["TEXT", "IMAGE"], image_config=types.ImageConfig(aspect_ratio="1:1", image_size="2K")
  )
  last = ""
  for m in models:
    for wait in (0, 20, 60):
      if wait:
        time.sleep(wait)
      try:
        resp = client.models.generate_content(model=m, contents=contents, config=cfg)
      except Exception as e:
        last = str(e)
        if "404" in last or "not found" in last.lower():
          break                          # try the next model name
        if "429" in last or "RESOURCE_EXHAUSTED" in last:
          print(f"      busy, waiting ({last[:120]})")
          continue
        if "403" in last or "PERMISSION_DENIED" in last or "401" in last:
          sys.exit(f"Google refused the request:\n{last[:500]}\n\nFor Vertex AI: is the Vertex AI API enabled in the "
                   "project, and did you run  gcloud auth application-default login ?")
        print(f"      error: {last[:200]}")
        return None, m
      for cand in resp.candidates or []:
        for part in (cand.content.parts if cand.content else []) or []:
          if getattr(part, "inline_data", None) and part.inline_data.data:
            models[:] = [m]              # remember the name that works
            return Image.open(BytesIO(part.inline_data.data)).convert("RGB"), m
      return None, m
  sys.exit(f"None of these models is available: {', '.join(models)}\n{last[:300]}")


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--next", type=int, default=10, help="how many squares to draw")
  ap.add_argument("--max-euros", type=float, default=5.0, help="stop when this run has spent about this much")
  ap.add_argument("--dry-run", action="store_true", help="only list the squares and the cost")
  ap.add_argument("--seed", default=None, help="first square, e.g. -3_0 (default from config)")
  args = ap.parse_args()

  cfg = load_config()
  dc = cfg.get("draw", {})
  shot = shot_px()
  bbox = world_bbox(shot)
  seed = parse_cell(args.seed or dc.get("seed", "-3_0"))
  skip = {parse_cell(s) for s in dc.get("skip", [])}
  eur = float(dc.get("eur_per_call", 0.09))
  DRAWN.mkdir(exist_ok=True)

  todo = plan(drawn_cells(), seed, bbox, skip, args.next)
  have = len(drawn_cells())
  cap = max(1, int(args.max_euros / eur))
  print(f"{have} squares drawn so far. Next {len(todo)}: {', '.join(cell_name(*c) for c in todo[:12])}"
        f"{' ...' if len(todo) > 12 else ''}")
  print(f"About EUR {len(todo) * eur * 1.15:.2f} incl. ~15% redraws (EUR {eur:.3f} per call); this run stops at "
        f"EUR {args.max_euros:.2f} (~{cap} calls).")
  around = {(c[0] + a, c[1] + b) for c in todo for a in (-1, 0, 1) for b in (-1, 0, 1)}
  missing = sorted(c for c in around if not render_path(*c).exists())
  print(f"{len(missing)} 3D renders to make first (~{len(missing) * 12 // 60 + 1} min).")
  if args.dry_run:
    return

  style = Image.open(ROOT / dc.get("style_sample", "pairs/targets/-3_-2.png")).convert("RGB").resize((768, 768), Image.LANCZOS)
  models = [dc.get("model", "gemini-3.1-flash-image"), dc.get("model", "gemini-3.1-flash-image") + "-preview"]
  client, where = make_client()

  from render import renderer

  calls = 0
  with renderer() as shoot:
    for c in missing:
      shoot(*c)
    done = 0
    while done < len(todo) and calls < cap:
      # Re-plan each time, so a square that failed doesn't leave a hole in the order.
      nxt = plan(drawn_cells(), seed, bbox, skip | {tuple(e["cell"]) for e in log_entries() if e.get("final") == "failed"}, 1)
      if not nxt:
        break
      i, j = nxt[0]
      for a in (-1, 0, 1):
        for b in (-1, 0, 1):
          shoot(i + a, j + b)
      # Canvas: 3 x 3 squares (drawn where we have them, else the photo), cut to the square + border.
      big = Image.new("RGB", (3 * shot, 3 * shot))
      n_ctx = 0
      for a in (-1, 0, 1):
        for b in (-1, 0, 1):
          dp = DRAWN / f"{cell_name(i + a, j + b)}.png"
          use_drawn = (a or b) and dp.exists()
          n_ctx += bool(use_drawn)
          im = Image.open(dp if use_drawn else render_path(i + a, j + b)).convert("RGB").resize((shot, shot))
          big.paste(im, ((a + 1) * shot, (b + 1) * shot))
      S = shot + 2 * BORDER
      canvas = big.crop((shot - BORDER, shot - BORDER, 2 * shot + BORDER, 2 * shot + BORDER))
      render = Image.open(render_path(i, j)).convert("RGB")
      note = NOTE_CONTEXT if n_ctx else NOTE_SEED
      ok = False
      for attempt in range(2):
        if calls >= cap:
          break
        calls += 1
        t0 = time.time()
        out, model = call(client, models, [PROMPT_FINE + "\n\n" + note, canvas, STYLE_NOTE, style])
        entry = {"cell": [i, j], "attempt": attempt, "model": model, "where": where, "context": n_ctx,
                 "seconds": round(time.time() - t0), "eur": eur, "t": time.strftime("%Y-%m-%dT%H:%M:%S")}
        if out is None:
          entry["status"] = "empty"
        else:
          sq = out.resize((S, S), Image.LANCZOS).crop((BORDER, BORDER, BORDER + shot, BORDER + shot))
          em = edge_match(render, sq)
          copied = copy_distance(sq, render) < MIN_COPY_DISTANCE
          entry.update(edge=round(em, 3), copied=copied)
          if em >= cfg["teacher"]["min_edge_match"] and not copied:
            tmp = DRAWN / f"{cell_name(i, j)}.tmp.png"
            sq.save(tmp)
            tmp.replace(DRAWN / f"{cell_name(i, j)}.png")
            entry["status"], ok = "accepted", True
          else:
            entry["status"] = "rejected"
        if ok or attempt == 1:
          entry["final"] = "ok" if ok else "failed"
        with LOG.open("a") as f:
          f.write(json.dumps(entry) + "\n")
        print(f"[{done + 1}/{len(todo)}] {cell_name(i, j)}  {entry['status']}"
              f"{'  edges %.2f' % entry['edge'] if 'edge' in entry else ''}  ({n_ctx} drawn neighbours, {entry['seconds']} s)",
              flush=True)
        if ok:
          break
      done += 1

  spent = calls * eur
  print(f"\nDone: {calls} Gemini calls, about EUR {spent:.2f}. {len(drawn_cells())} squares drawn in total.")
  print("Next: uv run scripts/make_preview_tiles.py --source drawn   and tell Claude: squares done")


if __name__ == "__main__":
  main()
