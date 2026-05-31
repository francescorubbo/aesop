/**
 * Ratchet
 *
 * Enforces improvement by comparing new experiment results against
 * a provided baseline value (typically from the run's own initial measurement).
 *
 * The ratchet acts as a gate: an experiment is only considered a true
 * "success" if it strictly improves on its own baseline. Experiments that
 * validate but don't improve are marked as "no_improvement".
 *
 * A separate function (`getGlobalBest`) handles querying the all-time best
 * for the globalBest flag on ledger entries.
 *
 * This design supports ablation studies where each run's relevant comparison
 * is its own controlled baseline, not a global best from unrelated experiments.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { LedgerManager } from './ledger.js';

/**
 * Result of checking the ratchet against a new value.
 */
export interface RatchetResult {
  /** Whether the current value strictly improves on the baseline */
  improved: boolean;
  /** The value that was checked */
  current: number;
  /** The baseline value we compared against */
  baseline: number;
}

/**
 * Options for configuring ratchet behavior.
 */
export interface RatchetOptions {
  /** Whether to maximize (true) or minimize (false) the metric. Default: true */
  maximize?: boolean;
}

/**
 * Check if a new metric value improves upon the run's baseline.
 *
 * This replaces the previous global-best comparison with a local baseline
 * comparison. For ablation studies, each run's baseline (measured at the
 * start of the run) is the appropriate comparison point, not the global best
 * from unrelated experiments.
 *
 * @param baselineValue - The baseline metric value to compare against
 * @param currentValue - The new value to check for improvement
 * @param options - Optional configuration (maximize)
 * @returns RatchetResult with improvement status
 *
 * @example
 * ```typescript
 * // Check if 0.96 accuracy beats the run's baseline of 0.90
 * const result = checkRatchet(0.90, 0.96);
 *
 * if (result.improved) {
 *   console.log(`Improved from ${result.baseline} to ${result.current}`);
 * } else {
 *   console.log(`No improvement over baseline ${result.baseline}`);
 * }
 * ```
 */
export function checkRatchet(
  baselineValue: number,
  currentValue: number,
  options: RatchetOptions = {}
): RatchetResult {
  const { maximize = true } = options;

  const improved = maximize ? currentValue > baselineValue : currentValue < baselineValue;

  return {
    improved,
    current: currentValue,
    baseline: baselineValue,
  };
}

/**
 * Get the best value for a metric from successful ledger entries.
 *
 * A convenience function that returns the current best value across all
 * successful experiments. Used to determine the globalBest flag for ledger
 * entries.
 *
 * @param ledgerPath - Path to the experiments.jsonl ledger
 * @param metricKey - The metric to find the best value for
 * @param options - Optional configuration (maximize)
 * @returns The best value, or null if no successful experiments exist
 *
 * @example
 * ```typescript
 * const best = getGlobalBest('experiments.jsonl', 'accuracy');
 * if (best !== null) {
 *   console.log(`Current best accuracy: ${best.value}`);
 *   console.log(`Achieved by: ${best.branch}`);
 * }
 * ```
 */
export function getGlobalBest(
  ledgerPath: string,
  metricKey: string,
  options: RatchetOptions = {}
): { value: number; branch: string; commit: string } | null {
  const { maximize = true } = options;
  const resolvedPath = resolve(ledgerPath);

  if (!existsSync(resolvedPath)) return null;

  const ledger = new LedgerManager({ ledgerPath: resolvedPath });
  const successes = ledger.readByStatus('success');

  let best: { value: number; branch: string; commit: string } | null = null;

  for (const entry of successes) {
    const value = entry.metrics[metricKey];
    if (value === undefined) continue;

    if (best === null || (maximize && value > best.value) || (!maximize && value < best.value)) {
      best = { value, branch: entry.branch, commit: entry.hypothesisCommit };
    }
  }

  return best;
}

/**
 * Determine whether a value is a new global best.
 *
 * @param ledgerPath - Path to the experiments.jsonl ledger
 * @param metricKey - The metric to check
 * @param value - The value to compare against global best
 * @param options - Optional configuration (maximize)
 * @returns true if this value is a new global best
 *
 * @example
 * ```typescript
 * const isGlobalBest = isNewGlobalBest('experiments.jsonl', 'accuracy', 0.97);
 * // Returns true if 0.97 beats all prior successful entries
 * ```
 */
export function isNewGlobalBest(
  ledgerPath: string,
  metricKey: string,
  value: number,
  options: RatchetOptions = {}
): boolean {
  const currentBest = getGlobalBest(ledgerPath, metricKey, options);

  if (currentBest === null) {
    // No prior successful entries, this is the new best
    return true;
  }

  const { maximize = true } = options;
  return maximize ? value > currentBest.value : value < currentBest.value;
}

/**
 * Determine the appropriate status for an experiment result.
 *
 * Given the ratchet check result (comparing against the run's baseline),
 * returns the appropriate status:
 * - "success" if the experiment improved on its baseline
 * - "no_improvement" if validation passed but no improvement was made
 * - "failure" if the experiment encountered an error (passed separately)
 *
 * @param ratchetResult - Result from checkRatchet
 * @param validationPassed - Whether the experiment validation passed
 * @returns The appropriate ledger status
 *
 * @example
 * ```typescript
 * const ratchetResult = checkRatchet(baselineValue, newAccuracy);
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
