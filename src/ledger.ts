/**
 * Ledger Manager
 *
 * Handles reading and appending experiment entries to the experiments.jsonl ledger.
 * The ledger is append-only—no modifications or deletions.
 *
 * This provides the source of truth for experiment history that the ratchet
 * uses to enforce monotonic improvement.
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import lockfile from 'proper-lockfile';

/**
 * Status values for ledger entries.
 */
export const LedgerEntryStatus = z.enum(['success', 'failure', 'no_improvement']);
export type LedgerEntryStatus = z.infer<typeof LedgerEntryStatus>;

/**
 * Schema for ledger entries stored in experiments.jsonl.
 *
 * Each line in the ledger represents one experiment execution with its
 * outcome, metrics, and provenance information.
 */
export const LedgerEntrySchema = z.object({
  /** ISO timestamp when the experiment was recorded */
  timestamp: z.string().datetime(),
  /** Branch name where the experiment ran */
  branch: z.string(),
  /** The main commit this branched from */
  baseCommit: z.string(),
  /** Commit hash in the ephemeral workspace when the experiment completed */
  hypothesisCommit: z.string(),
  /** Final status of the experiment */
  status: LedgerEntryStatus,
  /** Metrics recorded during the experiment */
  metrics: z.record(z.string(), z.number()),
  /** Error message if the experiment failed */
  error: z.string().optional(),
  /** Duration of the experiment in milliseconds */
  durationMs: z.number().int().nonnegative(),
});

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * Options for configuring LedgerManager behavior.
 */
export interface LedgerManagerOptions {
  /** Path to the ledger file (default: 'experiments.jsonl' in cwd) */
  ledgerPath?: string;
}

/**
 * LedgerManager handles append-only operations on the experiment ledger.
 *
 * The ledger is a JSONL file where each line is a complete LedgerEntry.
 * This class ensures atomic appends and provides utilities for reading
 * entries.
 *
 * @example
 * ```typescript
 * const ledger = new LedgerManager();
 *
 * // Append a new entry
 * await ledger.append({
 *   timestamp: new Date().toISOString(),
 *   branch: 'hypothesis/test-run',
 *   baseCommit: 'abc123',
 *   hypothesisCommit: 'def456',
 *   status: 'success',
 *   metrics: { accuracy: 0.95, loss: 0.05 },
 *   durationMs: 120000,
 * });
 *
 * // Read all entries
 * const entries = ledger.readAll();
 * const successful = ledger.readByStatus('success');
 * ```
 */
export class LedgerManager {
  private readonly ledgerPath: string;

  /**
   * Create a new LedgerManager.
   *
   * @param options - Configuration options
   */
  constructor(options: LedgerManagerOptions = {}) {
    this.ledgerPath = resolve(options.ledgerPath ?? 'experiments.jsonl');
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
   * Uses a file lock to prevent interleaving writes from concurrent processes.
   * The entry is validated before being written.
   *
   * @param entry - The ledger entry to append
   * @throws ZodError if the entry doesn't match the schema
   */
  async append(entry: LedgerEntry): Promise<void> {
    // Validate the entry
    const validated = LedgerEntrySchema.parse(entry);

    // Serialize
    const line = JSON.stringify(validated) + '\n';

    // Ensure the file exists before locking (lockfile requires the file to exist)
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
   *
   * Returns an empty array if the ledger doesn't exist.
   * Invalid lines are skipped with a warning.
   *
   * @returns Array of ledger entries in the order they were written
   */
  readAll(): LedgerEntry[] {
    if (!existsSync(this.ledgerPath)) {
      return [];
    }

    const content = readFileSync(this.ledgerPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const entries: LedgerEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = LedgerEntrySchema.parse(JSON.parse(line));
        entries.push(parsed);
      } catch {
        // Skip malformed lines with a console warning
        console.warn(`[LedgerManager] Skipping malformed line: ${line.slice(0, 100)}...`);
      }
    }

    return entries;
  }

  /**
   * Read entries filtered by status.
   *
   * @param status - The status to filter by
   * @returns Array of matching entries
   */
  readByStatus(status: LedgerEntryStatus): LedgerEntry[] {
    return this.readAll().filter((entry) => entry.status === status);
  }

  /**
   * Read the most recent entry.
   *
   * @returns The last entry or null if the ledger is empty
   */
  readLast(): LedgerEntry | null {
    const entries = this.readAll();
    return entries[entries.length - 1] ?? null;
  }

  /**
   * Get all unique branches in the ledger.
   *
   * @returns Array of branch names without duplicates
   */
  getBranches(): string[] {
    const branches = new Set<string>();
    for (const entry of this.readAll()) {
      branches.add(entry.branch);
    }
    return Array.from(branches);
  }

  /**
   * Check if the ledger file exists.
   */
  exists(): boolean {
    return existsSync(this.ledgerPath);
  }

  /**
   * Parse a single line into a LedgerEntry without validation.
   *
   * Useful for streaming processing where you need to validate
   * selectively.
   *
   * @param line - Raw JSON line
   * @returns Parsed entry or null if parsing fails
   */
  static parseLine(line: string): LedgerEntry | null {
    try {
      return LedgerEntrySchema.parse(JSON.parse(line));
    } catch {
      return null;
    }
  }
}

export default LedgerManager;
