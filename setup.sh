#!/bin/bash
# One-time setup for tiny-athens on an Apple Silicon Mac.
# Run from the project folder:   bash setup.sh
set -e
cd "$(dirname "$0")"

say() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "This setup is for Apple Silicon Macs (M1-M4)."; exit 1
fi

say "Checking free disk space"
free_gb=$(df -g . | awk 'NR==2 {print $4}')
echo "Free: ${free_gb} GB (need about 15 GB)"
if [ "${free_gb:-0}" -lt 12 ]; then echo "Not enough free space. Free some up and run again."; exit 1; fi

say "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install node
  else
    echo "Node.js is missing. Install the LTS version from https://nodejs.org (the macOS installer),"
    echo "then open a new Terminal window and run: bash setup.sh."
    exit 1
  fi
fi
echo "Node $(node --version)"

say "Checking uv (Python manager)"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
echo "$(uv --version)"

say "Installing Python and libraries (a few minutes)"
uv python install 3.12
uv sync --python 3.12

say "Installing the headless browser for rendering"
uv run playwright install chromium

say "Installing the 3D renderer"
(cd render && npm install --no-audit --no-fund)

say "Downloading the AI models (~3 GB, one time)"
uv run scripts/download_models.py

if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env - open it and paste your two API keys:"
  echo "   open -e .env"
else
  say ".env already exists"
fi

say "Checking the Mac GPU"
uv run python -c "import torch; print('Apple GPU (MPS) available:', torch.backends.mps.is_available())"

say "Setup finished. Next: put your keys in .env, then follow GUIDE.md step 3."
