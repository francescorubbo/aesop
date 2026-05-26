/**
 * Tournament Ratchet
 *
 * Evaluates experimental results, queues successful branches for merging,
 * and manages the automated experiment evaluation workflow.
 */

import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Schema for evaluation result JSON files produced by training jobs.
 * Expected at /tmp/{jobId}/eval_result.json
 */
export const EvalResultSchema = z.object({
  /** Timestamp when evaluation was completed */
  timestamp: z.string().datetime(),
  /** Branch name associated with this experiment */
  branch: z.string(),
  /** Commit hash of the experiment */
  commitHash: z.string(),
  /** Primary metric value to compare against baseline */
  primaryMetric: z.number(),
  /** All metrics recorded during the experiment */
  metrics: z.record(z.string(), z.number()),
  /** Optional status field */
  status: z.enum(['pending', 'success', 'failed']).optional(),
});

export type EvalResult = z.infer<typeof EvalResultSchema>;

/**
 * Configuration for metric evaluation.
 */
export interface EvaluateConfig {
  /** Baseline metric value to compare against */
  baselineMetric: number;
  /** Key of the metric to evaluate in the result file */
  targetMetricKey: string;
  /** If true, higher values are better. If false, lower is better. */
  maximize: boolean;
}

/**
 * Custom error thrown when a merge conflict occurs during queue processing.
 */
export class MergeConflictError extends Error {
  public readonly branchName: string;

  constructor(branchName: string, message?: string) {
    super(message ?? `Merge conflict detected for branch: ${branchName}`);
    this.name = 'MergeConflictError';
    this.branchName = branchName;
  }
}

/**
 * Evaluate a single experiment result against a baseline.
 *
 * Reads the JSON result file and compares the target metric against the baseline.
 * Returns true only if the new metric is strictly better than the baseline.
 *
 * @param resultJsonPath - Path to the eval_result.json file
 * @param baselineMetric - The baseline metric value to beat
 * @param targetMetricKey - The metric key to evaluate (default: 'primaryMetric')
 * @param maximize - If true, higher values win. If false, lower values win.
 * @returns Promise resolving to true if the new metric is strictly better
 * @throws Error if the result file cannot be read or parsed
 */
export async function evaluateResult(
  resultJsonPath: string,
  baselineMetric: number,
  targetMetricKey: string = 'primaryMetric',
  maximize: boolean = true
): Promise<boolean> {
  if (!existsSync(resultJsonPath)) {
    throw new Error(`Result file not found: ${resultJsonPath}`);
  }

  const content = readFileSync(resultJsonPath, 'utf-8');
  const result = EvalResultSchema.parse(JSON.parse(content));

  const newMetric = result.metrics[targetMetricKey] ?? result.primaryMetric;

  if (maximize) {
    return newMetric > baselineMetric;
  } else {
    return newMetric < baselineMetric;
  }
}

/**
 * Queue for managing branches that have passed evaluation.
 *
 * Maintains a queue of successful experiment branches and processes
 * them in order, attempting to merge them to the target branch.
 */
export class MergeQueue {
  private readonly maximize: boolean;
  private queue: Array<{
    branchName: string;
    metricValue: number;
    resultPath: string;
  }> = [];

  constructor(maximize = true) {
    this.maximize = maximize;
  }

  /**
   * Add a branch to the merge queue.
   *
   * @param branchName - The branch to add
   * @param metricValue - The metric value that qualified this branch
   * @param resultPath - Path to the result file for reference
   */
  add(branchName: string, metricValue: number, resultPath: string): void {
    this.queue.push({ branchName, metricValue, resultPath });
    // Sort by metric value (highest first for maximize, lowest first otherwise)
    this.queue.sort(
      (a, b) =>
        this.maximize
          ? b.metricValue - a.metricValue // highest first
          : a.metricValue - b.metricValue // lowest first
    );
  }

  /**
   * Get the next branch to merge without removing it.
   */
  peek(): string | null {
    return this.queue[0]?.branchName ?? null;
  }

  /**
   * Remove and return the next branch from the queue.
   */
  shift(): string | null {
    return this.queue.shift()?.branchName ?? null;
  }

  /**
   * Get the current size of the queue.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue is empty.
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Get all queued branches with their metric values.
   */
  getEntries(): Array<{ branchName: string; metricValue: number; resultPath: string }> {
    return [...this.queue];
  }

  /**
   * Clear all entries from the queue.
   */
  clear(): void {
    this.queue = [];
  }
}

/**
 * Interface for state manager operations needed by processQueue.
 */
export interface StateManagerForMerge {
  /**
   * Merge a source branch into the current branch.
   * @returns true if merge succeeded, false if conflict occurred
   */
  mergeBranch(_sourceBranch: string, _targetBranch: string): Promise<boolean>;
}

/**
 * Process the merge queue, attempting to merge branches in order.
 *
 * For each branch in the queue (highest metric first):
 * 1. Attempts to merge into the target branch
 * 2. If successful, removes the branch from the queue and continues
 * 3. If a conflict occurs, aborts and throws MergeConflictError
 *
 * @param queue - The MergeQueue to process
 * @param stateManager - The state manager for merge operations
 * @param targetBranch - The branch to merge into (e.g., 'main')
 * @throws MergeConflictError if any merge conflict occurs
 */
export async function processQueue(
  queue: MergeQueue,
  stateManager: StateManagerForMerge,
  targetBranch: string = 'main'
): Promise<{ merged: string[]; failed: string[] }> {
  const merged: string[] = [];
  const failed: string[] = [];

  while (!queue.isEmpty) {
    const branchName = queue.peek();

    if (!branchName) {
      break;
    }

    const success = await stateManager.mergeBranch(branchName, targetBranch);

    if (success) {
      queue.shift();
      merged.push(branchName);
    } else {
      // Merge conflict occurred - throw error with branch info
      throw new MergeConflictError(
        branchName,
        `Merge conflict detected for branch "${branchName}" when merging to "${targetBranch}". ` +
          `Queue processing aborted.`
      );
    }
  }

  return { merged, failed };
}

/**
 * Read and parse an eval result file.
 *
 * @param resultJsonPath - Path to the eval_result.json file
 * @returns Parsed EvalResult or null if file doesn't exist
 */
export function readEvalResult(resultJsonPath: string): EvalResult | null {
  if (!existsSync(resultJsonPath)) {
    return null;
  }

  try {
    const content = readFileSync(resultJsonPath, 'utf-8');
    return EvalResultSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Create a default evaluation configuration.
 *
 * @param baselineMetric - The baseline to compare against
 * @param targetMetricKey - The metric to evaluate
 * @param maximize - Whether higher is better
 */
export function createDefaultEvalConfig(
  baselineMetric: number,
  targetMetricKey: string = 'primaryMetric',
  maximize: boolean = true
): EvaluateConfig {
  return {
    baselineMetric,
    targetMetricKey,
    maximize,
  };
}

export default evaluateResult;
