#!/usr/bin/env bash

# Setup script for Aesop MNIST example

set -e

# Check Node >= 18
node_version=$(node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)" 2>&1 || echo "fail")
[[ "$node_version" == "fail" ]] && { echo "Node.js >= 18 required"; exit 1; }

# Check Python >= 3.13
python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,13) else 1)" || {
  echo "Python >= 3.13 required"; exit 1
}

# Check uv
command -v uv >/dev/null 2>&1 || { echo "uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }

# Check API key
[[ -z "$ANTHROPIC_API_KEY" ]] && { echo "ANTHROPIC_API_KEY not set"; exit 1; }

# Check aesop CLI is built
command -v aesop >/dev/null 2>&1 || {
  echo "aesop not found. Run from repo root: npm install && npm run build && npm install -g"
  exit 1
}

mkdir -p data
uv sync

echo "Setup complete. Run: aesop run \"Improve the model to achieve >95% accuracy\""