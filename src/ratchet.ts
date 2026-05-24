/**
 * Ratchet
 *
 * Enforces monotonic improvement by comparing new experiment results against
 * the best historical values recorded in the ledger.
 *
 * The ratchet acts as a gate: an experiment is only considered a true
 * "success" if it strictly improves on the best known value for the
 * target metric. Experiments that validate but don't improve are marked
 * as "no_improvement".
 *
 * This prevents the experiment history from degrading over time and ensures
 * each successful experiment represents genuine progress.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LedgerManager, type LedgerEntry } from './ledger.js';

/**
 * Result of checking the ratchet against a new value.
 */
export interface RatchetResult {
  /** Whether the current value strictly improves on the best */
  improved: boolean;
  /** The value that was checked */
  current: number;
  /** The best value found in the ledger (null if no successful experiments) */
  best: number;
  /** The branch that achieved the best value */
  bestBranch: string;
  /** The commit hash that achieved the best value */
  bestCommit: string;
}

/**
 * Options for configuring ratchet behavior.
 */
export interface RatchetOptions {
  /** Whether to maximize (true) or minimize (false) the metric. Default: true */
  maximize?: boolean;
  /** Custom ledger path. Defaults to 'experiments.jsonl' in cwd */
  ledgerPath?: string;
}

/**
 * Check if a new metric value improves upon the best recorded value.
 *
 * Reads all successful experiments from the ledger, finds the maximum
 * (or minimum if minimize=true) value for the given metric key, and
 * returns whether the current value beats it.
 *
 * If no successful experiments exist for the metric, the current value
 * is considered an improvement by default.
 *
 * @param ledgerPath - Path to the experiments.jsonl ledger
 * @param metricKey - The metric to compare (e.g., 'accuracy', 'loss')
 * @param currentValue - The new value to compare against the best
 * @param options - Optional configuration (maximize, custom ledger path)
 * @returns RatchetResult with improvement status and details
 *
 * @example
 * ```typescript
 * // Check if 0.96 accuracy beats the best known accuracy
 * const result = checkRatchet('experiments.jsonl', 'accuracy', 0.96);
 *
 * if (result.improved) {
 *   console.log(`New best! ${result.current} > ${result.best}`);
 *   console.log(`Previous best was from branch: ${result.bestBranch}`);
 * } else {
 *   console.log(`No improvement. Best: ${result.best}`);
 *   // Record as 'no_improvement' status instead of 'success'
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Check for metric minimization (e.g., loss)
 * const result = checkRatchet('experiments.jsonl', 'loss', 0.02, {
 *   maximize: false,
 * });
 * ```
 */
export function checkRatchet(
  ledgerPath: string,
  metricKey: string,
  currentValue: number,
  options: RatchetOptions = {}
): RatchetResult {
  const { maximize = true } = options;
  const resolvedPath = resolve(ledgerPath);

  // If ledger doesn't exist, current value is automatically an improvement
  if (!existsSync(resolvedPath)) {
    return {
      improved: true,
      current: currentValue,
      best: currentValue,
      bestBranch: '',
      bestCommit: '',
    };
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  let bestValue: number | null = null;
  let bestBranch = '';
  let bestCommit = '';

  // Iterate through all successful experiments
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LedgerEntry;

      // Only consider successful experiments
      if (entry.status !== 'success') {
        continue;
      }

      const metricValue = entry.metrics[metricKey];

      // Skip entries without this metric
      if (metricValue === undefined) {
        continue;
      }

      // Update best if this is better
      if (bestValue === null) {
        bestValue = metricValue;
        bestBranch = entry.branch;
        bestCommit = entry.hypothesisCommit;
      } else if (maximize && metricValue > bestValue) {
        bestValue = metricValue;
        bestBranch = entry.branch;
        bestCommit = entry.hypothesisCommit;
      } else if (!maximize && metricValue < bestValue) {
        bestValue = metricValue;
        bestBranch = entry.branch;
        bestCommit = entry.hypothesisCommit;
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // If no successful experiments found, current value is an improvement
  if (bestValue === null) {
    return {
      improved: true,
      current: currentValue,
      best: currentValue,
      bestBranch: '',
      bestCommit: '',
    };
  }

  // Check if current value is strictly better
  const improved = maximize ? currentValue > bestValue : currentValue < bestValue;

  return {
    improved,
    current: currentValue,
    best: bestValue,
    bestBranch,
    bestCommit,
  };
}

/**
 * Get the best value for a metric from the ledger.
 *
 * A convenience function that returns the current best without
 * comparing against a new value.
 *
 * @param ledgerPath - Path to the experiments.jsonl ledger
 * @param metricKey - The metric to find the best value for
 * @param options - Optional configuration (maximize, custom ledger path)
 * @returns The best value, or null if no successful experiments exist
 *
 * @example
 * ```typescript
 * const best = getBestMetric('experiments.jsonl', 'accuracy');
 * if (best !== null) {
 *   console.log(`Current best accuracy: ${best.value}`);
 *   console.log(`Achieved by: ${best.branch}`);
 * }
 * ```
 */
export function getBestMetric(
  ledgerPath: string,
  metricKey: string,
  options: RatchetOptions = {}
): { value: number; branch: string; commit: string } | null {
  const result = checkRatchet(ledgerPath, metricKey, 0, options);

  if (result.bestBranch === '' && result.bestCommit === '') {
    return null;
  }

  return {
    value: result.best,
    branch: result.bestBranch,
    commit: result.bestCommit,
  };
}

/**
 * Create a ratchet checker using a LedgerManager instance.
 *
 * Useful when you already have a LedgerManager and want to use
 * ratchet functionality without re-specifying paths.
 *
 * @param ledger - The LedgerManager instance
 * @param options - Optional configuration (maximize)
 * @returns A configured checkRatchet function bound to the ledger
 *
 * @example
 * ```typescript
 * const ledger = new LedgerManager();
 * const checkRatchetForLedger = createRatchetChecker(ledger, { maximize: true });
 *
 * const result = checkRatchetForLedger('accuracy', 0.97);
 * ```
 */
export function createRatchetChecker(
  ledger: LedgerManager,
  options: Pick<RatchetOptions, 'maximize'> = {}
): (_metric: string, _value: number) => RatchetResult {
  const ledgerPath = ledger.getPath();
  const { maximize = true } = options;

  return (metric: string, value: number) => {
    return checkRatchet(ledgerPath, metric, value, { maximize });
  };
}

/**
 * Determine the appropriate status for an experiment result.
 *
 * Given the ratchet check result, returns the appropriate status:
 * - "success" if the experiment improved on the best
 * - "no_improvement" if validation passed but no improvement was made
 * - "failure" if the experiment encountered an error (passed separately)
 *
 * @param ratchetResult - Result from checkRatchet
 * @param validationPassed - Whether the experiment validation passed
 * @returns The appropriate ledger status
 *
 * @example
 * ```typescript
 * const ratchetResult = checkRatchet(ledgerPath, 'accuracy', newAccuracy);
 * const status = determineStatus(ratchetResult, validationPassed = true);
 *
 * ledger.append({
 *   // ... entry fields
 *   status,
 * });
 * ```
 */
export function determineStatus(
  ratchetResult: RatchetResult,
  validationPassed: boolean
): 'success' | 'no_improvement' | 'failure' {
  if (!validationPassed) {
    return 'failure';
  }
  return ratchetResult.improved ? 'success' : 'no_improvement';
}

export default checkRatchet;
