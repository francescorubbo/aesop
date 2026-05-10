# Aesop Development Guidelines

## Overview

Aesop is a Pi coding agent extension for distributed ML experiment orchestration. It enables Pi to autonomously branch, dispatch, and evaluate distributed machine learning experiments using Git-based experiment versioning.

## Branch Strategy

- **Feature branches**: Prefix with `feat/`, `fix/`, `refactor/`, or `chore/`
- **Experiment branches**: Use `hypothesis/<name>` (managed by `HypothesisStateManager`)
- **Base**: Work off `main` unless otherwise specified

## Workflow

1. **Create a feature branch** from `main`
2. **Implement and test** your changes
3. **Run checks** before opening a PR
4. **Open a PR** with a clear description
5. **Watch CI** and address any failures

## Required Checks

Before opening a PR, ensure all pass:

```bash
# Type check
npx tsc --noEmit

# Lint
npm run lint

# Tests
npm test
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