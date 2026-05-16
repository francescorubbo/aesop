#!/usr/bin/env bash
# examples/mnist/aesop_validate.sh

# Exit immediately if a task exits with a non-zero status.
set -e

echo "Running static backpressure gates..."
# 1. Check for syntax errors and undefined variables
uvx ruff check train.py

# 2. Check type hints (optional for this simple script, but good practice)
uvx ty check train.py

echo "Static checks passed. Executing experiment..."
# 3. Run the training script (which generates eval_result.json)
uv run python train.py

echo "Experiment execution finished successfully."