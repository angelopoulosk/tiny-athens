"""Download the two AI models once (about 3 GB), so later steps start straight away."""

from huggingface_hub import snapshot_download

from common import load_config

cfg = load_config()
base = cfg["lora"]["base_model"]
cn = cfg["generate"]["controlnet"]

print(f"Downloading {base} (fp16, ~2 GB)...")
snapshot_download(
  base,
  allow_patterns=["*.json", "*.txt", "*fp16.safetensors"],
  ignore_patterns=["safety_checker/*"],
)
print(f"Downloading {cn} (~0.7 GB)...")
try:
  snapshot_download(cn, allow_patterns=["config.json", "diffusion_pytorch_model.fp16.safetensors"])
except Exception:
  snapshot_download(cn, allow_patterns=["config.json", "diffusion_pytorch_model.safetensors"])
print("Models ready.")
