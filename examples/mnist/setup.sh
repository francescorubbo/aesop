#!/usr/bin/env bash

# Setup script for Aesop MNIST example

set -e

echo "Setting up Aesop MNIST example..."

# Create the data directory if it doesn't exist
mkdir -p data

echo "Setup completed! You can now run the example with:"
echo "  uv sync  # Install dependencies"
echo "  uv run python train.py"
echo "or"
echo "  aesop start --objective 'Improve the model' --target-repo . --validate-cmd \"./aesop_validate.sh\""