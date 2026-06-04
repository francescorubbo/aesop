import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkCampaignRatchet } from '../../campaign/campaignRatchet';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CampaignEntry } from '../../campaign/types';

// Helper to create temp directory with unique name
function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `aesop-campaign-ratchet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Helper to create a valid campaign entry
function createEntry(overrides: Partial<CampaignEntry> = {}): CampaignEntry {
  return {
    campaignId: 'campaign-123',
    timestamp: new Date().toISOString(),
    question: 'Test question',
    metricKey: 'accuracy',
    maximize: true,
    status: 'completed',
    trialCount: 5,
    bestTrialId: 'trial-456',
    bestMetrics: { accuracy: 0.95, loss: 0.05 },
    summary: null,
    durationMs: 120000,
    ...overrides,
  };
}

// Helper to write entries directly to file
function writeEntries(ledgerPath: string, entries: CampaignEntry[]): void {
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

describe('checkCampaignRatchet', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'campaigns.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should return improved=true when ledger is empty (first value always improves)', () => {
    const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.95);

    expect(result.improved).toBe(true);
    expect(result.current).toBe(0.95);
    expect(result.historicalBest).toBeNull();
    expect(result.bestCampaignId).toBeNull();
  });

  describe('maximize mode', () => {
    it('should return improved=true when currentBest beats historical best', () => {
      writeEntries(ledgerPath, [createEntry({ campaignId: 'c1', bestMetrics: { accuracy: 0.9 } })]);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(true);
      expect(result.current).toBe(0.95);
      expect(result.historicalBest).toBe(0.9);
      expect(result.bestCampaignId).toBe('c1');
    });

    it('should return improved=false when currentBest does not beat historical best', () => {
      writeEntries(ledgerPath, [
        createEntry({ campaignId: 'c1', bestMetrics: { accuracy: 0.98 } }),
      ]);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(false);
      expect(result.current).toBe(0.95);
      expect(result.historicalBest).toBe(0.98);
      expect(result.bestCampaignId).toBe('c1');
    });

    it('should return improved=false when currentBest equals historical best (strict inequality)', () => {
      writeEntries(ledgerPath, [
        createEntry({ campaignId: 'c1', bestMetrics: { accuracy: 0.95 } }),
      ]);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.95);

      expect(result.improved).toBe(false);
    });

    it('should find the global best across multiple campaigns', () => {
      writeEntries(ledgerPath, [
        createEntry({ campaignId: 'c1', bestMetrics: { accuracy: 0.85 } }),
        createEntry({ campaignId: 'c2', bestMetrics: { accuracy: 0.92 } }),
        createEntry({ campaignId: 'c3', bestMetrics: { accuracy: 0.88 } }),
      ]);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.93);

      expect(result.improved).toBe(true);
      expect(result.historicalBest).toBe(0.92);
      expect(result.bestCampaignId).toBe('c2');
    });
  });

  describe('minimize mode', () => {
    it('should return improved=true when currentBest is lower than historical best', () => {
      writeEntries(ledgerPath, [createEntry({ campaignId: 'c1', bestMetrics: { loss: 0.1 } })]);

      const result = checkCampaignRatchet(ledgerPath, 'loss', 0.05, { maximize: false });

      expect(result.improved).toBe(true);
      expect(result.current).toBe(0.05);
      expect(result.historicalBest).toBe(0.1);
      expect(result.bestCampaignId).toBe('c1');
    });

    it('should return improved=false when currentBest is higher than historical best', () => {
      writeEntries(ledgerPath, [createEntry({ campaignId: 'c1', bestMetrics: { loss: 0.02 } })]);

      const result = checkCampaignRatchet(ledgerPath, 'loss', 0.05, { maximize: false });

      expect(result.improved).toBe(false);
      expect(result.current).toBe(0.05);
      expect(result.historicalBest).toBe(0.02);
      expect(result.bestCampaignId).toBe('c1');
    });

    it('should return improved=false when currentBest equals historical best', () => {
      writeEntries(ledgerPath, [createEntry({ campaignId: 'c1', bestMetrics: { loss: 0.05 } })]);

      const result = checkCampaignRatchet(ledgerPath, 'loss', 0.05, { maximize: false });

      expect(result.improved).toBe(false);
    });
  });

  describe('filtering and robustness', () => {
    it('should only count completed campaigns', () => {
      writeEntries(ledgerPath, [
        createEntry({ campaignId: 'c1', status: 'failed', bestMetrics: { accuracy: 0.99 } }),
        createEntry({ campaignId: 'c2', status: 'completed', bestMetrics: { accuracy: 0.8 } }),
      ]);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.85);

      // Should ignore c1 (failed) and compare against c2 (0.80)
      expect(result.improved).toBe(true);
      expect(result.historicalBest).toBe(0.8);
      expect(result.bestCampaignId).toBe('c2');
    });

    it('should exclude budget_exhausted campaigns', () => {
      writeEntries(ledgerPath, [
        createEntry({
          campaignId: 'c1',
          status: 'budget_exhausted',
          bestMetrics: { accuracy: 0.99 },
        }),
        createEntry({ campaignId: 'c2', status: 'completed', bestMetrics: { accuracy: 0.8 } }),
      ]);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.85);

      expect(result.improved).toBe(true);
      expect(result.historicalBest).toBe(0.8);
      expect(result.bestCampaignId).toBe('c2');
    });

    it('should skip campaigns missing the requested metric', () => {
      writeEntries(ledgerPath, [
        createEntry({ campaignId: 'c1', bestMetrics: { other_metric: 0.99 } }),
        createEntry({ campaignId: 'c2', bestMetrics: { accuracy: 0.8 } }),
      ]);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.85);

      expect(result.improved).toBe(true);
      expect(result.historicalBest).toBe(0.8);
      expect(result.bestCampaignId).toBe('c2');
    });

    it('should skip malformed lines', () => {
      writeFileSync(ledgerPath, '{"invalid": "json"}\nNOT_JSON\n');
      writeEntries(ledgerPath, [createEntry({ campaignId: 'c1', bestMetrics: { accuracy: 0.8 } })]);
      // Actually writeEntries overwrites, let's append or write manually
      const content =
        '{"invalid": "json"}\nNOT_JSON\n' +
        JSON.stringify(createEntry({ campaignId: 'c1', bestMetrics: { accuracy: 0.8 } })) +
        '\n';
      writeFileSync(ledgerPath, content);

      const result = checkCampaignRatchet(ledgerPath, 'accuracy', 0.85);

      expect(result.improved).toBe(true);
      expect(result.historicalBest).toBe(0.8);
      expect(result.bestCampaignId).toBe('c1');
    });

    it('should handle non-existent ledger file gracefully', () => {
      const result = checkCampaignRatchet('non-existent-file.jsonl', 'accuracy', 0.95);

      expect(result.improved).toBe(true);
      expect(result.historicalBest).toBeNull();
    });
  });
});
