import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkRatchet,
  getGlobalBest,
  isNewGlobalBest,
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
  describe('baseline comparison (maximize)', () => {
    it('should return improved=true when value beats baseline', () => {
      const result = checkRatchet(0.9, 0.95);

      expect(result.improved).toBe(true);
      expect(result.current).toBe(0.95);
      expect(result.baseline).toBe(0.9);
    });

    it('should return improved=false when value does not beat baseline', () => {
      const result = checkRatchet(0.95, 0.9);

      expect(result.improved).toBe(false);
      expect(result.current).toBe(0.9);
      expect(result.baseline).toBe(0.95);
    });

    it('should return improved=false when value equals baseline (strict inequality)', () => {
      const result = checkRatchet(0.95, 0.95);

      expect(result.improved).toBe(false);
      expect(result.current).toBe(0.95);
      expect(result.baseline).toBe(0.95);
    });
  });

  describe('baseline comparison (minimize)', () => {
    it('should return improved=true when value is lower', () => {
      const result = checkRatchet(0.1, 0.05, { maximize: false });

      expect(result.improved).toBe(true);
      expect(result.current).toBe(0.05);
      expect(result.baseline).toBe(0.1);
    });

    it('should return improved=false when value is higher', () => {
      const result = checkRatchet(0.05, 0.1, { maximize: false });

      expect(result.improved).toBe(false);
      expect(result.current).toBe(0.1);
      expect(result.baseline).toBe(0.05);
    });

    it('should return improved=false when value equals baseline', () => {
      const result = checkRatchet(0.05, 0.05, { maximize: false });

      expect(result.improved).toBe(false);
    });
  });
});

describe('getGlobalBest', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should return best metric details from successful entries', () => {
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

    const best = getGlobalBest(ledgerPath, 'accuracy');

    expect(best).not.toBeNull();
    expect(best?.value).toBe(0.95);
    expect(best?.branch).toBe('best-branch');
    expect(best?.commit).toBe('abc123');
  });

  it('should return null when no successful entries exist', () => {
    writeEntries(ledgerPath, [
      createEntry({ branch: 'failed', status: 'failure', metrics: { accuracy: 0.95 } }),
    ]);

    const best = getGlobalBest(ledgerPath, 'accuracy');

    expect(best).toBeNull();
  });

  it('should return null for empty ledger', () => {
    const best = getGlobalBest(ledgerPath, 'accuracy');

    expect(best).toBeNull();
  });

  it('should support minimize mode', () => {
    writeEntries(ledgerPath, [
      createEntry({ branch: 'low', metrics: { loss: 0.05 } }),
      createEntry({ branch: 'high', metrics: { loss: 0.1 } }),
    ]);

    const best = getGlobalBest(ledgerPath, 'loss', { maximize: false });

    expect(best).not.toBeNull();
    expect(best?.value).toBe(0.05);
    expect(best?.branch).toBe('low');
  });

  it('should skip no_improvement entries', () => {
    writeEntries(ledgerPath, [
      createEntry({ branch: 'success', status: 'success', metrics: { accuracy: 0.85 } }),
      createEntry({
        branch: 'no-improve',
        status: 'no_improvement',
        metrics: { accuracy: 0.9 },
      }),
    ]);

    const best = getGlobalBest(ledgerPath, 'accuracy');

    // Should only consider successful entries
    expect(best?.value).toBe(0.85);
  });
});

describe('isNewGlobalBest', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should return true when ledger is empty (first entry)', () => {
    const result = isNewGlobalBest(ledgerPath, 'accuracy', 0.95);

    expect(result).toBe(true);
  });

  it('should return true when value beats the global best', () => {
    writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { accuracy: 0.9 } })]);

    const result = isNewGlobalBest(ledgerPath, 'accuracy', 0.95);

    expect(result).toBe(true);
  });

  it('should return false when value does not beat the global best', () => {
    writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { accuracy: 0.98 } })]);

    const result = isNewGlobalBest(ledgerPath, 'accuracy', 0.95);

    expect(result).toBe(false);
  });

  it('should return false when value equals global best', () => {
    writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { accuracy: 0.95 } })]);

    const result = isNewGlobalBest(ledgerPath, 'accuracy', 0.95);

    expect(result).toBe(false);
  });

  it('should handle minimize mode', () => {
    writeEntries(ledgerPath, [createEntry({ branch: 'best', metrics: { loss: 0.05 } })]);

    // Lower is better for loss
    expect(isNewGlobalBest(ledgerPath, 'loss', 0.02, { maximize: false })).toBe(true);
    expect(isNewGlobalBest(ledgerPath, 'loss', 0.08, { maximize: false })).toBe(false);
  });
});

describe('determineStatus', () => {
  it('should return "success" when validation passed and improved', () => {
    const ratchetResult: RatchetResult = {
      improved: true,
      current: 0.96,
      baseline: 0.9,
    };

    const status = determineStatus(ratchetResult, true);

    expect(status).toBe('success');
  });

  it('should return "no_improvement" when validation passed but not improved', () => {
    const ratchetResult: RatchetResult = {
      improved: false,
      current: 0.85,
      baseline: 0.9,
    };

    const status = determineStatus(ratchetResult, true);

    expect(status).toBe('no_improvement');
  });

  it('should return "failure" when validation failed', () => {
    const ratchetResult: RatchetResult = {
      improved: true,
      current: 0.96,
      baseline: 0.9,
    };

    const status = determineStatus(ratchetResult, false);

    expect(status).toBe('failure');
  });

  it('should return "failure" even when ratchet says improved (validation takes precedence)', () => {
    const ratchetResult: RatchetResult = {
      improved: true,
      current: 0.96,
      baseline: 0.9,
    };

    const status = determineStatus(ratchetResult, false);

    expect(status).toBe('failure');
  });
});

describe('integration: baseline vs global best separation', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  /**
   * This test verifies the key fix: ablation studies now work correctly.
   *
   * Scenario:
   * - Run A: lr=0.001, baseline=0.92, final=0.934 (beats baseline → success, also global best)
   * - Run B: lr=0.005, baseline=0.92, final=0.927 (beats baseline → success, NOT global best)
   * - Run C: lr=0.01,  baseline=0.93, final=0.938 (beats baseline → success, NOT global best)
   *
   * Previously, Run B and C would be marked "no_improvement" because they didn't beat the
   * global best from Run A. Now they correctly get "success" because they beat their baselines.
   */
  it('should mark runs as success when they beat their own baseline, even if not global best', async () => {
    const ledger = new LedgerManager({ ledgerPath });

    // Run A: establishes 0.934 as global best
    await ledger.append(
      createEntry({
        branch: 'lr-0.001',
        hypothesisCommit: 'a1',
        status: 'success',
        metrics: { accuracy: 0.934 },
        globalBest: true,
      })
    );

    // Run B: baseline 0.92, achieved 0.927 - beats baseline, not global best
    const runBRatchet = checkRatchet(0.92, 0.927);
    expect(runBRatchet.improved).toBe(true); // Beats baseline!
    const runBIsGlobal = isNewGlobalBest(ledgerPath, 'accuracy', 0.927);
    expect(runBIsGlobal).toBe(false); // But not global best

    await ledger.append(
      createEntry({
        branch: 'lr-0.005',
        hypothesisCommit: 'b1',
        status: determineStatus(runBRatchet, true),
        metrics: { accuracy: 0.927 },
        globalBest: runBIsGlobal,
      })
    );

    // Run C: baseline 0.93, achieved 0.938 - beats baseline, is global best
    const runCRatchet = checkRatchet(0.93, 0.938);
    expect(runCRatchet.improved).toBe(true); // Beats baseline!
    const runCIsGlobal = isNewGlobalBest(ledgerPath, 'accuracy', 0.938);
    expect(runCIsGlobal).toBe(true); // Also new global best

    await ledger.append(
      createEntry({
        branch: 'lr-0.01',
        hypothesisCommit: 'c1',
        status: determineStatus(runCRatchet, true),
        metrics: { accuracy: 0.938 },
        globalBest: runCIsGlobal,
      })
    );

    // Verify ledger
    const successes = ledger.readByStatus('success');
    expect(successes).toHaveLength(3); // All three runs are successes

    const globalBests = successes.filter((e) => e.globalBest);
    expect(globalBests).toHaveLength(2); // Only runs A and C are global bests
    expect(globalBests[0]?.branch).toBe('lr-0.001');
    expect(globalBests[1]?.branch).toBe('lr-0.01');
  });

  it('should support the full experiment workflow', async () => {
    // Simulate a series of ablation experiments

    const ledger = new LedgerManager({ ledgerPath });

    // Experiment 1: baseline=0.82, achieved=0.88
    const exp1Ratchet = checkRatchet(0.82, 0.88);
    expect(exp1Ratchet.improved).toBe(true);

    await ledger.append(
      createEntry({
        branch: 'exp-1',
        hypothesisCommit: 'e1',
        status: determineStatus(exp1Ratchet, true),
        metrics: { accuracy: 0.88 },
        globalBest: isNewGlobalBest(ledgerPath, 'accuracy', 0.88),
      })
    );

    // Experiment 2: baseline=0.85, achieved=0.87 (beats baseline but not global)
    const exp2Ratchet = checkRatchet(0.85, 0.87);
    expect(exp2Ratchet.improved).toBe(true); // Still beats baseline

    await ledger.append(
      createEntry({
        branch: 'exp-2',
        hypothesisCommit: 'e2',
        status: determineStatus(exp2Ratchet, true),
        metrics: { accuracy: 0.87 },
        globalBest: isNewGlobalBest(ledgerPath, 'accuracy', 0.87),
      })
    );

    // Experiment 3: baseline=0.82, achieved=0.86 (beats baseline but not global)
    const exp3Ratchet = checkRatchet(0.82, 0.86);
    expect(exp3Ratchet.improved).toBe(true);

    await ledger.append(
      createEntry({
        branch: 'exp-3',
        hypothesisCommit: 'e3',
        status: determineStatus(exp3Ratchet, true),
        metrics: { accuracy: 0.86 },
        globalBest: isNewGlobalBest(ledgerPath, 'accuracy', 0.86),
      })
    );

    // All three should be successes
    const successes = ledger.readByStatus('success');
    expect(successes).toHaveLength(3);

    // Only exp-1 is global best
    const globalBests = successes.filter((e) => e.globalBest);
    expect(globalBests).toHaveLength(1);
    expect(globalBests[0]?.branch).toBe('exp-1');

    // Final check: global best is still exp-1's 0.88
    const best = getGlobalBest(ledgerPath, 'accuracy');
    expect(best?.value).toBe(0.88);
    expect(best?.branch).toBe('exp-1');
  });
});
