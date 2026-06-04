import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TrialLedger } from '../../campaign/trialLedger';
import { TrialEntry } from '../../campaign/types';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

describe('TrialLedger', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: TrialLedger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'trial-ledger-test-'));
    ledgerPath = join(tmpDir, 'trials.jsonl');
    ledger = new TrialLedger({ ledgerPath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const createMockEntry = (overrides: Partial<TrialEntry> = {}): TrialEntry => ({
    trialId: randomUUID(),
    campaignId: randomUUID(),
    timestamp: new Date().toISOString(),
    branch: 'hypothesis/test',
    baseCommit: 'base-123',
    hypothesisCommit: 'hyp-456',
    trialHypothesis: 'test hypothesis',
    status: 'completed',
    metrics: { accuracy: 0.9 },
    durationMs: 1000,
    ...overrides,
  });

  it('should append and read back an entry', async () => {
    const entry = createMockEntry();
    await ledger.append(entry);

    const entries = ledger.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it('should handle concurrent appends with locking', async () => {
    const entries = [createMockEntry(), createMockEntry(), createMockEntry()];

    await Promise.all(entries.map((e) => ledger.append(e)));

    const readEntries = ledger.readAll();
    expect(readEntries).toHaveLength(3);
    expect(readEntries).toEqual(expect.arrayContaining(entries));
  });

  it('should reject entries that do not match the schema', async () => {
    const invalidEntry = {
      trialId: 'not-a-uuid',
      campaignId: 'not-a-uuid',
      // missing other fields
    } as unknown as TrialEntry;

    await expect(ledger.append(invalidEntry)).rejects.toThrow();
  });

  it('should skip malformed lines during readAll', async () => {
    const entry = createMockEntry();
    await ledger.append(entry);

    // Manually append a malformed line
    const { appendFileSync } = await import('node:fs');
    appendFileSync(ledgerPath, 'this is not json\n');
    appendFileSync(ledgerPath, '{"invalid": "json"}\n');
    await ledger.append(createMockEntry());

    const entries = ledger.readAll();
    expect(entries).toHaveLength(2);
  });

  it('should filter entries by campaignId', async () => {
    const campaignA = randomUUID();
    const campaignB = randomUUID();

    const entries = [
      createMockEntry({ campaignId: campaignA }),
      createMockEntry({ campaignId: campaignA }),
      createMockEntry({ campaignId: campaignB }),
    ];

    for (const e of entries) {
      await ledger.append(e);
    }

    const resultA = ledger.readByCampaign(campaignA);
    expect(resultA).toHaveLength(2);
    expect(resultA.every((e) => e.campaignId === campaignA)).toBe(true);

    const resultB = ledger.readByCampaign(campaignB);
    expect(resultB).toHaveLength(1);
    expect(resultB[0]!.campaignId).toBe(campaignB);
  });

  it('should read the last entry', async () => {
    const entry1 = createMockEntry();
    const entry2 = createMockEntry();

    await ledger.append(entry1);
    await ledger.append(entry2);

    expect(ledger.readLast()).toEqual(entry2);
  });

  it('should return null for readLast when empty', () => {
    expect(ledger.readLast()).toBeNull();
  });

  it('should report existence correctly', async () => {
    expect(ledger.exists()).toBe(false);
    await ledger.append(createMockEntry());
    expect(ledger.exists()).toBe(true);
  });

  it('should parse a single line correctly', () => {
    const entry = createMockEntry();
    const line = JSON.stringify(entry);
    expect(TrialLedger.parseLine(line)).toEqual(entry);
    expect(TrialLedger.parseLine('invalid')).toBeNull();
  });
});
