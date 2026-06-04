/**
 * Trial Ledger
 *
 * Handles reading and appending trial entries to the trials.jsonl ledger.
 * The ledger is append-only—no modifications or deletions.
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { TrialEntry, TrialEntrySchema } from './types';

export interface TrialLedgerOptions {
  /** Path to the ledger file */
  ledgerPath: string;
}

/**
 * TrialLedger handles append-only operations on the trial ledger.
 */
export class TrialLedger {
  private readonly ledgerPath: string;

  constructor(opts: TrialLedgerOptions) {
    this.ledgerPath = resolve(opts.ledgerPath);
  }

  /**
   * Get the path to the ledger file.
   */
  getPath(): string {
    return this.ledgerPath;
  }

  /**
   * Append a new entry to the ledger atomically.
   *
   * @param entry - The trial entry to append
   * @throws ZodError if the entry doesn't match the schema
   */
  async append(entry: TrialEntry): Promise<void> {
    // Validate the entry
    const validated = TrialEntrySchema.parse(entry);

    // Serialize
    const line = JSON.stringify(validated) + '\n';

    // Ensure the file exists before locking
    if (!existsSync(this.ledgerPath)) {
      writeFileSync(this.ledgerPath, '');
    }

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(this.ledgerPath, { retries: { retries: 5, minTimeout: 50 } });
      appendFileSync(this.ledgerPath, line);
    } finally {
      if (release) {
        await release();
      }
    }
  }

  /**
   * Read all entries from the ledger.
   */
  readAll(): TrialEntry[] {
    if (!existsSync(this.ledgerPath)) {
      return [];
    }

    const content = readFileSync(this.ledgerPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const entries: TrialEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = TrialEntrySchema.parse(JSON.parse(line));
        entries.push(parsed);
      } catch {
        console.warn(`[TrialLedger] Skipping malformed line: ${line.slice(0, 100)}...`);
      }
    }

    return entries;
  }

  /**
   * Read trials filtered by campaign.
   */
  readByCampaign(campaignId: string): TrialEntry[] {
    return this.readAll().filter((entry) => entry.campaignId === campaignId);
  }

  /**
   * Read the most recent entry.
   */
  readLast(): TrialEntry | null {
    const entries = this.readAll();
    return entries[entries.length - 1] ?? null;
  }

  /**
   * Check if the ledger file exists.
   */
  exists(): boolean {
    return existsSync(this.ledgerPath);
  }

  /**
   * Parse a single line into a TrialEntry.
   */
  static parseLine(line: string): TrialEntry | null {
    try {
      return TrialEntrySchema.parse(JSON.parse(line));
    } catch {
      return null;
    }
  }
}
