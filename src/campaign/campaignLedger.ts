/**
 * Campaign Ledger
 *
 * Handles reading and appending campaign entries to the campaigns.jsonl ledger.
 * The ledger is append-only—no modifications or deletions.
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { CampaignEntry, CampaignEntrySchema } from './types';

export interface CampaignLedgerOptions {
  /** Path to the ledger file */
  ledgerPath: string;
}

/**
 * CampaignLedger handles append-only operations on the campaign ledger.
 */
export class CampaignLedger {
  private readonly ledgerPath: string;

  constructor(opts: CampaignLedgerOptions) {
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
   * @param entry - The campaign entry to append
   * @throws ZodError if the entry doesn't match the schema
   */
  async append(entry: CampaignEntry): Promise<void> {
    // Validate the entry
    const validated = CampaignEntrySchema.parse(entry);

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
  readAll(): CampaignEntry[] {
    if (!existsSync(this.ledgerPath)) {
      return [];
    }

    const content = readFileSync(this.ledgerPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const entries: CampaignEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = CampaignEntrySchema.parse(JSON.parse(line));
        entries.push(parsed);
      } catch {
        console.warn(`[CampaignLedger] Skipping malformed line: ${line.slice(0, 100)}...`);
      }
    }

    return entries;
  }

  /**
   * Read the most recent entry.
   */
  readLast(): CampaignEntry | null {
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
   * Parse a single line into a CampaignEntry.
   */
  static parseLine(line: string): CampaignEntry | null {
    try {
      return CampaignEntrySchema.parse(JSON.parse(line));
    } catch {
      return null;
    }
  }
}
