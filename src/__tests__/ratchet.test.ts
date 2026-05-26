import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkRatchet,
  getBestMetric,
  createRatchetChecker,
  determineStatus,
  type RatchetResult,
} from '../ratchet';
import { LedgerManager } from '../ledger';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LedgerEntry } from '../ledger';

// Helper to create temp directory with unique name
function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `aesop-ratchet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Helper to create a valid ledger entry
function createEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    timestamp: new Date().toISOString(),
    branch: 'hypothesis/test',
    baseCommit: 'abc123',
    hypothesisCommit: 'def456',
    status: 'success',
    metrics: { accuracy: 0.95, loss: 0.05 },
    durationMs: 120000,
    ...overrides,
  };
}

// Helper to write entries directly to file
function writeEntries(ledgerPath: string, entries: LedgerEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(ledgerPath, lines);
}

// Cleanup helper
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('checkRatchet', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  describe('empty ledger behavior', () => {
    it('should consider first value as improvement when ledger is empty', () => {
      const result = checkRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(true);
      expect(result.current).toBe(0.95);
      expect(result.best).toBe(0.95);
    });

    it('should return empty best branch when ledger is empty', () => {
      const result = checkRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.bestBranch).toBe('');
      expect(result.bestCommit).toBe('');
    });

    it('should handle non-existent ledger file', () => {
      const result = checkRatchet('/nonexistent/path/experiments.jsonl', 'accuracy', 0.85);

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.85);
    });
  });

  describe('maximize mode (default)', () => {
    it('should return improved=true when value beats best', () => {
      // Add existing best
      writeEntries(ledgerPath, [
        createEntry({ branch: 'prev-branch', metrics: { accuracy: 0.9 } }),
      ]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(true);
      expect(result.current).toBe(0.95);
      expect(result.best).toBe(0.9);
      expect(result.bestBranch).toBe('prev-branch');
    });

    it('should return improved=false when value does not beat best', () => {
      writeEntries(ledgerPath, [
        createEntry({ branch: 'best-branch', metrics: { accuracy: 0.98 } }),
      ]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(false);
      expect(result.current).toBe(0.95);
      expect(result.best).toBe(0.98);
      expect(result.bestBranch).toBe('best-branch');
    });

    it('should return improved=false when value equals best (strict inequality)', () => {
      writeEntries(ledgerPath, [createEntry({ branch: 'existing', metrics: { accuracy: 0.95 } })]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(false);
      expect(result.best).toBe(0.95);
    });

    it('should find best value across multiple entries', () => {
      writeEntries(ledgerPath, [
        createEntry({ branch: 'branch-a', metrics: { accuracy: 0.7 } }),
        createEntry({ branch: 'branch-b', metrics: { accuracy: 0.85 } }),
        createEntry({ branch: 'branch-c', metrics: { accuracy: 0.8 } }),
      ]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.5);

      expect(result.improved).toBe(false);
      expect(result.best).toBe(0.85);
      expect(result.bestBranch).toBe('branch-b');
    });

    it('should beat the current best and return new best', () => {
      writeEntries(ledgerPath, [
        createEntry({ branch: 'branch-a', metrics: { accuracy: 0.7 } }),
        createEntry({ branch: 'branch-b', metrics: { accuracy: 0.85 } }),
      ]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.9);

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.85); // Best in ledger
      expect(result.current).toBe(0.9); // New value that beat it
    });
  });

  describe('minimize mode', () => {
    it('should return improved=true when value is lower', () => {
      writeEntries(ledgerPath, [createEntry({ branch: 'prev', metrics: { loss: 0.1 } })]);

      const result = checkRatchet(ledgerPath, 'loss', 0.05, { maximize: false });

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.1);
      expect(result.current).toBe(0.05);
    });

    it('should return improved=false when value is higher', () => {
      writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { loss: 0.02 } })]);

      const result = checkRatchet(ledgerPath, 'loss', 0.05, { maximize: false });

      expect(result.improved).toBe(false);
      expect(result.best).toBe(0.02);
    });

    it('should find lowest value as best in minimize mode', () => {
      writeEntries(ledgerPath, [
        createEntry({ branch: 'branch-a', metrics: { loss: 0.05 } }),
        createEntry({ branch: 'branch-b', metrics: { loss: 0.02 } }),
        createEntry({ branch: 'branch-c', metrics: { loss: 0.08 } }),
      ]);

      const result = checkRatchet(ledgerPath, 'loss', 0.5, { maximize: false });

      expect(result.improved).toBe(false);
      expect(result.best).toBe(0.02);
      expect(result.bestBranch).toBe('branch-b');
    });
  });

  describe('status filtering', () => {
    it('should only consider entries with status "success"', () => {
      writeEntries(ledgerPath, [
        createEntry({ branch: 'success-1', status: 'success', metrics: { accuracy: 0.9 } }),
        createEntry({ branch: 'failure-1', status: 'failure', metrics: { accuracy: 0.95 } }),
        createEntry({
          branch: 'no-improvement-1',
          status: 'no_improvement',
          metrics: { accuracy: 0.8 },
        }),
        createEntry({ branch: 'success-2', status: 'success', metrics: { accuracy: 0.85 } }),
      ]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.7);

      // Should only consider successful entries: 0.9 and 0.85, so best is 0.9
      expect(result.improved).toBe(false);
      expect(result.best).toBe(0.9);
      expect(result.bestBranch).toBe('success-1');
    });

    it('should consider current value as improvement if no successful entries exist', () => {
      writeEntries(ledgerPath, [
        createEntry({ branch: 'failed-1', status: 'failure', metrics: { accuracy: 0.99 } }),
        createEntry({
          branch: 'no-improve-1',
          status: 'no_improvement',
          metrics: { accuracy: 0.98 },
        }),
      ]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.5);

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.5);
      expect(result.bestBranch).toBe('');
    });
  });

  describe('metric key handling', () => {
    it('should only look at the specified metric key', () => {
      writeEntries(ledgerPath, [
        createEntry({
          branch: 'test',
          metrics: { accuracy: 0.7, f1: 0.8, loss: 0.1 },
        }),
      ]);

      const result = checkRatchet(ledgerPath, 'f1', 0.85);

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.8);
    });

    it('should skip entries missing the target metric', () => {
      writeEntries(ledgerPath, [
        createEntry({ branch: 'has-metric', metrics: { accuracy: 0.9 } }),
        createEntry({ branch: 'no-metric', metrics: { f1: 0.8 } }),
      ]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.9);
      expect(result.bestBranch).toBe('has-metric');
    });
  });

  describe('error handling', () => {
    it('should skip malformed JSON lines', () => {
      writeFileSync(ledgerPath, 'not valid json\n');
      writeEntries(ledgerPath, [createEntry({ branch: 'valid', metrics: { accuracy: 0.9 } })]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.85);

      expect(result.improved).toBe(false);
      expect(result.best).toBe(0.9);
    });

    it('should skip lines with missing fields', () => {
      writeFileSync(ledgerPath, '{"branch": "incomplete"}\n');
      writeEntries(ledgerPath, [createEntry({ branch: 'complete', metrics: { accuracy: 0.85 } })]);

      const result = checkRatchet(ledgerPath, 'accuracy', 0.8);

      expect(result.best).toBe(0.85);
    });

    it('should handle empty ledger file', () => {
      writeFileSync(ledgerPath, '');
      // Write nothing - empty file

      const result = checkRatchet(ledgerPath, 'accuracy', 0.5);

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.5);
    });

    it('should handle file with only whitespace', () => {
      writeFileSync(ledgerPath, '   \n   \n');

      const result = checkRatchet(ledgerPath, 'accuracy', 0.75);

      expect(result.improved).toBe(true);
      expect(result.best).toBe(0.75);
    });
  });
});

describe('getBestMetric', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should return best metric details', () => {
    writeEntries(ledgerPath, [
      createEntry({
        branch: 'best-branch',
        hypothesisCommit: 'abc123',
        metrics: { accuracy: 0.95 },
      }),
      createEntry({
        branch: 'other',
        hypothesisCommit: 'def456',
        metrics: { accuracy: 0.85 },
      }),
    ]);

    const best = getBestMetric(ledgerPath, 'accuracy');

    expect(best).not.toBeNull();
    expect(best?.value).toBe(0.95);
    expect(best?.branch).toBe('best-branch');
    expect(best?.commit).toBe('abc123');
  });

  it('should return null when no successful entries exist', () => {
    writeEntries(ledgerPath, [
      createEntry({ branch: 'failed', status: 'failure', metrics: { accuracy: 0.95 } }),
    ]);

    const best = getBestMetric(ledgerPath, 'accuracy');

    expect(best).toBeNull();
  });

  it('should return null for empty ledger', () => {
    const best = getBestMetric(ledgerPath, 'accuracy');

    expect(best).toBeNull();
  });

  it('should support minimize mode', () => {
    writeEntries(ledgerPath, [
      createEntry({ branch: 'low', metrics: { loss: 0.05 } }),
      createEntry({ branch: 'high', metrics: { loss: 0.1 } }),
    ]);

    const best = getBestMetric(ledgerPath, 'loss', { maximize: false });

    expect(best).not.toBeNull();
    expect(best?.value).toBe(0.05);
    expect(best?.branch).toBe('low');
  });
});

describe('createRatchetChecker', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should create a bound ratchet checker', () => {
    const ledger = new LedgerManager({ ledgerPath });

    writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { accuracy: 0.9 } })]);

    const check = createRatchetChecker(ledger, { maximize: true });
    const result = check('accuracy', 0.95);

    expect(result.improved).toBe(true);
    expect(result.best).toBe(0.9);
  });

  it('should use maximize=false when specified', () => {
    const ledger = new LedgerManager({ ledgerPath });

    writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { loss: 0.05 } })]);

    const check = createRatchetChecker(ledger, { maximize: false });
    const result = check('loss', 0.02);

    expect(result.improved).toBe(true);
    expect(result.best).toBe(0.05);
  });

  it('should default to maximize=true', () => {
    const ledger = new LedgerManager({ ledgerPath });

    writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { accuracy: 0.9 } })]);

    const check = createRatchetChecker(ledger); // No maximize specified
    const result = check('accuracy', 0.95);

    expect(result.improved).toBe(true);
  });
});

describe('determineStatus', () => {
  it('should return "success" when validation passed and improved', () => {
    const ratchetResult: RatchetResult = {
      improved: true,
      current: 0.96,
      best: 0.9,
      bestBranch: 'prev',
      bestCommit: 'abc',
    };

    const status = determineStatus(ratchetResult, true);

    expect(status).toBe('success');
  });

  it('should return "no_improvement" when validation passed but not improved', () => {
    const ratchetResult: RatchetResult = {
      improved: false,
      current: 0.85,
      best: 0.9,
      bestBranch: 'best',
      bestCommit: 'abc',
    };

    const status = determineStatus(ratchetResult, true);

    expect(status).toBe('no_improvement');
  });

  it('should return "failure" when validation failed', () => {
    const ratchetResult: RatchetResult = {
      improved: true,
      current: 0.96,
      best: 0.9,
      bestBranch: 'prev',
      bestCommit: 'abc',
    };

    const status = determineStatus(ratchetResult, false);

    expect(status).toBe('failure');
  });

  it('should return "failure" even when ratchet says improved (validation takes precedence)', () => {
    const ratchetResult: RatchetResult = {
      improved: true,
      current: 0.96,
      best: 0.9,
      bestBranch: 'prev',
      bestCommit: 'abc',
    };

    const status = determineStatus(ratchetResult, false);

    expect(status).toBe('failure');
  });
});

describe('checkRatchet integration', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should support the full ratchet workflow', async () => {
    // Simulate a series of experiments over time

    // First experiment - establishes baseline
    let result = checkRatchet(ledgerPath, 'accuracy', 0.82);
    expect(result.improved).toBe(true);
    expect(result.best).toBe(0.82);

    // Append to ledger
    const ledger = new LedgerManager({ ledgerPath });
    await ledger.append(
      createEntry({
        branch: 'baseline',
        hypothesisCommit: 'commita',
        status: 'success',
        metrics: { accuracy: 0.82 },
      })
    );

    // Second experiment - improves
    result = checkRatchet(ledgerPath, 'accuracy', 0.88);
    expect(result.improved).toBe(true);
    expect(result.best).toBe(0.82);
    await ledger.append(
      createEntry({
        branch: 'improved-1',
        hypothesisCommit: 'commitb',
        status: 'success',
        metrics: { accuracy: 0.88 },
      })
    );

    // Third experiment - validates but doesn't improve
    result = checkRatchet(ledgerPath, 'accuracy', 0.87);
    expect(result.improved).toBe(false);
    expect(result.best).toBe(0.88);
    const status = determineStatus(result, true);
    expect(status).toBe('no_improvement');

    // Fourth experiment - failure
    result = checkRatchet(ledgerPath, 'accuracy', 0.5);
    // Still compares against best
    expect(result.improved).toBe(false);
    expect(result.best).toBe(0.88);

    // Fifth experiment - beats the best
    result = checkRatchet(ledgerPath, 'accuracy', 0.92);
    expect(result.improved).toBe(true);
    await ledger.append(
      createEntry({
        branch: 'breakthrough',
        hypothesisCommit: 'commitc',
        status: 'success',
        metrics: { accuracy: 0.92 },
      })
    );

    // Final check
    const finalBest = getBestMetric(ledgerPath, 'accuracy');
    expect(finalBest).not.toBeNull();
    expect(finalBest?.value).toBe(0.92);
    expect(finalBest?.branch).toBe('breakthrough');
  });

  it('should work with multiple metrics independently', () => {
    writeEntries(ledgerPath, [
      createEntry({ branch: 'exp-1', metrics: { accuracy: 0.9, latency: 100 } }),
      createEntry({ branch: 'exp-2', metrics: { accuracy: 0.85, latency: 80 } }),
    ]);

    // Check accuracy - 0.9 is best
    const accResult = checkRatchet(ledgerPath, 'accuracy', 0.88);
    expect(accResult.improved).toBe(false);
    expect(accResult.best).toBe(0.9);

    // Check latency - 80 is best (minimize)
    const latResult = checkRatchet(ledgerPath, 'latency', 85, { maximize: false });
    expect(latResult.improved).toBe(false);
    expect(latResult.best).toBe(80);

    // New accuracy beats best
    const accWin = checkRatchet(ledgerPath, 'accuracy', 0.95);
    expect(accWin.improved).toBe(true);

    // New latency beats best
    const latWin = checkRatchet(ledgerPath, 'latency', 70, { maximize: false });
    expect(latWin.improved).toBe(true);
  });
});
