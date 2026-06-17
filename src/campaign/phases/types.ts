import { runWithValidation, type ValidationResult } from '../../validateContract.js';

/**
 * Context object passed to phase executors, containing the necessary
 * runtime information for executing a validation trial.
 */
export interface PhaseContext {
  /** Path to the workspace directory */
  workspacePath: string;
  /** Command to execute for validation (e.g., './aesop_validate.sh') */
  validateCmd: string;
  /** Key of the primary metric (default: 'accuracy') */
  metricKey?: string;
}

/**
 * Generic interface for phase executors.
 * A phase executor is a function that takes a phase context and arguments,
 * and returns a validation result.
 */
export interface PhaseExecutor<TArgs extends Record<string, string> = Record<string, string>> {
  (_ctx: PhaseContext, _args: TArgs): Promise<ValidationResult>;
}

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
