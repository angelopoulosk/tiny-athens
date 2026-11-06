"""Trace the tram and metro Line 1 routes along the real rails from OpenStreetMap.

  python3 scripts/make_rail.py          (standard library only; needs internet)

The live feed (athens-transit-rt /v2/lines/stasy:<line>) gives each pattern's route as a
coarse outline (tens of points for 10+ km), so drawn as straight lines it cuts across
blocks. This script downloads the rail tracks from OpenStreetMap (Overpass API), builds a
track graph along each route's corridor, and replaces every pair of consecutive outline
points with the shortest path along the tracks. Output: viewer/rail.json, used by the site
to draw followed rail lines and to keep trams and trains on their tracks.

Runs on GitHub Actions (.github/workflows/rail.yml), monthly and on demand.
"""

from __future__ import annotations

import heapq
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "viewer" / "rail.json"
API = "https://transit.haroldpoi.dev"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "tiny-athens/1.0 (https://github.com/angelopoulosk/tiny-athens)"}

# Lines drawn on the map, and which OSM railway types make up their tracks.
LINES = {
  "T6": {"railway": {"tram"}},
  "T7": {"railway": {"tram"}},
  "M1": {"railway": {"subway", "light_rail", "rail"}},
}
BBOX = (37.85, 23.58, 38.12, 23.86)  # south, west, north, east (Athens basin)
CORRIDOR_M = 120   # only tracks this close to the coarse route are used
SNAP_M = 150       # a coarse point further than this from any track is kept as it is


def get_json(url: str, data: bytes | None = None, tries: int = 3):
  for k in range(tries):
    try:
      req = urllib.request.Request(url, data=data, headers=UA)
      with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())
    except Exception as e:  # network hiccups, Overpass busy
      print(f"  {url[:60]}... failed ({e}); retry {k + 1}/{tries}", file=sys.stderr)
      time.sleep(10 * (k + 1))
  raise SystemExit(f"Could not fetch {url}")


def dist_m(a, b) -> float:
  dy = (b[0] - a[0]) * 111320.0
  dx = (b[1] - a[1]) * 111320.0 * math.cos(math.radians((a[0] + b[0]) / 2))
  return math.hypot(dx, dy)


def densify(pts, step=25.0):
  out = [pts[0]]
  for a, b in zip(pts, pts[1:]):
    n = max(1, int(dist_m(a, b) // step))
    for k in range(1, n + 1):
      t = k / n
      out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
  return out


class Grid:
  """Coarse spatial hash for nearest-point lookups (~100 m cells)."""

  def __init__(self, cell=0.001):
    self.cell, self.items = cell, {}

  def key(self, p):
    return (int(p[0] // self.cell), int(p[1] // self.cell))

  def add(self, p, v):
    self.items.setdefault(self.key(p), []).append((p, v))

  def near(self, p, r_cells=2):
    ki, kj = self.key(p)
    for di in range(-r_cells, r_cells + 1):
      for dj in range(-r_cells, r_cells + 1):
        yield from self.items.get((ki + di, kj + dj), ())


def overpass_tracks():
  s, w, n, e = BBOX
  q = f"""[out:json][timeout:120];
  (way["railway"~"^(tram|subway|light_rail|rail)$"]({s},{w},{n},{e}););
  out body; >; out skel qt;"""
  for url in OVERPASS:
    try:
      return get_json(url, urllib.parse.urlencode({"data": q}).encode())
    except SystemExit:
      continue
  raise SystemExit("Overpass unavailable")


def douglas_peucker(pts, tol_m=1.5):
  if len(pts) < 3:
    return pts
  a, b = pts[0], pts[-1]
  best, idx = -1.0, 0
  for i in range(1, len(pts) - 1):
    p = pts[i]
    # distance from p to segment a-b, in metres (local flat approximation)
    ax, ay = 0.0, 0.0
    bx = (b[1] - a[1]) * 111320 * math.cos(math.radians(a[0]))
    by = (b[0] - a[0]) * 111320
    px = (p[1] - a[1]) * 111320 * math.cos(math.radians(a[0]))
    py = (p[0] - a[0]) * 111320
    L2 = bx * bx + by * by
    t = 0 if L2 == 0 else max(0, min(1, (px * bx + py * by) / L2))
    d = math.hypot(px - t * bx, py - t * by)
    if d > best:
      best, idx = d, i
  if best <= tol_m:
    return [a, b]
  return douglas_peucker(pts[: idx + 1], tol_m)[:-1] + douglas_peucker(pts[idx:], tol_m)


def main():
  print("Downloading rail tracks from OpenStreetMap...")
  osm = overpass_tracks()
  nodes = {el["id"]: (el["lat"], el["lon"]) for el in osm["elements"] if el["type"] == "node"}
  ways = [el for el in osm["elements"] if el["type"] == "way"]
  print(f"  {len(ways)} track ways, {len(nodes)} nodes")

  out = {"about": "Tram and metro Line 1 routes traced along OpenStreetMap rails by scripts/make_rail.py. "
                  "Track data (c) OpenStreetMap contributors, ODbL.",
         "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lines": {}}

  for line, spec in LINES.items():
    print(f"Line {line}:")
    d = get_json(f"{API}/v2/lines/stasy:{urllib.parse.quote(line)}")
    coarse_all = [densify([tuple(p) for p in pat["shape"]]) for pat in d["patterns"] if pat.get("shape")]

    # Corridor: track nodes within CORRIDOR_M of any coarse route of this line.
    cg = Grid()
    for pts in coarse_all:
      for p in pts:
        cg.add(p, None)
    def in_corridor(p):
      return any(dist_m(p, q) <= CORRIDOR_M for q, _ in cg.near(p))

    adj: dict[int, list[tuple[int, float]]] = {}
    for w in ways:
      if w.get("tags", {}).get("railway") not in spec["railway"]:
        continue
      ids = [i for i in w["nodes"] if i in nodes]
      for a, b in zip(ids, ids[1:]):
        if not (in_corridor(nodes[a]) and in_corridor(nodes[b])):
          continue
        dd = dist_m(nodes[a], nodes[b])
        adj.setdefault(a, []).append((b, dd))
        adj.setdefault(b, []).append((a, dd))
    ng = Grid()
    for i in adj:
      ng.add(nodes[i], i)
    print(f"  track graph: {len(adj)} nodes")

    def snap(p):
      best, bd = None, SNAP_M
      for q, i in ng.near(p):
        dd = dist_m(p, q)
        if dd < bd:
          best, bd = i, dd
      return best

    def path(a, b, limit):
      dist, prev, pq = {a: 0.0}, {}, [(0.0, a)]
      while pq:
        du, u = heapq.heappop(pq)
        if u == b:
          break
        if du > dist.get(u, math.inf) or du > limit:
          continue
        for v, w in adj.get(u, ()):
          nd = du + w
          if nd < dist.get(v, math.inf):
            dist[v], prev[v] = nd, u
            heapq.heappush(pq, (nd, v))
      if b not in dist:
        return None
      seq = [b]
      while seq[-1] != a:
        seq.append(prev[seq[-1]])
      return seq[::-1]

    patterns, matched_pts, total_pts = [], 0, 0
    for pat in d["patterns"]:
      coarse = [tuple(p) for p in pat.get("shape") or []]
      if len(coarse) < 2:
        continue
      pts = densify(coarse, 60.0)
      res: list[tuple[float, float]] = []
      prev_node = None
      for p in pts:
        total_pts += 1
        n = snap(p)
        if n is None:
          res.append(p); prev_node = None
          continue
        matched_pts += 1
        if prev_node is None or n == prev_node:
          if n != prev_node:
            res.append(nodes[n])
          prev_node = n
          continue
        straight = dist_m(nodes[prev_node], nodes[n])
        seq = path(prev_node, n, 4 * straight + 400)
        if seq:
          res.extend(nodes[i] for i in seq[1:])
        else:
          res.append(nodes[n])
        prev_node = n
      shape = [[round(a, 6), round(b, 6)] for a, b in douglas_peucker(res, 1.5)]
      patterns.append({"id": pat["id"], "headsign": pat.get("headsign"), "stops": pat.get("stops", []), "shape": shape})
      print(f"  {pat.get('headsign')}: {len(coarse)} -> {len(shape)} points")
    stops = {k: {"name": v.get("name"), "lat": v["lat"], "lon": v["lon"]} for k, v in (d.get("stops") or {}).items()}
    out["lines"][line] = {"color": (d.get("line") or {}).get("color"), "name": (d.get("line") or {}).get("name"),
                          "patterns": patterns, "stops": stops,
                          "matched": round(matched_pts / max(1, total_pts), 3)}
    print(f"  {100 * matched_pts / max(1, total_pts):.0f}% of the route snapped to tracks")

  OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
  print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
  main()
