# Aesop

A standalone Node.js/TypeScript CLI for distributed ML experiment orchestration, powered by the Pi coding agent SDK.

## Overview

Aesop is a CLI application that embeds the Pi coding agent to autonomously manage distributed machine learning experiments. It combines natural language interaction with Git-based experiment versioning and distributed compute backend detection.

### Key Features

- **Embedded Coding Agent**: Uses the Pi SDK for natural language-driven experiment management
- **Git-Based Versioning**: Branch-based experiments with automatic commit tracking and ledger logging
- **Multi-Backend Support**: Auto-detects SLURM, Kubernetes, or falls back to local execution
- **Experiment Ledger**: JSONL-based experiment logging for reproducibility and analysis

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Aesop CLI                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │    CLI      │  │  Experiment  │  │  Discovery Engine  │  │
│  │  Interface  │──│   Manager    │──│  (Slurm/K8s/Local) │  │
│  └─────────────┘  └──────────────┘  └────────────────────┘  │
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
- For distributed execution: SLURM scheduler or Kubernetes cluster (optional)

## Quick Start

### Interactive Mode

Start an interactive session with the embedded agent:

```bash
aesop interactive
```

### Run Experiment from Prompt

Execute an experiment using natural language:

```bash
aesop run "Train ResNet-50 on CIFAR-10 with learning rate 0.001"
```

### Create Experiment Branch

Create a hypothesis branch for controlled experimentation:

```bash
aesop branch "Test if increasing batch size improves convergence"
```

### Dispatch to Compute Backend

Dispatch an experiment to the available backend:

```bash
aesop dispatch hypothesis/test-batch-size
```

### Check Status

View experiment status:

```bash
aesop status
aesop status hypothesis/test-batch-size
```

### Merge Successful Experiments

Merge successful hypothesis branches back to main:

```bash
aesop merge hypothesis/test-batch-size main
```

## CLI Reference

| Command                         | Description                                          |
| ------------------------------- | ---------------------------------------------------- |
| `aesop run <prompt>`            | Execute an experiment from a natural language prompt |
| `aesop branch <hypothesis>`     | Create an experiment branch from a hypothesis        |
| `aesop dispatch [branch]`       | Dispatch experiment to available compute backend     |
| `aesop status [branch]`         | Show experiment status                               |
| `aesop merge <source> <target>` | Merge experiment branch to target                    |
| `aesop interactive`             | Start interactive agent session                      |
| `aesop --help`                  | Show all available commands                          |

## Configuration

### API Keys

Set API keys for the embedded agent model:

```bash
# Anthropic (Claude)
export ANTHROPIC_API_KEY=sk-...

# OpenAI
export OPENAI_API_KEY=sk-...
```

### Custom Settings

Create `.aesop.json` in your project root:

```json
{
  "agent": {
    "model": "anthropic/claude-opus-4-5",
    "thinkingLevel": "medium"
  },
  "execution": {
    "backend": "auto",
    "slurm": {
      "partition": "default"
    },
    "kubernetes": {
      "namespace": "default"
    }
  }
}
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

## Architecture Components

### ExperimentManager

Manages experiment lifecycle with Git-based branching:

```typescript
import { ExperimentManager } from './src/experimentManager.js';

const manager = new ExperimentManager(process.cwd());
const branch = await manager.createBranch('main', 'test-hypothesis');
await manager.logExperiment(branch, 'pending', {});
```

### DiscoveryEngine

Auto-detects available compute backends:

- **SLURM**: Detected via `sbatch` command availability
- **Kubernetes**: Detected via `kubectl` command availability
- **Local**: Fallback when no distributed backend is found

```typescript
import { getActiveAdapter } from './src/discoveryEngine.js';

const adapter = await getActiveAdapter();
const jobId = await adapter.submitJob('experiment-1', 'python train.py');
const status = await adapter.checkStatus(jobId);
```

## Experiment Ledger

Experiments are logged to `experiments.jsonl` in the repository root:

```jsonl
{"timestamp":"2024-01-15T10:30:00.000Z","branch":"hypothesis/test-lr","commitHash":"abc123","status":"success","metrics":{"accuracy":0.95,"loss":0.05}}
{"timestamp":"2024-01-15T11:00:00.000Z","branch":"hypothesis/test-batch-size","commitHash":"def456","status":"failed","metrics":{}}
```

## License

MIT
