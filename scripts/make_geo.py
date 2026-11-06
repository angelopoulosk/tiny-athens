"""Build viewer/geo.json: the table that turns GPS positions into map pixels.

  uv run scripts/make_geo.py          (make_tiles.py also runs this at the end)

The map is drawn from a slanted camera, so where a GPS point lands on the map
depends on how high the ground is there. This script lays a 40 m grid over
every rendered area, measures the ground height at each grid point from
Google's 3D tiles (lowest of a few samples, to skip roofs and trees), and
stores the exact map pixel of each point. The viewer interpolates in that
grid to place live buses and trolleys.

Measured heights are cached in out/ground_heights.json, so after adding an
area only the new part is measured.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import time
import urllib.request

import numpy as np

from common import OUT, ROOT, VIEWER, atomic_write_text, load_areas, load_config, load_env

PORT = 5181
CHROMIUM_ARGS = ["--enable-webgl", "--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"]
SPACING_M = 40.0
PAD_PX = 400  # also cover a strip around the cells (ground height moves points on screen)
CACHE = OUT / "ground_heights.json"


def wait_for_server(url: str, timeout: float = 60) -> bool:
  t0 = time.time()
  while time.time() - t0 < timeout:
    try:
      urllib.request.urlopen(url, timeout=2)
      return True
    except Exception:
      time.sleep(0.5)
  return False


def grid_nodes(cam: dict, areas_cfg: dict):
  """Grid indices (k, l) around every area, anchored to the fixed camera origin so
  the same node always has the same index (that's what makes the cache reusable)."""
  lat0, lon0 = cam["origin_lat"], cam["origin_lon"]
  dlat = SPACING_M / 111320.0
  dlon = dlat / math.cos(math.radians(lat0))
  shot_m = cam["shot_px"] * cam["meters_per_pixel"]
  nodes = set()
  for a in areas_cfg.values():
    # Generous radius: slanted view stretches the ground in depth by 1/sin(45°).
    rx = (a["shots_x"] / 2 + 2) * shot_m
    ry = (a["shots_y"] / 2 + 2) * shot_m * 1.5
    r = math.hypot(rx, ry)
    kc = round((a["center_lat"] - lat0) / dlat)
    lc = round((a["center_lon"] - lon0) / dlon)
    n = int(r / SPACING_M) + 1
    for k in range(kc - n, kc + n + 1):
      for l in range(lc - n, lc + n + 1):
        nodes.add((k, l))
  return lat0, lon0, dlat, dlon, sorted(nodes)


def main():
  load_env()
  cfg = load_config()
  cam = cfg["camera"]
  shot = cam["shot_px"]
  areas = load_areas()
  if not areas:
    sys.exit("Nothing rendered yet. Run scripts/render.py first.")
  cells = set()
  for a in areas.values():
    cells |= {tuple(c) for c in a["cells"]} | {tuple(c) for c in a["margin"]}
  areas_cfg = {k: v for k, v in cfg["areas"].items() if k in areas}

  lat0, lon0, dlat, dlon, nodes = grid_nodes(cam, areas_cfg)
  latlon = [(lat0 + k * dlat, lon0 + l * dlon) for k, l in nodes]
  cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
  key = lambda kl: f"{kl[0]},{kl[1]}"

  from playwright.sync_api import sync_playwright

  vite = subprocess.Popen(
    ["npx", "vite", "--port", str(PORT), "--strictPort"], cwd=ROOT / "render",
    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
  )
  if not wait_for_server(f"http://localhost:{PORT}/"):
    err = vite.stderr.read().decode() if vite.poll() is not None else ""
    vite.kill()
    sys.exit(f"Could not start the renderer.\n{err}")
  try:
    with sync_playwright() as p:
      browser = p.chromium.launch(headless=True, args=CHROMIUM_ARGS)
      page = browser.new_page(viewport={"width": shot, "height": shot}, device_scale_factor=1)
      page.goto(f"http://localhost:{PORT}/")
      page.wait_for_function("window.READY === true || window.RENDER_ERROR", timeout=60000)
      if page.evaluate("window.RENDER_ERROR"):
        sys.exit(f"Renderer error: {page.evaluate('window.RENDER_ERROR')}")

      def project(pts_h):
        return page.evaluate("pts => pts.map(p => latLonToPx(p[0], p[1], p[2]))", pts_h)

      # Keep only nodes that land on (or near) a rendered cell.
      first = project([[la, lo, cam["origin_height_m"]] for la, lo in latlon])
      def near_cells(px, py):
        ci, cj = math.floor(px / shot), math.floor(py / shot)
        for di in (-1, 0, 1):
          for dj in (-1, 0, 1):
            c = (ci + di, cj + dj)
            if c in cells:
              x0, y0 = c[0] * shot - PAD_PX, c[1] * shot - PAD_PX
              if x0 <= px < x0 + shot + 2 * PAD_PX and y0 <= py < y0 + shot + 2 * PAD_PX:
                return True
        return False
      keep = [n for n, (px, py) in enumerate(first) if near_cells(px, py)]
      print(f"{len(keep)} grid points ({SPACING_M:.0f} m apart) cover the rendered areas.")

      # Measure heights, shot by shot (only tiles near the current shot are loaded).
      # Two rounds: the second retries points whose first guess fell in the wrong shot.
      est = {n: cache.get(key(nodes[n])) for n in keep}
      for rnd in (1, 2):
        todo = [n for n in keep if key(nodes[n]) not in cache]
        if not todo:
          break
        known = [h for h in est.values() if h is not None]
        guess_h = float(np.median(known)) if known else cam["origin_height_m"]
        pos = project([[*latlon[n], est[n] if est[n] is not None else guess_h] for n in todo])
        by_shot: dict[tuple[int, int], list[int]] = {}
        for n, (px, py) in zip(todo, pos):
          by_shot.setdefault((math.floor(px / shot), math.floor(py / shot)), []).append(n)
        if rnd == 2:  # only revisit shots with many gaps; scattered ones are filled from neighbours
          by_shot = {c: ns for c, ns in by_shot.items() if len(ns) >= 8}
          if not by_shot:
            break
        print(f"Round {rnd}: measuring {len(todo)} points across {len(by_shot)} shots (about {len(by_shot) * 15 // 60 + 1} min)...")
        for s, (c, ns) in enumerate(sorted(by_shot.items()), 1):
          page.evaluate(f"setShot({c[0]}, {c[1]})")
          try:
            page.wait_for_function("window.TILES_LOADED === true", timeout=120000, polling=250)
          except Exception:
            print(f"   shot {c}: tiles still loading after 2 min, measuring anyway")
          hs = page.evaluate("pts => groundHeights(pts)", [list(latlon[n]) for n in ns])
          for n, h in zip(ns, hs):
            if h is not None:
              est[n] = h
              cache[key(nodes[n])] = round(h, 1)
          if s % 10 == 0 or s == len(by_shot):
            print(f"   {s}/{len(by_shot)} shots done")
        atomic_write_text(CACHE, json.dumps(cache))

      # Put the points on a regular array for cleanup and output.
      ks = [nodes[n][0] for n in keep]
      ls = [nodes[n][1] for n in keep]
      k_min, l_min = min(ks), min(ls)
      ny, nx = max(ks) - k_min + 1, max(ls) - l_min + 1
      H = np.full((ny, nx), np.nan)
      M = np.zeros((ny, nx), bool)
      for n in keep:
        r, c = nodes[n][0] - k_min, nodes[n][1] - l_min
        M[r, c] = True
        if est[n] is not None:
          H[r, c] = est[n]

      # Roof/tree hits that slipped through stick out above their neighbours: flatten them.
      def neigh_median(A):
        P = np.pad(A, 1, constant_values=np.nan)
        stack = np.stack([P[1 + dr: 1 + dr + ny, 1 + dc: 1 + dc + nx] for dr in (-1, 0, 1) for dc in (-1, 0, 1)])
        with np.errstate(all="ignore"):
          import warnings
          with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return np.nanmedian(stack, axis=0)
      med = neigh_median(H)
      spikes = (H > med + 12) & M
      H[spikes] = med[spikes]
      # Fill points that couldn't be measured from their neighbours.
      for _ in range(50):
        missing = M & np.isnan(H)
        if not missing.any():
          break
        med = neigh_median(H)
        H[missing] = med[missing]
      H[M & np.isnan(H)] = cam["origin_height_m"]
      print(f"Ground heights {np.nanmin(H[M]):.0f}-{np.nanmax(H[M]):.0f} m; {int(spikes.sum())} roof hits flattened.")

      # Exact map pixel of every grid point at its ground height.
      idx = [(r, c) for r in range(ny) for c in range(nx) if M[r, c]]
      pts = [[lat0 + (r + k_min) * dlat, lon0 + (c + l_min) * dlon, float(H[r, c])] for r, c in idx]
      pix = project(pts)
      browser.close()
  finally:
    vite.terminate()

  PX = [None] * (ny * nx)
  PY = [None] * (ny * nx)
  for (r, c), (px, py) in zip(idx, pix):
    PX[r * nx + c] = round(px, 1)
    PY[r * nx + c] = round(py, 1)
  geo = {
    "about": "GPS -> global map pixel grid for live transit. Made by scripts/make_geo.py.",
    "lat0": lat0 + k_min * dlat, "lon0": lon0 + l_min * dlon, "dlat": dlat, "dlon": dlon,
    "ny": ny, "nx": nx, "px": PX, "py": PY,
    "bbox": [lat0 + k_min * dlat, lon0 + l_min * dlon, lat0 + (k_min + ny - 1) * dlat, lon0 + (l_min + nx - 1) * dlon],
  }
  atomic_write_text(VIEWER / "geo.json", json.dumps(geo, separators=(",", ":")))
  print(f"Wrote {VIEWER / 'geo.json'} ({nx} x {ny} grid).")


if __name__ == "__main__":
  main()
