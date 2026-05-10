# Aesop Development Guidelines

## Overview

Aesop is a standalone Node.js/TypeScript CLI application that embeds the Pi coding agent via the SDK. It provides distributed ML experiment orchestration with Git-based experiment versioning, autonomous agent-driven execution, and automated result aggregation.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Aesop CLI                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │    CLI      │  │  Experiment  │  │  Discovery Engine   │ │
│  │  Interface  │──│   Manager    │──│  (Slurm/K8s/Local)  │ │
│  └─────────────┘  └──────────────┘  └────────────────────┘ │
│         │                │                    │            │
│         ▼                ▼                    ▼            │
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

## CLI Commands

### `aesop run <prompt>`

Run an experiment with a natural language prompt:

```bash
aesop run "Train ResNet-50 on CIFAR-10 with learning rate 0.001"
```

### `aesop branch <hypothesis>`

Create an experiment branch from a hypothesis:

```bash
aesop branch "Test if increasing learning rate improves convergence"
```

### `aesop dispatch <branch>`

Dispatch an experiment branch to the available compute backend:

```bash
aesop dispatch hypothesis/test-lr
```

### `aesop status [branch]`

Check experiment status:

```bash
aesop status              # Current branch status
aesop status main         # Main branch status
```

### `aesop merge <source> <target>`

Merge successful experiments back to target:

```bash
aesop merge hypothesis/test-lr main
```

### `aesop interactive`

Start interactive mode with full agent capabilities:

```bash
aesop interactive
```

## Branch Strategy

- **Feature branches**: Prefix with `feat/`, `fix/`, `refactor/`, or `chore/`
- **Experiment branches**: Use `hypothesis/<name>` (managed by `ExperimentManager`)
- **Base**: Work off `main` unless otherwise specified

## Workflow

> **Important**: This workflow applies to **all changes**—code, docs, config, and even this document itself.

1. **Create a feature branch** from `main` (use `git worktree add` for parallel development)
2. **Implement and test** your changes
3. **Run checks** before opening a PR
4. **Open a PR** with a clear description
5. **Watch CI** and address any failures

## Required Checks

Before opening a PR or pushing, ensure all CI checks pass locally:

```bash
# Format check
npm run format:check

# Lint
npm run lint

# Type check
npm run typecheck

# Tests with coverage
npm run test:coverage
```

Run all checks together:

```bash
npx tsc --noEmit && npm run lint && npm run format:check && npm run test:coverage
```

## Testing

- Add unit tests for new modules in `src/__tests__/` or alongside source files
- Test interfaces and classes in isolation where possible
- Use descriptive test names that document behavior
- Use Vitest for the test runner

## Code Style

- Strict TypeScript: no `any`, explicit types everywhere
- Use ES modules with named exports where appropriate
- Document public APIs with JSDoc comments
- Default tool set: `codingTools` (read, bash, edit, write)
- Custom tools for experiment operations via `defineTool()`

## SDK Integration

Aesop uses the Pi SDK to embed a coding agent. Key integration points:

```typescript
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

// Create session with custom experiment-aware system prompt
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  // Custom tools and prompts are loaded via DefaultResourceLoader
});
```

## PR Guidelines

- Keep PRs focused and reasonably sized
- Include context: what changed, why, and how to test
- Link to related issues or discussions

## Git Conventions

- Commit messages: conventional format (`feat:`, `fix:`, `docs:`, etc.)
- Squash minor commits before merging if helpful
- Do not force-push to shared branches
