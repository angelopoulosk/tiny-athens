"""Step 1: render an area of Athens from Google's 3D tiles.

  uv run scripts/render.py --area pilot

Renders the area's shots, one ring of shots around it (context for later
steps), and some random extra shots nearby (training material only).
Already rendered shots are skipped, so you can stop and re-run any time.
"""

from __future__ import annotations

import argparse
import random
import subprocess
import sys
import time
import urllib.request
from contextlib import contextmanager
from io import BytesIO

import numpy as np
from PIL import Image

from common import (
  OUT,
  RENDERS,
  ROOT,
  area_cells,
  atomic_save_image,
  cell_name,
  load_areas,
  load_config,
  load_env,
  render_path,
  ring,
  save_areas,
)

PORT = 5179
CHROMIUM_ARGS = ["--enable-webgl", "--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"]


def wait_for_server(url: str, timeout: float = 60) -> bool:
  t0 = time.time()
  while time.time() - t0 < timeout:
    try:
      urllib.request.urlopen(url, timeout=2)
      return True
    except Exception:
      time.sleep(0.5)
  return False


def start_vite():
  proc = subprocess.Popen(
    ["npx", "vite", "--port", str(PORT), "--strictPort"],
    cwd=ROOT / "render",
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE,
  )
  if not wait_for_server(f"http://localhost:{PORT}/"):
    err = proc.stderr.read().decode() if proc.poll() is not None else ""
    proc.kill()
    sys.exit(f"Renderer web server did not start. Did setup.sh finish?\n{err}")
  return proc


def looks_empty(img: Image.Image) -> bool:
  a = np.asarray(img.convert("RGB")).astype(np.int16)
  sky = (abs(a[:, :, 0] - 0x87) < 6) & (abs(a[:, :, 1] - 0xCE) < 6) & (abs(a[:, :, 2] - 0xEB) < 6)
  return sky.mean() > 0.9 or a.std() < 8


@contextmanager
def renderer(show: bool = False):
  """Open the 3D renderer once and yield shoot(i, j), which renders one square of the
  lattice to renders/ (skipping squares already there) and returns its path."""
  load_env()
  shot = load_config()["camera"]["shot_px"]
  from playwright.sync_api import sync_playwright

  RENDERS.mkdir(parents=True, exist_ok=True)
  vite = start_vite()
  try:
    with sync_playwright() as p:
      browser = p.chromium.launch(headless=not show, args=CHROMIUM_ARGS)
      page = browser.new_page(viewport={"width": shot, "height": shot}, device_scale_factor=1)
      page.on("console", lambda m: m.type == "error" and print("   [browser]", m.text))
      page.goto(f"http://localhost:{PORT}/")
      page.wait_for_function("window.READY === true || window.RENDER_ERROR", timeout=60000)
      err = page.evaluate("window.RENDER_ERROR")
      if err:
        sys.exit(f"Renderer error: {err}")

      def shoot(i: int, j: int):
        if render_path(i, j).exists():
          return render_path(i, j)
        for attempt in range(3):
          page.evaluate(f"setShot({i}, {j})")
          try:
            page.wait_for_function("window.TILES_LOADED === true", timeout=120000, polling=250)
          except Exception:
            print(f"   shot {cell_name(i, j)}: tiles still loading after 2 min, taking it anyway")
          img = Image.open(BytesIO(page.locator("canvas").screenshot(type="png"))).convert("RGB")
          if img.size != (shot, shot):
            img = img.resize((shot, shot), Image.LANCZOS)
          if looks_empty(img) and attempt < 2:
            time.sleep(3)
            continue
          atomic_save_image(img, render_path(i, j))
          break
        return render_path(i, j)

      yield shoot
      browser.close()
  finally:
    vite.terminate()


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--area", default="pilot", help="area name from config.json")
  ap.add_argument("--no-extra", action="store_true", help="skip the random training shots")
  ap.add_argument("--show", action="store_true", help="show the browser window")
  args = ap.parse_args()

  load_env()
  cfg = load_config()
  if args.area not in cfg["areas"]:
    sys.exit(f"No area '{args.area}' in config.json. Known: {', '.join(cfg['areas'])}")
  area = cfg["areas"][args.area]
  shot = cfg["camera"]["shot_px"]

  from playwright.sync_api import sync_playwright

  RENDERS.mkdir(parents=True, exist_ok=True)
  OUT.mkdir(parents=True, exist_ok=True)
  vite = start_vite()
  try:
    with sync_playwright() as p:
      browser = p.chromium.launch(headless=not args.show, args=CHROMIUM_ARGS)
      page = browser.new_page(viewport={"width": shot, "height": shot}, device_scale_factor=1)
      page.on("console", lambda m: m.type == "error" and print("   [browser]", m.text))
      page.goto(f"http://localhost:{PORT}/")
      page.wait_for_function("window.READY === true || window.RENDER_ERROR", timeout=60000)
      err = page.evaluate("window.RENDER_ERROR")
      if err:
        sys.exit(f"Renderer error: {err}")

      # Work out which lattice cells the area covers, using the page's own projection.
      center = page.evaluate(f"latLonToPx({area['center_lat']}, {area['center_lon']})")
      cells = area_cells(center, area["shots_x"], area["shots_y"], shot)
      margin = ring(cells)

      areas = load_areas()
      prev = areas.get(args.area)
      if prev and sorted(map(tuple, prev["cells"])) != sorted(cells):
        print(f"Note: area '{args.area}' changed in config.json; using the new cells.")
      extra = []
      if not args.no_extra:
        tc = cfg["train"]
        rng = random.Random(f"{tc['seed']}-{args.area}")
        r = tc["radius_shots"]
        ci, cj = cells[len(cells) // 2]
        taken = set(cells) | set(margin)
        tries = 0
        while len(extra) < tc["extra_shots"] and tries < 10000:
          tries += 1
          c = (ci + rng.randint(-r, r), cj + rng.randint(-r, r))
          if c not in taken:
            taken.add(c)
            extra.append(c)
      areas[args.area] = {"cells": cells, "margin": margin, "train": extra}
      save_areas(areas)

      todo = [("area", c) for c in cells] + [("margin", c) for c in margin] + [("train", c) for c in extra]
      todo = [(k, c) for k, c in todo if not render_path(*c).exists()]
      print(f"Area '{args.area}': {len(cells)} shots + {len(margin)} around it + {len(extra)} training shots.")
      print(f"{len(todo)} still to render (about {len(todo) * 12 // 60 + 1} min).")

      for n, (kind, (i, j)) in enumerate(todo, 1):
        for attempt in range(3):
          page.evaluate(f"setShot({i}, {j})")
          try:
            page.wait_for_function("window.TILES_LOADED === true", timeout=120000, polling=250)
          except Exception:
            print(f"   shot {cell_name(i, j)}: tiles still loading after 2 min, taking it anyway")
          png = page.locator("canvas").screenshot(type="png")
          img = Image.open(BytesIO(png)).convert("RGB")
          if img.size != (shot, shot):
            img = img.resize((shot, shot), Image.LANCZOS)
          if looks_empty(img) and attempt < 2:
            print(f"   shot {cell_name(i, j)} looks empty, retrying")
            time.sleep(3)
            continue
          atomic_save_image(img, render_path(i, j))
          break
        print(f"[{n}/{len(todo)}] {kind:6s} {cell_name(i, j)}")

      browser.close()
  finally:
    vite.terminate()

  # A stitched preview of the area so you can check it at a glance.
  from common import assemble

  i0 = min(c[0] for c in cells)
  j0 = min(c[1] for c in cells)
  w = (max(c[0] for c in cells) - i0 + 1) * shot
  h = (max(c[1] for c in cells) - j0 + 1) * shot
  canvas, _ = assemble(render_path, i0 * shot, j0 * shot, w, h, shot)
  prev_img = Image.fromarray(canvas)
  prev_img.thumbnail((3000, 3000))
  out = OUT / f"render_{args.area}.jpg"
  prev_img.save(out, quality=88)
  print(f"\nDone. Preview of the area: {out}")


if __name__ == "__main__":
  main()
