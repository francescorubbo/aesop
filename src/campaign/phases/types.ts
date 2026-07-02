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
  /** Whether the primary metric should be maximized */
  maximize?: boolean;
}

/**
 * Generic interface for phase executors.
 *
 * A phase executor takes a phase plan and context, executes the phase,
 * and returns a phase-specific result.
 *
 * @typeParam TPlan - The plan type for this phase (e.g., BaselinePlan)
 * @typeParam TResult - The result type for this phase (e.g., BaselineResult)
 */
export interface PhaseExecutor<TPlan, TResult> {
  execute(_plan: TPlan, _ctx: PhaseContext): Promise<TResult>;
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
export { runProgrammaticTrial } from './baselinePhase.js';
