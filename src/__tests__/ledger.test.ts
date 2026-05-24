import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LedgerManager, LedgerEntrySchema, LedgerEntryStatus, type LedgerEntry } from '../ledger';
import { mkdirSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Helper to create temp directory with unique name
function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `aesop-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

// Cleanup helper
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('LedgerEntrySchema', () => {
  it('should parse a valid ledger entry', () => {
    const valid = createEntry();

    const result = LedgerEntrySchema.parse(valid);

    expect(result.branch).toBe('hypothesis/test');
    expect(result.status).toBe('success');
    expect(result.metrics['accuracy']).toBe(0.95);
  });

  it('should accept all valid status values', () => {
    for (const status of ['success', 'failure', 'no_improvement'] as const) {
      const entry = createEntry({ status });
      const result = LedgerEntrySchema.parse(entry);
      expect(result.status).toBe(status);
    }
  });

  it('should reject invalid status values', () => {
    const invalid = createEntry({ status: 'pending' as LedgerEntry['status'] });

    expect(() => LedgerEntrySchema.parse(invalid)).toThrow();
  });

  it('should reject invalid timestamp', () => {
    const invalid = createEntry({ timestamp: 'not-a-date' });

    expect(() => LedgerEntrySchema.parse(invalid)).toThrow();
  });

  it('should reject negative duration', () => {
    const invalid = createEntry({ durationMs: -100 });

    expect(() => LedgerEntrySchema.parse(invalid)).toThrow();
  });

  it('should allow optional error field', () => {
    const withError = createEntry({
      status: 'failure',
      error: 'Training diverged: loss became NaN',
    });

    const result = LedgerEntrySchema.parse(withError);
    expect(result.error).toBe('Training diverged: loss became NaN');
  });

  it('should reject invalid metrics with string values', () => {
    const invalid = createEntry({ metrics: { accuracy: 0.8 } as Record<string, number> });
    // Force string type to test validation - this would fail schema
    Object.defineProperty(invalid.metrics, 'accuracy', {
      value: 'high' as unknown as number,
      writable: true,
    });

    expect(() => LedgerEntrySchema.parse(invalid)).toThrow();
  });

  it('should allow empty metrics object', () => {
    const empty = createEntry({ metrics: {} });
    const result = LedgerEntrySchema.parse(empty);
    expect(result.metrics).toEqual({});
  });
});

describe('LedgerEntryStatus', () => {
  it('should include all expected values', () => {
    expect(LedgerEntryStatus.options).toEqual(['success', 'failure', 'no_improvement']);
  });
});

describe('LedgerManager', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  describe('constructor', () => {
    it('should use default path when not specified', () => {
      const ledger = new LedgerManager();
      expect(ledger.getPath()).toContain('experiments.jsonl');
    });

    it('should use custom path when specified', () => {
      const ledger = new LedgerManager({ ledgerPath });
      expect(ledger.getPath()).toBe(ledgerPath);
    });

    it('should resolve relative paths', () => {
      const ledger = new LedgerManager({ ledgerPath: './test.jsonl' });
      expect(ledger.getPath()).toBe(resolve('./test.jsonl'));
    });
  });

  describe('append', () => {
    it('should append a valid entry to the ledger', () => {
      const ledger = new LedgerManager({ ledgerPath });
      const entry = createEntry();

      ledger.append(entry);

      const content = readFileSync(ledgerPath, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.branch).toBe(entry.branch);
      expect(parsed.status).toBe(entry.status);
    });

    it('should append multiple entries as separate lines', () => {
      const ledger = new LedgerManager({ ledgerPath });
      const entry1 = createEntry({ branch: 'branch-1', metrics: { accuracy: 0.9 } });
      const entry2 = createEntry({ branch: 'branch-2', metrics: { accuracy: 0.95 } });

      ledger.append(entry1);
      ledger.append(entry2);

      const content = readFileSync(ledgerPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });

    it('should throw on invalid entry', () => {
      const ledger = new LedgerManager({ ledgerPath });
      const invalid = createEntry({ status: 'invalid' as LedgerEntry['status'] });

      expect(() => ledger.append(invalid)).toThrow();
    });

    it('should create ledger file if it does not exist', () => {
      const ledger = new LedgerManager({ ledgerPath });
      expect(existsSync(ledgerPath)).toBe(false);

      ledger.append(createEntry());

      expect(existsSync(ledgerPath)).toBe(true);
    });
  });

  describe('readAll', () => {
    it('should return empty array for non-existent ledger', () => {
      const ledger = new LedgerManager({ ledgerPath: '/nonexistent/path.jsonl' });

      const entries = ledger.readAll();

      expect(entries).toEqual([]);
    });

    it('should read all entries from ledger', () => {
      const ledger = new LedgerManager({ ledgerPath });
      const entry1 = createEntry({ branch: 'branch-1', metrics: { accuracy: 0.9 } });
      const entry2 = createEntry({ branch: 'branch-2', metrics: { accuracy: 0.95 } });

      ledger.append(entry1);
      ledger.append(entry2);

      const entries = ledger.readAll();

      expect(entries).toHaveLength(2);
      expect(entries[0]?.branch).toBe('branch-1');
      expect(entries[1]?.branch).toBe('branch-2');
    });

    it('should skip malformed lines', () => {
      const ledger = new LedgerManager({ ledgerPath });

      // Append valid entry
      ledger.append(createEntry({ branch: 'valid-branch' }));

      // Append malformed line directly
      appendFileSync(ledgerPath, 'this is not json\n');

      // Append another valid entry
      ledger.append(createEntry({ branch: 'valid-branch-2' }));

      const entries = ledger.readAll();

      expect(entries).toHaveLength(2);
      expect(entries[0]?.branch).toBe('valid-branch');
      expect(entries[1]?.branch).toBe('valid-branch-2');
    });

    it('should return entries in chronological order', () => {
      const ledger = new LedgerManager({ ledgerPath });

      for (let i = 0; i < 5; i++) {
        ledger.append(createEntry({ branch: `branch-${i}` }));
      }

      const entries = ledger.readAll();

      expect(entries.map((e) => e.branch)).toEqual([
        'branch-0',
        'branch-1',
        'branch-2',
        'branch-3',
        'branch-4',
      ]);
    });
  });

  describe('readByStatus', () => {
    it('should filter entries by status', () => {
      const ledger = new LedgerManager({ ledgerPath });

      ledger.append(createEntry({ status: 'success', branch: 'success-1' }));
      ledger.append(createEntry({ status: 'failure', branch: 'failure-1' }));
      ledger.append(createEntry({ status: 'success', branch: 'success-2' }));
      ledger.append(createEntry({ status: 'no_improvement', branch: 'no-improvement-1' }));

      const successEntries = ledger.readByStatus('success');
      const failureEntries = ledger.readByStatus('failure');
      const noImprovementEntries = ledger.readByStatus('no_improvement');

      expect(successEntries).toHaveLength(2);
      expect(failureEntries).toHaveLength(1);
      expect(noImprovementEntries).toHaveLength(1);

      expect(successEntries.map((e) => e.branch)).toEqual(['success-1', 'success-2']);
      expect(failureEntries[0]?.branch).toBe('failure-1');
      expect(noImprovementEntries[0]?.branch).toBe('no-improvement-1');
    });

    it('should return empty array when no entries match', () => {
      const ledger = new LedgerManager({ ledgerPath });
      ledger.append(createEntry({ status: 'success' }));

      const failureEntries = ledger.readByStatus('failure');

      expect(failureEntries).toEqual([]);
    });
  });

  describe('readLast', () => {
    it('should return the last entry', () => {
      const ledger = new LedgerManager({ ledgerPath });

      ledger.append(createEntry({ branch: 'first' }));
      ledger.append(createEntry({ branch: 'second' }));
      ledger.append(createEntry({ branch: 'third' }));

      const last = ledger.readLast();

      expect(last?.branch).toBe('third');
    });

    it('should return null for empty ledger', () => {
      const ledger = new LedgerManager({ ledgerPath });

      const last = ledger.readLast();

      expect(last).toBeNull();
    });
  });

  describe('getBranches', () => {
    it('should return unique branch names', () => {
      const ledger = new LedgerManager({ ledgerPath });

      ledger.append(createEntry({ branch: 'branch-a' }));
      ledger.append(createEntry({ branch: 'branch-b' }));
      ledger.append(createEntry({ branch: 'branch-a' })); // Duplicate
      ledger.append(createEntry({ branch: 'branch-c' }));

      const branches = ledger.getBranches();

      expect(branches).toHaveLength(3);
      expect(branches).toContain('branch-a');
      expect(branches).toContain('branch-b');
      expect(branches).toContain('branch-c');
    });

    it('should return empty array for empty ledger', () => {
      const ledger = new LedgerManager({ ledgerPath });

      const branches = ledger.getBranches();

      expect(branches).toEqual([]);
    });
  });

  describe('exists', () => {
    it('should return true when ledger exists', () => {
      const ledger = new LedgerManager({ ledgerPath });
      ledger.append(createEntry());

      expect(ledger.exists()).toBe(true);
    });

    it('should return false when ledger does not exist', () => {
      const ledger = new LedgerManager({ ledgerPath });

      expect(ledger.exists()).toBe(false);
    });
  });

  describe('parseLine', () => {
    it('should parse a valid line', () => {
      const entry = createEntry();
      const line = JSON.stringify(entry);

      const parsed = LedgerManager.parseLine(line);

      expect(parsed).not.toBeNull();
      expect(parsed?.branch).toBe(entry.branch);
    });

    it('should return null for invalid line', () => {
      expect(LedgerManager.parseLine('not json')).toBeNull();
      expect(LedgerManager.parseLine('{"invalid": true}')).toBeNull();
    });
  });
});

describe('LedgerManager integration scenarios', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    ledgerPath = join(tempDir, 'experiments.jsonl');
  });

  afterEach(() => {
    cleanupDir(tempDir);
  });

  it('should handle concurrent appends sequentially', () => {
    const ledger = new LedgerManager({ ledgerPath });
    const entries = Array.from({ length: 100 }, (_, i) =>
      createEntry({ branch: `branch-${i}`, metrics: { run: i } })
    );

    // Simulate sequential appends (in practice, fs.appendFileSync is atomic for single calls)
    entries.forEach((entry) => ledger.append(entry));

    const readEntries = ledger.readAll();
    expect(readEntries).toHaveLength(100);
  });

  it('should preserve data integrity across read-write cycles', () => {
    const ledger = new LedgerManager({ ledgerPath });

    // Write some entries
    const entries = [
      createEntry({ branch: 'test-1', metrics: { accuracy: 0.8 } }),
      createEntry({ branch: 'test-2', metrics: { accuracy: 0.85 } }),
    ];
    entries.forEach((e) => ledger.append(e));

    // Create new manager instance pointing to same file
    const ledger2 = new LedgerManager({ ledgerPath });
    const readEntries = ledger2.readAll();

    expect(readEntries).toHaveLength(2);
    expect(readEntries[0]?.metrics['accuracy']).toBe(0.8);
    expect(readEntries[1]?.metrics['accuracy']).toBe(0.85);
  });
});
