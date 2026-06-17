/**
 * Long Run Phase
 *
 * The long run phase executes the best configuration discovered during the
 * search phase with a larger epoch count. This validates that the found
 * configuration performs well at scale.
 */

import type { PhaseContext } from './types.js';
import type { LongRunPlan, LongRunResult } from '../types.js';
import { PhaseExecutor } from './types.js';
import { runProgrammaticTrial } from './baselinePhase.js';

/**
 * Long run phase executor.
 *
 * Takes a LongRunPlan containing best args from the search phase and an
 * epochs count, then runs a programmatic trial with those settings.
 * Returns a LongRunResult with the final metrics.
 *
 * @example
 * ```typescript
 * const plan: LongRunPlan = {
 *   kind: 'long_run',
 *   bestArgs: { '--lr': '0.001', '--batch-size': '32' },
 *   epochs: 100,
 * };
 * const result = await longRunPhaseExecutor.execute(plan, ctx);
 * ```
 */
export const longRunPhaseExecutor: PhaseExecutor<LongRunPlan, LongRunResult> = {
  async execute(plan: LongRunPlan, ctx: PhaseContext): Promise<LongRunResult> {
    const start = Date.now();
    const args = { ...plan.bestArgs, '--epochs': String(plan.epochs) };
    const result = await runProgrammaticTrial(ctx, args);

    if (result.success) {
      return {
        kind: 'long_run',
        status: 'completed',
        metrics: result.metrics,
        durationMs: Date.now() - start,
      };
    }

    return {
      kind: 'long_run',
      status: 'failed',
      metrics: {},
      error: result.error,
      durationMs: Date.now() - start,
    };
  },
};

// Re-export for consumers who import from this module
export { runProgrammaticTrial } from './baselinePhase.js';
