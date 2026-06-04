import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CampaignLedger } from '../../campaign/campaignLedger';
import { CampaignEntry } from '../../campaign/types';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

describe('CampaignLedger', () => {
  let tmpDir: string;
  let ledgerPath: string;
  let ledger: CampaignLedger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join('/tmp', 'campaign-ledger-test-'));
    ledgerPath = join(tmpDir, 'campaigns.jsonl');
    ledger = new CampaignLedger({ ledgerPath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const createMockEntry = (overrides: Partial<CampaignEntry> = {}): CampaignEntry => ({
    campaignId: randomUUID(),
    timestamp: new Date().toISOString(),
    question: 'test question',
    metricKey: 'accuracy',
    maximize: true,
    status: 'completed',
    trialCount: 10,
    bestTrialId: randomUUID(),
    bestMetrics: { accuracy: 0.95 },
    summary: null,
    durationMs: 10000,
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
      campaignId: 'not-a-uuid',
      // missing other fields
    } as unknown as CampaignEntry;

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
    expect(CampaignLedger.parseLine(line)).toEqual(entry);
    expect(CampaignLedger.parseLine('invalid')).toBeNull();
  });
});
