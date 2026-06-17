/**
 * Baseline Phase
 *
 * The baseline phase establishes a performance reference by running the
 * validation script with default settings (no extra flags).
 * No agent, no workspace creation (workspace already exists in ctx.workspacePath).
 */

import type { PhaseContext } from './types.js';
import type { BaselinePlan, BaselineResult } from '../types.js';
import { PhaseExecutor } from './types.js';
import { runWithValidation, type ValidationResult } from '../../validateContract.js';

/**
 * Run a programmatic trial with the given arguments.
 *
 * Builds the full command string by appending the args map to ctx.validateCmd,
 * then delegates to runWithValidation. No agent, no workspace creation,
 * no ledger write.
 *
 * @param ctx - The phase context containing workspace and validation settings
 * @param args - Map of flag names to values to append to the validation command
 * @returns Promise resolving to validation result
 */
export async function runProgrammaticTrial(
  ctx: PhaseContext,
  args: Record<string, string>
): Promise<ValidationResult> {
  const argString = Object.entries(args)
    .map(([flag, value]) => `${flag} ${value}`)
    .join(' ');
  const cmd = `${ctx.validateCmd} ${argString}`.trim();
  return runWithValidation(ctx.workspacePath, cmd, ctx.metricKey);
}

/**
 * Baseline phase executor.
 *
 * Runs the validation script with an empty args map (default behaviour only)
 * to establish a baseline performance reference. Returns a BaselineResult with
 * the collected metrics.
 *
 * The workspace is expected to already exist at ctx.workspacePath - this
 * executor does not create or manage workspaces.
 */
export const baselinePhaseExecutor: PhaseExecutor<BaselinePlan, BaselineResult> = {
  async execute(_plan: BaselinePlan, ctx: PhaseContext): Promise<BaselineResult> {
    const start = Date.now();
    const result = await runProgrammaticTrial(ctx, {});

    if (result.success) {
      return {
        kind: 'baseline',
        status: 'completed',
        metrics: result.metrics,
        durationMs: Date.now() - start,
      };
    }

    return {
      kind: 'baseline',
      status: 'failed',
      metrics: {},
      error: result.error,
      durationMs: Date.now() - start,
    };
  },
};
