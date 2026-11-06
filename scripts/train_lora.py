"""Step 3: teach Stable Diffusion 1.5 the pixel-art style (a LoRA), on the Mac's GPU.

  caffeinate -i uv run scripts/train_lora.py

Learns from the accepted drawings in pairs/targets/. Saves a checkpoint every
few hundred steps; if it stops for any reason, run the same command again and
it continues. The finished style model goes to out/lora/final/.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np
import torch
from PIL import Image

from common import OUT, PAIRS, load_config

LORA_DIR = OUT / "lora"


def pick_device():
  if torch.backends.mps.is_available():
    return torch.device("mps")
  if torch.cuda.is_available():
    return torch.device("cuda")
  print("Warning: no GPU found, training on the CPU will be extremely slow.")
  return torch.device("cpu")


def load_part(cls, repo, sub, dtype):
  try:
    return cls.from_pretrained(repo, subfolder=sub, variant="fp16", torch_dtype=dtype)
  except Exception:
    return cls.from_pretrained(repo, subfolder=sub, torch_dtype=dtype)


def save_lora(unet, path):
  from diffusers import StableDiffusionPipeline
  from diffusers.utils import convert_state_dict_to_diffusers
  from peft.utils import get_peft_model_state_dict

  path.mkdir(parents=True, exist_ok=True)
  sd = convert_state_dict_to_diffusers(get_peft_model_state_dict(unet))
  StableDiffusionPipeline.save_lora_weights(save_directory=str(path), unet_lora_layers=sd, safe_serialization=True)


def main():
  ap = argparse.ArgumentParser()
  ap.add_argument("--steps", type=int, default=None)
  ap.add_argument("--restart", action="store_true", help="ignore the saved checkpoint and start over")
  args = ap.parse_args()

  cfg = load_config()["lora"]
  steps = args.steps or cfg["steps"]
  repo = cfg["base_model"]
  device = pick_device()

  targets = sorted((PAIRS / "targets").glob("*.png"))
  if len(targets) < 10:
    sys.exit(f"Only {len(targets)} drawings in pairs/targets/. Run scripts/make_pairs.py first (aim for 60+).")
  print(f"Training on {len(targets)} drawings, {steps} steps, on {device}.")

  from diffusers import AutoencoderKL, DDPMScheduler, UNet2DConditionModel
  from peft import LoraConfig
  from peft.utils import get_peft_model_state_dict, set_peft_model_state_dict
  from transformers import CLIPTextModel, CLIPTokenizer

  LORA_DIR.mkdir(parents=True, exist_ok=True)
  cache = LORA_DIR / "latents.pt"

  # 1. Encode drawings to latents and the caption to an embedding, once.
  names = [t.name for t in targets]
  data = torch.load(cache) if cache.exists() else None
  if data is None or data["names"] != names or data["caption"] != cfg["caption"]:
    print("Encoding drawings (one-off, a few minutes)...")
    tok = CLIPTokenizer.from_pretrained(repo, subfolder="tokenizer")
    te = load_part(CLIPTextModel, repo, "text_encoder", torch.float32).to(device)
    vae = load_part(AutoencoderKL, repo, "vae", torch.float32).to(device)
    vae.enable_tiling()
    with torch.no_grad():
      ids = tok(cfg["caption"], padding="max_length", max_length=tok.model_max_length, truncation=True, return_tensors="pt").input_ids
      emb = te(ids.to(device))[0].cpu()
      lats = []
      for t in targets:
        img = Image.open(t).convert("RGB")
        if img.size != (1024, 1024):
          img = img.resize((1024, 1024), Image.LANCZOS)
        x = torch.from_numpy(np.asarray(img)).permute(2, 0, 1)[None].float().div(127.5).sub(1).to(device)
        lats.append((vae.encode(x).latent_dist.mean * vae.config.scaling_factor).cpu())
    data = {"names": names, "caption": cfg["caption"], "emb": emb, "lats": torch.cat(lats)}
    torch.save(data, cache)
    del te, vae
    if device.type == "mps":
      torch.mps.empty_cache()
  lats, emb = data["lats"], data["emb"].to(device)

  # 2. The model, with a small trainable LoRA on its attention layers.
  unet = load_part(UNet2DConditionModel, repo, "unet", torch.float32).to(device)
  unet.requires_grad_(False)
  unet.add_adapter(
    LoraConfig(
      r=cfg["rank"],
      lora_alpha=cfg["rank"],
      init_lora_weights="gaussian",
      target_modules=["to_k", "to_q", "to_v", "to_out.0"],
    )
  )
  unet.enable_gradient_checkpointing()
  unet.train()
  params = [p for p in unet.parameters() if p.requires_grad]
  opt = torch.optim.AdamW(params, lr=cfg["learning_rate"], weight_decay=1e-2)
  sched = DDPMScheduler.from_pretrained(repo, subfolder="scheduler")

  ckpt_path = LORA_DIR / "checkpoint.pt"
  start = 0
  if ckpt_path.exists() and not args.restart:
    ck = torch.load(ckpt_path, map_location="cpu")
    set_peft_model_state_dict(unet, ck["lora"])
    opt.load_state_dict(ck["opt"])
    start = ck["step"]
    print(f"Resuming from step {start}.")
  if start >= steps:
    print("Already trained. Use --steps to train longer or --restart to start over.")
    save_lora(unet, LORA_DIR / "final")
    return

  rng = random.Random(start)
  bs = cfg["batch_size"]
  n, _, H, W = lats.shape
  crop = 64  # 512 px
  t0, losses = time.time(), []
  for step in range(start + 1, steps + 1):
    batch = []
    for _ in range(bs):
      k = rng.randrange(n)
      y, x = rng.randrange(H - crop + 1), rng.randrange(W - crop + 1)
      batch.append(lats[k, :, y : y + crop, x : x + crop])
    latents = torch.stack(batch).to(device)
    noise = torch.randn_like(latents)
    t = torch.randint(0, sched.config.num_train_timesteps, (bs,), device=device).long()
    noisy = sched.add_noise(latents, noise, t)
    pred = unet(noisy, t, encoder_hidden_states=emb.expand(bs, -1, -1)).sample
    loss = torch.nn.functional.mse_loss(pred.float(), noise.float())
    loss.backward()
    torch.nn.utils.clip_grad_norm_(params, 1.0)
    opt.step()
    opt.zero_grad(set_to_none=True)
    losses.append(loss.item())

    if step % 25 == 0:
      rate = (time.time() - t0) / (step - start)
      left = (steps - step) * rate / 60
      print(f"step {step}/{steps}  loss {np.mean(losses[-25:]):.4f}  {rate:.1f}s/step  ~{left:.0f} min left")
    if step % cfg["save_every"] == 0 or step == steps:
      tmp = ckpt_path.with_suffix(".tmp")
      torch.save({"lora": get_peft_model_state_dict(unet), "opt": opt.state_dict(), "step": step}, tmp)
      os.replace(tmp, ckpt_path)
      save_lora(unet, LORA_DIR / f"step_{step}")
      print(f"   saved checkpoint at step {step}")

  save_lora(unet, LORA_DIR / "final")
  print(f"\nDone. Style model saved to {LORA_DIR / 'final'}")


if __name__ == "__main__":
  main()
