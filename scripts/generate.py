"""Step 4: draw the map. The whole area is denoised as ONE image, so there are no seams.

  uv run scripts/generate.py --area pilot --preview      # one small patch, ~5-10 min
  caffeinate -i uv run scripts/generate.py --area pilot  # the whole area

How it works (MultiDiffusion, as on tiny.london):
- The render of the area is encoded into one latent canvas and partly noised.
- At every step the model runs on overlapping 512 px windows; their predictions
  are averaged where they overlap, so neighbouring windows cannot disagree.
- A ControlNet reads the render's edges so buildings stay where they are.
- Cells you already generated in an earlier stage are "pinned": the new area
  grows out of them instead of being stitched on. That's how the map can grow
  stage by stage without seams.
Progress is saved after every step; re-run the same command to resume.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np
import torch
from PIL import Image

from common import (
  CELLS,
  OUT,
  assemble,
  atomic_save_image,
  cell_path,
  load_areas,
  load_config,
  render_path,
  tent,
  window_positions,
)

WIN = 64  # latent pixels = 512 px
STRIDE = 48
SHIFT = 24


def pick_device():
  if torch.backends.mps.is_available():
    return torch.device("mps"), torch.float16
  if torch.cuda.is_available():
    return torch.device("cuda"), torch.float16
  return torch.device("cpu"), torch.float32


def load_pipe(cfg, lora_dir, device, dtype):
  from diffusers import ControlNetModel, StableDiffusionControlNetPipeline

  base = load_config()["lora"]["base_model"]
  try:
    cn = ControlNetModel.from_pretrained(cfg["controlnet"], variant="fp16", torch_dtype=dtype)
  except Exception:
    cn = ControlNetModel.from_pretrained(cfg["controlnet"], torch_dtype=dtype)
  kw = dict(controlnet=cn, safety_checker=None, feature_extractor=None, requires_safety_checker=False, torch_dtype=dtype)
  try:
    pipe = StableDiffusionControlNetPipeline.from_pretrained(base, variant="fp16", **kw)
  except Exception:
    pipe = StableDiffusionControlNetPipeline.from_pretrained(base, **kw)
  if lora_dir is not None:
    pipe.load_lora_weights(str(lora_dir))
    pipe.fuse_lora(lora_scale=cfg["lora_scale"])
  pipe.to(device)
  pipe.vae.to(torch.float32)  # fp16 VAE gives black images on some Macs
  pipe.vae.enable_tiling()
  return pipe


def canny(rgb: np.ndarray) -> np.ndarray:
  import cv2

  g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
  e = cv2.Canny(g, 100, 200)
  return np.repeat(e[:, :, None], 3, axis=2)


@torch.no_grad()
def encode(vae, rgb: np.ndarray, device) -> torch.Tensor:
  x = torch.from_numpy(rgb).permute(2, 0, 1)[None].float().div(127.5).sub(1).to(device)
  return vae.encode(x).latent_dist.mean * vae.config.scaling_factor


@torch.no_grad()
def decode(vae, lat: torch.Tensor) -> np.ndarray:
  x = vae.decode(lat.float() / vae.config.scaling_factor).sample
  return ((x[0].clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--area", default="pilot")
  ap.add_argument("--preview", action="store_true", help="only one cell in the middle, nothing saved to the map")
  ap.add_argument("--lora", default=None, help="style model folder (default out/lora/final)")
  ap.add_argument("--no-lora", action="store_true", help="run without your style model, for comparison")
  ap.add_argument("--strength", type=float, default=None)
  ap.add_argument("--guidance", type=float, default=None)
  ap.add_argument("--control", type=float, default=None, help="ControlNet strength")
  ap.add_argument("--redo", action="store_true", help="regenerate cells that are already finished")
  args = ap.parse_args()

  cfg = dict(load_config()["generate"])
  for k, v in (("strength", args.strength), ("guidance", args.guidance), ("controlnet_scale", args.control)):
    if v is not None:
      cfg[k] = v
  shot = load_config()["camera"]["shot_px"]
  areas = load_areas()
  if args.area not in areas:
    sys.exit(f"Area '{args.area}' hasn't been rendered. Run: uv run scripts/render.py --area {args.area}")
  area = areas[args.area]
  cells = [tuple(c) for c in area["cells"]]
  missing = [c for c in cells + [tuple(c) for c in area["margin"]] if not render_path(*c).exists()]
  if missing:
    sys.exit(f"{len(missing)} renders missing. Run scripts/render.py --area {args.area} again.")

  torch.set_grad_enabled(False)
  lora_dir = None
  if not args.no_lora:
    lora_dir = OUT / "lora" / "final"
    if args.lora:  # e.g. --lora step_1000  or a full path
      lora_dir = OUT / "lora" / args.lora if not os.path.isabs(args.lora) else args.lora
    if not os.path.exists(lora_dir):
      sys.exit(f"No style model at {lora_dir}. Run scripts/train_lora.py first (or use --no-lora).")

  # ---- what to draw, and the canvas around it
  if args.preview:
    ci = sorted(cells)[len(cells) // 2]
    region = [ci]
    margin = 256
  else:
    region = cells
    margin = cfg["margin_px"]
  todo = set(c for c in region if args.redo or args.preview or not cell_path(*c).exists())
  if not todo:
    print("All cells of this area are already finished. Use --redo to draw them again.")
    return
  i0, i1 = min(c[0] for c in region), max(c[0] for c in region)
  j0, j1 = min(c[1] for c in region), max(c[1] for c in region)
  x0, y0 = i0 * shot - margin, j0 * shot - margin
  w, h = (i1 - i0 + 1) * shot + 2 * margin, (j1 - j0 + 1) * shot + 2 * margin

  render, _ = assemble(render_path, x0, y0, w, h, shot)
  done_fn = (lambda i, j: cell_path(i, j) if (i, j) not in todo else CELLS / "__none__.png")
  known_rgb, known = assemble(done_fn, x0, y0, w, h, shot)
  if args.preview:
    known[:] = False

  device, dtype = pick_device()
  print(f"Canvas {w} x {h} px, {len(todo)} cells to draw, on {device}.")
  pipe = load_pipe(cfg, lora_dir, device, dtype)

  # ---- latents
  print("Encoding the render...")
  z = encode(pipe.vae, render, device)
  lh, lw = z.shape[2], z.shape[3]
  known_lat = None
  mask = None
  if known.any():
    print("Encoding finished neighbours (they stay as they are)...")
    known_lat = encode(pipe.vae, known_rgb, device)
    m = known.reshape(lh, 8, lw, 8).mean(axis=(1, 3)) > 0.5
    mask = torch.from_numpy(m.astype(np.float32))[None, None].to(device)
  unknown_lat = ~(mask[0, 0].bool().cpu().numpy()) if mask is not None else np.ones((lh, lw), bool)

  ctrl = torch.from_numpy(canny(render)).permute(2, 0, 1)[None].to(device, dtype) / 255.0
  pos, neg = pipe.encode_prompt(
    load_config()["lora"]["caption"], device, 1, True, cfg["negative_prompt"]
  )

  from diffusers import DDIMScheduler

  sched = DDIMScheduler.from_config(pipe.scheduler.config)
  sched.set_timesteps(cfg["steps"], device=device)
  first = cfg["steps"] - int(cfg["steps"] * cfg["strength"])
  ts = sched.timesteps[first:]

  gen = torch.Generator("cpu").manual_seed(cfg["seed"])
  noise = torch.randn(z.shape, generator=gen).to(device)

  def pin(lat, t):
    if mask is None:
      return lat
    target = known_lat if t is None else sched.add_noise(known_lat, noise, t.reshape(1))
    return mask * target + (1 - mask) * lat

  # ---- resume
  tag = f"preview_{args.area}" if args.preview else args.area
  work = OUT / "work" / tag
  work.mkdir(parents=True, exist_ok=True)
  state_path = work / "state.pt"
  sig = [x0, y0, w, h, sorted(todo), cfg["steps"], cfg["strength"], cfg["guidance"], cfg["controlnet_scale"], str(lora_dir)]
  step0 = 0
  lat = sched.add_noise(z, noise, ts[:1])
  lat = pin(lat, ts[0])
  if state_path.exists() and not args.preview:
    st = torch.load(state_path, map_location="cpu")
    if st.get("sig") == sig:
      lat, step0 = st["lat"].to(device), st["step"]
      print(f"Resuming at step {step0 + 1}/{len(ts)}.")

  # ---- windows
  tw = torch.from_numpy(tent(WIN)).to(device)[None, None]
  grids = []
  for g in range(2):
    sh = SHIFT * g
    ys = window_positions(lh, WIN, STRIDE, sh)
    xs = window_positions(lw, WIN, STRIDE, sh)
    grids.append([(y, x) for y in ys for x in xs if unknown_lat[y : y + WIN, x : x + WIN].any()])
  per_step = len(grids[0])
  bsz = max(1, int(cfg["windows_per_batch"]))
  guidance = cfg["guidance"]

  t_start = time.time()
  for si in range(step0, len(ts)):
    t = ts[si]
    vel = torch.zeros_like(lat)
    wsum = torch.zeros_like(lat[:, :1])
    wins = grids[si % 2]
    for b in range(0, len(wins), bsz):
      chunk = wins[b : b + bsz]
      xin = torch.cat([lat[:, :, y : y + WIN, x : x + WIN] for y, x in chunk]).to(dtype)
      cin = torch.cat([ctrl[:, :, y * 8 : (y + WIN) * 8, x * 8 : (x + WIN) * 8] for y, x in chunk])
      n = len(chunk)
      xin2 = torch.cat([xin, xin])
      emb = torch.cat([neg.expand(n, -1, -1), pos.expand(n, -1, -1)])
      down, mid = pipe.controlnet(
        xin2, t, encoder_hidden_states=emb, controlnet_cond=torch.cat([cin, cin]),
        conditioning_scale=cfg["controlnet_scale"], return_dict=False,
      )
      eps = pipe.unet(
        xin2, t, encoder_hidden_states=emb,
        down_block_additional_residuals=down, mid_block_additional_residual=mid, return_dict=False,
      )[0]
      eu, ec = eps.float().chunk(2)
      e = eu + guidance * (ec - eu)
      for k, (y, x) in enumerate(chunk):
        vel[:, :, y : y + WIN, x : x + WIN] += e[k : k + 1] * tw
        wsum[:, :, y : y + WIN, x : x + WIN] += tw
    eps_full = vel / wsum.clamp_min(1e-6)
    lat = sched.step(eps_full, t, lat).prev_sample
    lat = pin(lat, ts[si + 1] if si + 1 < len(ts) else None)

    if not args.preview:
      tmp = state_path.with_suffix(".tmp")
      torch.save({"sig": sig, "lat": lat.cpu(), "step": si + 1}, tmp)
      os.replace(tmp, state_path)
    el = time.time() - t_start
    done_steps = si + 1 - step0
    left = el / done_steps * (len(ts) - si - 1) / 60
    print(f"step {si + 1}/{len(ts)}  ({per_step} windows)  ~{left:.0f} min left")

  print("Decoding...")
  out = decode(pipe.vae, lat)

  if args.preview:
    path = OUT / "previews" / f"{args.area}_{time.strftime('%Y%m%d-%H%M%S')}.png"
    side = np.concatenate([render, out], axis=1)
    atomic_save_image(Image.fromarray(side), path)
    print(f"\nPreview (render left, drawing right): {path}")
    return

  for i, j in sorted(todo):
    px, py = i * shot - x0, j * shot - y0
    atomic_save_image(Image.fromarray(out[py : py + shot, px : px + shot]), cell_path(i, j))
  full = Image.fromarray(out[margin : h - margin, margin : w - margin])
  full.thumbnail((4000, 4000))
  full.save(OUT / f"map_{args.area}.jpg", quality=90)
  state_path.unlink(missing_ok=True)
  print(f"\nDone. {len(todo)} cells saved. Overview: {OUT / f'map_{args.area}.jpg'}")


if __name__ == "__main__":
  main()
