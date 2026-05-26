# Aesop

A standalone Node.js/TypeScript CLI for ML experiment orchestration, powered by the Pi coding agent SDK.

## Overview

Aesop is a CLI application that embeds the Pi coding agent to autonomously manage machine learning experiments. It combines natural language interaction with ephemeral workspaces for complete experiment isolation and automated result logging.

### Key Features

- **Embedded Coding Agent**: Uses the Pi SDK for natural language-driven experiment management
- **Ephemeral Workspaces**: Isolated experiment environments using git worktree
- **Monotonic Improvement**: Ratchet-based enforcement ensures results always improve
- **Experiment Ledger**: JSONL-based experiment logging for reproducibility and analysis

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Aesop CLI                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │    CLI      │  │  Experiment  │  │   Ledger Manager   │  │
│  │  Interface  │──│   Harness    │──│                    │  |
│  └─────────────┘  └──────────────┘  └────────────────────┘  │
│         │                │                    │             │
│         ▼                ▼                    ▼             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Pi SDK (Embedded Agent)                    ││
│  │  ┌─────────┐  ┌──────────┐  ┌────────────────────────┐  ││
│  │  │ Session │  │  Tools   │  │  Experiment-Aware      │  ││
│  │  │ Manager │  │ (read,   │  │  System Prompt         │  ││
│  │  │         │  │  bash,   │  │                        │  ││
│  │  │         │  │  edit)   │  │                        │  ││
│  │  └─────────┘  └──────────┘  └────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
# Clone the repository
git clone https://github.com/your-org/aesop.git
cd aesop

# Install dependencies
npm install

# Build the CLI
npm run build

# Install globally (optional)
npm install -g
```

## Requirements

- Node.js 18+
- TypeScript 5.3+
- Git

## Quick Start

### Run an Experiment

Execute an experiment using natural language:

```bash
aesop run "Train ResNet-50 on CIFAR-10 with learning rate 0.001"
```

Options:

- `--validate-cmd <cmd>` - Validation command (default: `./aesop_validate.sh`)
- `--metric <key>` - Primary metric (default: `accuracy`)
- `--max-iterations <n>` - Max agent iterations (default: 10)
- `--model <model>` - Model override

### Interactive Mode

Open an agent session in the current directory for debugging and exploration:

```bash
aesop interactive
```

### Check Experiment Status

View experiment history:

```bash
aesop status
```

Sample output:

```
Branch                         Status          Metric     Time
---------------------------------------------------------------------------
hypothesis/test-lr             success         0.9621     4m32s
hypothesis/deeper-network      no_improvement  0.9103     6m18s
hypothesis/add-dropout         failure         —          2m01s

```

Use `--json` for machine-readable output:

```bash
aesop status --json
```

## CLI Reference

| Command              | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `aesop run <prompt>` | Execute an experiment from a natural language prompt |
| `aesop interactive`  | Start interactive agent session in current directory |
| `aesop status`       | Show experiment history from the ledger              |

## Configuration

### .aesop.json

Create `.aesop.json` in your project root to set defaults:

```json
{
  "validateCmd": "./scripts/evaluate.sh",
  "metric": "accuracy",
  "maxIterations": 10,
  "model": "anthropic/claude-opus-4-5"
}
```

### API Keys

Set API keys for the embedded agent model:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=sk-...

# OpenAI
export OPENAI_API_KEY=sk-...
```

## Development

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Lint
npm run lint

# Format
npm run format

# Build
npm run build

# Run tests
npm test

# Run in development mode
npm run dev
```

### Required Checks

Before opening a PR, run all checks:

```bash
npx tsc --noEmit && npm run lint && npm run format:check && npm run test
```

## Validation Script

Aesop runs a validation script to evaluate experiments. Create `aesop_validate.sh` in your project:

```bash
#!/bin/bash
# Run your training and evaluation
python train.py "$@"

# Write metrics to eval_result.json
python -c "
import json
import sys
# Your metrics here
metrics = {'accuracy': 0.95, 'loss': 0.05}
with open('eval_result.json', 'w') as f:
    json.dump(metrics, f)
"
```

The script should write the primary metric to `eval_result.json`.

## Experiment Ledger

Experiments are logged to `experiments.jsonl`:

```jsonl
{"timestamp":"2024-01-15T10:30:00.000Z","branch":"hypothesis/test-lr","baseCommit":"abc123","hypothesisCommit":"def456","status":"success","metrics":{"accuracy":0.95},"durationMs":120000}
{"timestamp":"2024-01-15T11:00:00.000Z","branch":"hypothesis/test-batch-size","baseCommit":"abc123","hypothesisCommit":"ghi789","status":"no_improvement","metrics":{"accuracy":0.92},"durationMs":110000}
```

## License

MIT
