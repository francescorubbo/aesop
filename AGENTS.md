# Aesop Development Guidelines

## Overview

Aesop is a Pi coding agent extension for distributed ML experiment orchestration. It enables Pi to autonomously branch, dispatch, and evaluate distributed machine learning experiments using Git-based experiment versioning.

## Branch Strategy

- **Feature branches**: Prefix with `feat/`, `fix/`, `refactor/`, or `chore/`
- **Experiment branches**: Use `hypothesis/<name>` (managed by `HypothesisStateManager`)
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

## Code Style

- Strict TypeScript: no `any`, explicit types everywhere
- Use ES modules with named exports where appropriate
- Document public APIs with JSDoc comments

## PR Guidelines

- Keep PRs focused and reasonably sized
- Include context: what changed, why, and how to test
- Link to related issues or discussions

## Git Conventions

- Commit messages: conventional format (`feat:`, `fix:`, `docs:`, etc.)
- Squash minor commits before merging if helpful
- Do not force-push to shared branches
