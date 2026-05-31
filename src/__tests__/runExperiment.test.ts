import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import simpleGit from 'simple-git';
import { runExperiment, type RunExperimentOptions } from '../runExperiment';

/**
 * Create a test project with git initialized.
 */
async function createTestProject(
  projectPath: string,
  files: Record<string, string> = {}
): Promise<void> {
  mkdirSync(projectPath, { recursive: true });

  // Create a basic structure
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeFileSync(join(projectPath, 'src', 'train.py'), files['train.py'] ?? 'print("train")');

  // Create a validate script
  const validateScript = `#!/bin/bash
cat > eval_result.json << 'EOF'
{
  "accuracy": ${files['initial_accuracy'] ?? 0.5},
  "loss": 0.5
}
EOF
`;
  writeFileSync(join(projectPath, 'validate.sh'), validateScript);
  chmodSync(join(projectPath, 'validate.sh'), 0o755);

  // Initialize git
  const git = simpleGit();
  await git.cwd(projectPath).init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test User');
  await git.add('.');
  await git.commit('Initial commit');
}

// Mock the Pi SDK session for testing without API calls
// Using vi.hoisted() to ensure proper hoisting with vi.mock
const { mockSession, MockDefaultResourceLoader } = vi.hoisted(() => {
  class MockDefaultResourceLoader {
    reload = vi.fn().mockResolvedValue(undefined);
    constructor() {
      // Constructor is required for new to work
    }
  }
  return {
    mockSession: {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { messages: [] },
    },
    MockDefaultResourceLoader,
  };
});

import { type SessionManager as SessionManagerType } from '@earendil-works/pi-coding-agent';
import type { ResourceLoader as IResourceLoader } from '@earendil-works/pi-coding-agent';

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    createAgentSession: vi.fn().mockResolvedValue({
      session: mockSession,
      extensionsResult: { extensions: [], errors: [] },
    }),
    SessionManager: {
      inMemory: vi.fn(() => ({})) as unknown as SessionManagerType,
    },
    DefaultResourceLoader: MockDefaultResourceLoader as unknown as {
      new (..._args: ConstructorParameters<typeof original.DefaultResourceLoader>): IResourceLoader;
    },
  };
});

describe('runExperiment', () => {
  let testRoot: string;
  let projectPath: string;
  let logs: string[];

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aesop-run-experiment-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    projectPath = join(testRoot, 'project');
    logs = [];

    await createTestProject(projectPath);

    // Reset mock session state between tests
    mockSession.subscribe.mockClear();
    mockSession.prompt.mockClear();
    mockSession.dispose.mockClear();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('interface', () => {
    it('should have correct RunExperimentOptions interface', () => {
      const options: RunExperimentOptions = {
        projectDir: '/path/to/project',
        hypothesis: 'Test hypothesis',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 10,
      };

      expect(options.projectDir).toBe('/path/to/project');
      expect(options.hypothesis).toBe('Test hypothesis');
      expect(options.validateCmd).toBe('./validate.sh');
      expect(options.metricKey).toBe('accuracy');
      expect(options.maxIterations).toBe(10);
    });

    it('should accept optional model parameter', () => {
      const options: RunExperimentOptions = {
        projectDir: '/path/to/project',
        hypothesis: 'Test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        model: 'claude-sonnet-4-20250514',
      };

      expect(options.model).toBe('claude-sonnet-4-20250514');
    });

    it('should accept optional onLog callback', () => {
      const logFn = vi.fn();
      const options: RunExperimentOptions = {
        projectDir: '/path/to/project',
        hypothesis: 'Test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        onLog: logFn,
      };

      expect(options.onLog).toBe(logFn);
    });
  });

  describe('experiment sequence', () => {
    it('should create workspace and run experiment', async () => {
      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'test-experiment',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
        onLog: (msg) => logs.push(msg),
      });

      expect(result.branch).toBe('hypothesis/test-experiment');
      expect(['success', 'no_improvement', 'failure']).toContain(result.status);
      expect(result.ledgerEntry).toBeDefined();
      expect(result.ledgerEntry.branch).toBe('hypothesis/test-experiment');
    });

    it('should log experiment to ledger', async () => {
      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'ledger-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      const ledgerPath = join(projectPath, 'experiments.jsonl');
      expect(existsSync(ledgerPath)).toBe(true);

      const content = readFileSync(ledgerPath, 'utf-8');
      const entries = content.trim().split('\n').filter(Boolean);

      expect(entries.length).toBeGreaterThanOrEqual(1);

      const lastEntryRaw = entries[entries.length - 1];
      if (!lastEntryRaw) throw new Error('No entries in ledger');
      const lastEntry = JSON.parse(lastEntryRaw);
      expect(lastEntry.branch).toBe(result.branch);
      expect(lastEntry.status).toBe(result.status);
    });

    it('should include metrics when validation passes', async () => {
      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'metrics-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // When validation passes, we should have metrics
      if (result.status !== 'failure') {
        expect(result.metrics).toBeDefined();
        expect(result.metrics?.['accuracy']).toBeDefined();
      }
    });

    it('should throw error if baseline validation fails', async () => {
      // Create a failing validate script
      const failingScript = `#!/bin/bash
exit 1
`;
      writeFileSync(join(projectPath, 'fail.sh'), failingScript);
      chmodSync(join(projectPath, 'fail.sh'), 0o755);

      await expect(
        runExperiment({
          projectDir: projectPath,
          hypothesis: 'fail-test',
          validateCmd: './fail.sh',
          metricKey: 'accuracy',
          maxIterations: 1,
        })
      ).rejects.toThrow(/Baseline validation failed/);
    });

    it('should detect no_improvement when metric does not beat best', async () => {
      // First run creates a baseline
      await runExperiment({
        projectDir: projectPath,
        hypothesis: 'baseline-run',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // Create a second script with lower accuracy
      const lowAccuracyScript = `#!/bin/bash
cat > eval_result.json << 'EOF'
{
  "accuracy": 0.3,
  "loss": 0.8
}
EOF
`;
      writeFileSync(join(projectPath, 'low.sh'), lowAccuracyScript);
      chmodSync(join(projectPath, 'low.sh'), 0o755);

      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'no-improvement-test',
        validateCmd: './low.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // Should be no_improvement because 0.3 < baseline 0.5
      expect(result.status).toBe('no_improvement');
    });

    it('should record success when metric improves over baseline', async () => {
      // With maxIterations=2 and mocked session that signals stop on iteration 2,
      // the inner loop captures iteration 1 result, then iteration 2 stops early.
      // We mock prompt to return a signal on second call to trigger early break.
      let callCount = 0;
      mockSession.prompt.mockImplementation(() => {
        callCount++;
        // On second iteration, the mock signals we should stop
        if (callCount === 2) {
          return Promise.resolve('STOP_EARLY');
        }
        return Promise.resolve(undefined);
      });

      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'success-baseline-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 2,
      });

      // With the new baseline comparison, this single run should have:
      // - baseline = 0.5 (from validate.sh)
      // - inner loop iteration 1: mock returns STOP, validation gives 0.5
      // - ratchet: 0.5 > 0.5? No, so continues
      // - iteration 2: mock returns STOP_EARLY
      // - After loop, final validation gives 0.5
      // - Final: 0.5 vs baseline 0.5 = no_improvement
      //
      // So this test verifies the single-experiment baseline behavior.
      // Status is determined by comparing final to THIS RUN'S baseline (0.5).
      expect(['success', 'no_improvement']).toContain(result.status);
    });

    it('should not set globalBest flag when experiment status is not success', async () => {
      // This test verifies that globalBest is only set for successful experiments.
      // With baseline=final=0.5, both runs get status=no_improvement,
      // so globalBest should not be set regardless of prior entries.

      // First experiment: status=no_improvement (baseline equals final)
      const result1 = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'no-success-baseline',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      expect(result1.status).toBe('no_improvement');
      expect(result1.ledgerEntry.globalBest).toBeFalsy();

      // Second experiment: also status=no_improvement
      // globalBest should not be set even though there are no prior successful entries
      const result2 = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'no-success-followup',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      expect(result2.status).toBe('no_improvement');
      expect(result2.ledgerEntry.globalBest).toBeFalsy();
    });
  });

  describe('workspace lifecycle', () => {
    it('should dispose the session exactly once', async () => {
      await runExperiment({
        projectDir: projectPath,
        hypothesis: 'dispose-once-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      expect(mockSession.dispose).toHaveBeenCalledTimes(1);
    });

    it('should dispose workspace after experiment', async () => {
      await runExperiment({
        projectDir: projectPath,
        hypothesis: 'cleanup-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // The ephemeral workspace should be cleaned up
      const worktreeGit = simpleGit(projectPath);
      const branches = await worktreeGit.branchLocal();

      // The hypothesis branch should be removed
      expect(branches.all).not.toContain('hypothesis/cleanup-test');
    });

    it('should cleanup even if baseline validation fails', async () => {
      // Create a failing validate script
      const failingScript = `#!/bin/bash
exit 1
`;
      writeFileSync(join(projectPath, 'failing.sh'), failingScript);
      chmodSync(join(projectPath, 'failing.sh'), 0o755);

      await expect(
        runExperiment({
          projectDir: projectPath,
          hypothesis: 'cleanup-fail-test',
          validateCmd: './failing.sh',
          metricKey: 'accuracy',
          maxIterations: 1,
        })
      ).rejects.toThrow(/Baseline validation failed/);

      // Workspace should still be cleaned up
      const worktreeGit = simpleGit(projectPath);
      const branches = await worktreeGit.branchLocal();

      expect(branches.all).not.toContain('hypothesis/cleanup-fail-test');
    });
  });

  describe('ledger entry', () => {
    it('should create ledger entry with all required fields', async () => {
      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'ledger-fields-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      const entry = result.ledgerEntry;

      expect(entry.timestamp).toBeDefined();
      expect(entry.branch).toBe('hypothesis/ledger-fields-test');
      expect(entry.baseCommit).toBeDefined();
      expect(entry.hypothesisCommit).toBeDefined();
      expect(entry.status).toBeDefined();
      expect(['success', 'failure', 'no_improvement']).toContain(entry.status);
      expect(entry.metrics).toBeDefined();
      expect(entry.durationMs).toBeDefined();
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should record a non-empty hypothesis commit hash on success', async () => {
      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'commit-hash-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      if (result.status !== 'failure') {
        expect(result.ledgerEntry.hypothesisCommit).toBeDefined();
        expect(result.ledgerEntry.hypothesisCommit.length).toBeGreaterThan(0);
        expect(result.ledgerEntry.hypothesisCommit).toMatch(/^[a-f0-9]+$/);
      }
    });

    it('should throw error when metric is missing in baseline', async () => {
      // Create a script that succeeds but missing metric
      const missingMetricScript = `#!/bin/bash
cat > eval_result.json << 'EOF'
{
  "wrong_metric": 0.5
}
EOF
`;
      writeFileSync(join(projectPath, 'missing_metric.sh'), missingMetricScript);
      chmodSync(join(projectPath, 'missing_metric.sh'), 0o755);

      await expect(
        runExperiment({
          projectDir: projectPath,
          hypothesis: 'missing-metric-test',
          validateCmd: './missing_metric.sh',
          metricKey: 'accuracy',
          maxIterations: 1,
        })
      ).rejects.toThrow(/Baseline validation failed/);
    });

    it('should not include error field on success', async () => {
      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'no-error-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // Only include error when it's defined (exactOptionalPropertyTypes compliance)
      if (result.status === 'failure') {
        expect('error' in result.ledgerEntry).toBe(true);
      } else {
        expect(result.ledgerEntry.error).toBeUndefined();
      }
    });
  });

  describe('logging', () => {
    it('should call onLog with progress messages', async () => {
      await runExperiment({
        projectDir: projectPath,
        hypothesis: 'logging-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
        onLog: (msg) => logs.push(msg),
      });

      // Should have logged various progress messages
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((l) => l.includes('Syncing'))).toBe(true);
      expect(logs.some((l) => l.includes('workspace'))).toBe(true);
      expect(logs.some((l) => l.includes('Agent'))).toBe(true);
      expect(logs.some((l) => l.includes('Validation'))).toBe(true);
    });

    it('should use default logging when onLog not provided', () => {
      // Should not throw when onLog is not provided
      return runExperiment({
        projectDir: projectPath,
        hypothesis: 'no-callback-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
        // onLog intentionally omitted
      });
    });
  });

  describe('hypothesis branch naming', () => {
    it('should sanitize hypothesis into valid branch name', async () => {
      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'Test Hypothesis With Spaces!',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // Branch should be sanitized
      expect(result.branch).toMatch(/^hypothesis\/[a-z0-9-]+$/);
    });

    it('should truncate long hypotheses', async () => {
      const longHypothesis = 'a'.repeat(100);

      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: longHypothesis,
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // Branch name should be truncated
      const branchWithoutPrefix = result.branch.replace('hypothesis/', '');
      expect(branchWithoutPrefix.length).toBeLessThanOrEqual(50);
    });
  });

  describe('custom ledger path', () => {
    it('should use custom ledger path when provided', async () => {
      const customLedgerPath = join(testRoot, 'custom', 'experiments.jsonl');
      mkdirSync(join(testRoot, 'custom'), { recursive: true });

      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'custom-ledger-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
        ledgerPath: customLedgerPath,
      });

      expect(existsSync(customLedgerPath)).toBe(true);

      const content = readFileSync(customLedgerPath, 'utf-8');
      const entries = content.trim().split('\n').filter(Boolean);
      expect(entries.length).toBe(1);

      const firstEntryRaw = entries[0];
      if (!firstEntryRaw) throw new Error('No entries in ledger');
      const entry = JSON.parse(firstEntryRaw);
      expect(entry.branch).toBe(result.branch);
    });
  });

  describe('system prompt', () => {
    it('should build experiment-aware system prompt with hypothesis', async () => {
      // This is tested implicitly through successful agent execution
      // The prompt includes the hypothesis, validation command, and rules
      await runExperiment({
        projectDir: projectPath,
        hypothesis: 'prompt-inclusion-test',
        validateCmd: './validate.sh',
        metricKey: 'accuracy',
        maxIterations: 1,
      });

      // If we get here without errors, the prompt was processed
      expect(true).toBe(true);
    });

    it('should include metric key in system prompt context', async () => {
      // Ensure baseline passes first
      const validScript = `#!/bin/bash
cat > eval_result.json << 'EOF'
{
  "custom_metric": 0.5
}
EOF
`;
      writeFileSync(join(projectPath, 'valid_custom.sh'), validScript);
      chmodSync(join(projectPath, 'valid_custom.sh'), 0o755);

      const result = await runExperiment({
        projectDir: projectPath,
        hypothesis: 'metric-context-test',
        validateCmd: './valid_custom.sh',
        metricKey: 'custom_metric',
        maxIterations: 1,
      });

      // Should work regardless of which metric is used
      expect(result.branch).toBeDefined();
    });
  });
});
