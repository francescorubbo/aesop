# Aesop Development Guidelines

## Overview

Aesop is a standalone Node.js/TypeScript CLI application that embeds the Pi coding agent via the SDK. It provides ML experiment orchestration with ephemeral workspaces for isolation, automatic result logging, and monotonic improvement enforcement.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Aesop CLI                            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │    CLI       │  │  Experiment  │  │   Ledger Manager    │ │
│  │  Interface   │──│   Harness   │──│   (experiments.jsonl)│ │
│  └─────────────┘  └──────────────┘  └────────────────────┘ │
│         │                │                    │            │
│         ▼                ▼                    ▼            │
│  ┌─────────────────────────────────────────────────────────┐│
│  │              Pi SDK (Embedded Agent)                    ││
│  │  ┌─────────┐  ┌──────────┐  ┌────────────────────────┐  ││
│  │  │ Session │  │  Tools   │  │  Experiment-Aware       │  ││
│  │  │ Manager │  │ (read,   │  │  System Prompt          │  ││
│  │  │         │  │  bash,   │  │                        │  ││
│  │  │         │  │  edit)   │  │                        │  ││
│  │  └─────────┘  └──────────┘  └────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## CLI Commands

### `aesop run <hypothesis>`

Run a single experiment end-to-end:

```bash
aesop run "Train ResNet-50 on CIFAR-10 with learning rate 0.001"
```

Options:

- `--validate-cmd <cmd>` - Validation command (default: from `.aesop.json`, then `./aesop_validate.sh`)
- `--metric <key>` - Primary metric (default: from `.aesop.json`, then `accuracy`)
- `--max-iterations <n>` - Max agent iterations (default: from `.aesop.json`, then 10)
- `--model <model>` - Model override (default: from `.aesop.json`)

Exits with code 0 on success or `no_improvement`, non-zero on failure.

### `aesop interactive`

Start interactive mode with full agent capabilities in the current directory:

```bash
aesop interactive
```

Uses `SessionManager.inMemory()` so no session is persisted. Intended for debugging and developing the validate script.

### `aesop status`

Show experiment history from the ledger:

```bash
aesop status
```

Use `--json` for machine-readable output.

## Branch Strategy

- **Feature branches**: Prefix with `feat/`, `fix/`, `refactor/`, or `chore/`
- **Experiment branches**: Use `hypothesis/<name>` (created by `runExperiment`)
- **Base**: Work off `main` unless otherwise specified

## Workflow

> **Important**: This workflow applies to **all changes**—code, docs, config, and even this document itself.

1. **Create a feature branch** from `main` (use `git worktree add` for parallel development)
2. **Implement and test** your changes
3. **Run all CI checks locally** (see "Required Checks") to ensure no regressions before pushing
4. **Open a PR** with a clear description (use `gh pr create`)
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

// Create session with experiment-aware system prompt
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  // Custom tools and prompts are loaded via DefaultResourceLoader
});
```

## Modules

| Module                 | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `runExperiment.ts`     | Core experiment harness - orchestrator for the experiment loop |
| `workspaceManager.ts`  | Manages ephemeral workspaces via git worktree                  |
| `ledger.ts`            | Append-only experiment log (JSONL)                             |
| `ratchet.ts`           | Monotonic improvement enforcement                              |
| `validateContract.ts`  | Strict result verification                                     |
| `backpressureGates.ts` | Pre-experiment static checks                                   |

## PR Guidelines

- Keep PRs focused and reasonably sized
- Include context: what changed, why, and how to test
- Link to related issues or discussions

## Git Conventions

- Commit messages: conventional format (`feat:`, `fix:`, `docs:`, etc.)
- Squash minor commits before merging if helpful
- Do not force-push to shared branches
