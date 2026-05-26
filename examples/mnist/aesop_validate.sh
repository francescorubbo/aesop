#!/usr/bin/env bash
set -e

# Ensure data is stored in a shared location outside the ephemeral workspace
# to avoid exclusion by WorkspaceManager's DEFAULT_EXCLUSIONS.
export MNIST_DATA_DIR="${MNIST_DATA_DIR:-$HOME/.cache/aesop/mnist}"
mkdir -p "$MNIST_DATA_DIR"

# Ensure dependencies are installed in the ephemeral workspace
uv sync

echo "Running static checks..."
uvx ruff check train.py
uvx ty check train.py

echo "Running training..."
rm -f eval_result.json   # belt-and-suspenders; harness also does this
uv run python train.py

echo "Verifying results..."
uv run python - <<'EOF'
import json, os, time, sys
path = "eval_result.json"
if not os.path.exists(path):
    sys.exit("eval_result.json was not written")
age = time.time() - os.path.getmtime(path)
if age > 120:
    sys.exit(f"eval_result.json is stale ({age:.0f}s old)")
result = json.load(open(path))
assert "accuracy" in result, "missing accuracy key"
print(f"accuracy={result['accuracy']:.4f}")
EOF