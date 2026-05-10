# Aesop

A Pi coding agent extension for distributed ML experiment orchestration.

## Overview

Aesop enables Pi to autonomously branch, dispatch, and evaluate distributed machine learning experiments. It extends Pi's capabilities with tools for:

- **Experiment Branching**: Create experiment variants and track their lineage
- **Distributed Dispatch**: Execute experiments across multiple compute environments
- **Result Aggregation**: Collect, compare, and summarize experiment outputs

## Features

- Seamless integration with Pi's session branching and tree navigation
- Git-based experiment versioning with `simple-git`
- Schema-validated experiment configurations using `zod`
- Support for parallel experiment execution and evaluation

## Installation

```bash
npm install
npm run build
```

## Usage

Place the extension in your Pi extensions directory:

```bash
# Global installation
cp -r . ~/.pi/agent/extensions/aesop

# Or use project-local
mkdir -p .pi/extensions && cp -r . .pi/extensions/aesop
```

Then start Pi with automatic extension discovery, or use the `-e` flag:

```bash
pi
```

## Extension Manifest

The extension exports a manifest following Pi's extension format:

```typescript
{
  name: "Aesop",
  description: "Enables Pi to autonomously branch, dispatch, and evaluate distributed ML experiments",
  tools: []
}
```

## Development

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Build
npm run build

# Run in development mode
npm run dev
```

## Requirements

- Node.js 18+
- TypeScript 5.3+
- Pi coding agent

## License

MIT
