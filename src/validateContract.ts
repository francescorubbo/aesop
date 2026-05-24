/**
 * Validate Contract
 *
 * A first-class, strictly enforced validation contract that wraps execution
 * of user-defined validation scripts with pre- and post-conditions.
 *
 * **Before running:**
 * - Deletes any existing `eval_result.json` in the workspace (eliminates stale-result bug)
 *
 * **After validation script exits zero:**
 * - Asserts `eval_result.json` exists
 * - Asserts it was written within the last 60 seconds (freshness guard)
 * - Asserts it is valid JSON
 * - Asserts it contains at least the required metric key
 * - Returns the parsed metrics
 *
 * **If any post-condition fails:**
 * - Treats the run as failed, even if the script exited 0
 * - Surfaces a clear error message
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

const execAsync = promisify(exec);

const DEFAULT_RESULT_FILE = 'eval_result.json';
const DEFAULT_METRIC_KEY = 'accuracy';
const DEFAULT_FRESHNESS_THRESHOLD_MS = 60_000; // 60 seconds

/**
 * Result of running validation with contract enforcement.
 */
export interface ValidationResult {
  /** Whether the validation passed all contract checks */
  success: boolean;
  /** Parsed metrics from the result file */
  metrics: Record<string, number>;
  /** Error message if validation failed */
  error?: string;
  /** Duration of the validation script execution in milliseconds */
  durationMs: number;
}

/**
 * Configuration for the validation contract.
 */
export interface ValidateContractConfig {
  /** Command to execute for validation (e.g., './aesop_validate.sh') */
  cmd: string;
  /** Key of the primary metric (default: 'accuracy') */
  metricKey?: string;
  /** Path to the result file (default: 'eval_result.json') */
  resultFile?: string;
  /** Maximum age of result file in milliseconds (default: 60000) */
  freshnessThresholdMs?: number;
  /** Working directory for command execution (default: workspacePath) */
  cwd?: string;
}

/**
 * Detailed errors for contract violations.
 * Values are used by consumers/tests via ValidationContractError.VALUE syntax.
 *
 * @example
 * ```typescript
 * import { ValidationContractError } from './validateContract';
 *
 * if (result.violation?.error === ValidationContractError.RESULT_FILE_NOT_FOUND) {
 *   // Handle missing result file
 * }
 * ```
 */
export enum ValidationContractError {
  RESULT_FILE_NOT_FOUND = 'RESULT_FILE_NOT_FOUND',
  RESULT_FILE_STALE = 'RESULT_FILE_STALE',
  RESULT_FILE_INVALID_JSON = 'RESULT_FILE_INVALID_JSON',
  RESULT_FILE_MISSING_METRIC = 'RESULT_FILE_MISSING_METRIC',
  VALIDATION_SCRIPT_FAILED = 'VALIDATION_SCRIPT_FAILED',
  VALIDATION_SCRIPT_ERROR = 'VALIDATION_SCRIPT_ERROR',
}

/**
 * Detailed error information for contract violations.
 */
export interface ValidationContractViolation {
  /** The type of error that occurred */
  error: ValidationContractError;
  /** Human-readable error message */
  message: string;
  /** Additional context for debugging */
  context?: Record<string, unknown>;
}

/**
 * Extended result with detailed error information.
 */
export interface ValidationResultDetailed extends ValidationResult {
  /** Detailed error information if validation failed */
  violation?: ValidationContractViolation;
}

/**
 * Check if a value is a valid finite number.
 */
function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Run a validation script with strict contract enforcement.
 *
 * This function ensures that validation results are fresh, valid, and contain
 * the required metrics by wrapping the user's validation script with pre- and
 * post-condition checks.
 *
 * **Pre-conditions (executed before the script):**
 * - Deletes any existing result file to eliminate stale results
 *
 * **Post-conditions (executed after the script exits zero):**
 * - Asserts result file exists
 * - Asserts result file was recently written (freshness guard)
 * - Asserts result file is valid JSON
 * - Asserts result file contains the required metric key
 *
 * @param workspacePath - Path to the workspace directory
 * @param validateCmd - Command to run for validation (e.g., './aesop_validate.sh')
 * @param metricKey - Required metric key in the result file (default: 'accuracy')
 * @param options - Optional configuration
 * @returns Promise resolving to validation result
 *
 * @example
 * ```typescript
 * const result = await runWithValidation(
 *   '/path/to/workspace',
 *   './aesop_validate.sh',
 *   'accuracy'
 * );
 *
 * if (result.success) {
 *   console.log(`Accuracy: ${result.metrics.accuracy}`);
 * } else {
 *   console.error(`Validation failed: ${result.error}`);
 * }
 * ```
 */
export async function runWithValidation(
  workspacePath: string,
  validateCmd: string,
  metricKey: string = DEFAULT_METRIC_KEY,
  options: Partial<Omit<ValidateContractConfig, 'cmd' | 'metricKey'>> = {}
): Promise<ValidationResult> {
  const result = await runWithValidationDetailed(workspacePath, {
    cmd: validateCmd,
    metricKey,
    ...options,
  });

  // Only include error when it's defined (exactOptionalPropertyTypes compliance)
  const returnValue: ValidationResult = {
    success: result.success,
    metrics: result.metrics,
    durationMs: result.durationMs,
  };

  if (result.error !== undefined) {
    returnValue.error = result.error;
  }

  return returnValue;
}

/**
 * Run validation with detailed error information.
 *
 * Use this when you need to programmatically determine which contract
 * violation occurred.
 *
 * @param workspacePath - Path to the workspace directory
 * @param config - Validation contract configuration
 * @returns Promise resolving to detailed validation result
 */
export async function runWithValidationDetailed(
  workspacePath: string,
  config: ValidateContractConfig
): Promise<ValidationResultDetailed> {
  const {
    cmd,
    metricKey = DEFAULT_METRIC_KEY,
    resultFile = DEFAULT_RESULT_FILE,
    freshnessThresholdMs = DEFAULT_FRESHNESS_THRESHOLD_MS,
    cwd,
  } = config;

  const workingDir = cwd ?? workspacePath;
  const resultFilePath = join(workingDir, resultFile);

  const startTime = Date.now();

  // =======================================================================
  // PRE-CONDITION: Delete any existing result file
  // This eliminates the stale-result bug by ensuring we only accept
  // results from the current validation run.
  // =======================================================================
  if (existsSync(resultFilePath)) {
    try {
      unlinkSync(resultFilePath);
    } catch (unlinkError) {
      return createDetailedError(
        startTime,
        ValidationContractError.RESULT_FILE_INVALID_JSON,
        `Failed to delete existing result file: ${String(unlinkError)}`,
        { resultFilePath }
      );
    }
  }

  // =======================================================================
  // EXECUTE: Run the validation script
  // =======================================================================
  let scriptExitedZero = false;
  let scriptError: string | undefined;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: workingDir,
      timeout: 300_000, // 5 minute timeout
    });

    scriptExitedZero = true;

    // Log any output for debugging
    if (stdout) {
      console.log(`[ValidateContract] stdout: ${stdout.toString().trim()}`);
    }
    if (stderr) {
      console.log(`[ValidateContract] stderr: ${stderr.toString().trim()}`);
    }
  } catch (error: unknown) {
    const execError = error as {
      code?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    scriptExitedZero = false;

    const stdOutStr = execError.stdout
      ? Buffer.isBuffer(execError.stdout)
        ? execError.stdout.toString('utf-8')
        : execError.stdout
      : '';
    const stdErrStr = execError.stderr
      ? Buffer.isBuffer(execError.stderr)
        ? execError.stderr.toString('utf-8')
        : execError.stderr
      : '';

    scriptError = formatScriptError(cmd, stdOutStr, stdErrStr, execError.code);

    // Even if script failed, we check post-conditions since the contract
    // requires us to surface clear error messages about the result file
  }

  const durationMs = Date.now() - startTime;

  // =======================================================================
  // POST-CONDITIONS: Validate the result file
  // These are checked regardless of whether the script exited zero,
  // as per the contract specification.
  // =======================================================================

  // POST-CONDITION 1: Result file must exist
  if (!existsSync(resultFilePath)) {
    return createDetailedError(
      startTime,
      ValidationContractError.RESULT_FILE_NOT_FOUND,
      `Validation script "${cmd}" ${
        scriptExitedZero ? 'exited successfully' : 'failed'
      }, but result file "${resultFile}" was not found at "${resultFilePath}". ` +
        'The validation script must create this file with experiment metrics.',
      { cmd, resultFile, scriptExitedZero, scriptError }
    );
  }

  // POST-CONDITION 2: Result file must be recent (freshness guard)
  let fileStats: ReturnType<typeof statSync>;
  try {
    fileStats = statSync(resultFilePath);
  } catch (err) {
    return createDetailedError(
      startTime,
      ValidationContractError.RESULT_FILE_NOT_FOUND,
      `Failed to read result file stats: ${err instanceof Error ? err.message : String(err)}`,
      { resultFilePath }
    );
  }
  const fileAgeMs = Date.now() - fileStats.mtimeMs;

  if (fileAgeMs > freshnessThresholdMs) {
    return createDetailedError(
      startTime,
      ValidationContractError.RESULT_FILE_STALE,
      `Result file "${resultFile}" exists but was last modified ${Math.round(fileAgeMs / 1000)}s ago ` +
        `(threshold: ${freshnessThresholdMs / 1000}s). This may indicate a stale result from a ` +
        'previous run. The validation script must write a fresh result file.',
      {
        cmd,
        resultFile,
        fileAgeMs,
        freshnessThresholdMs,
        lastModified: fileStats.mtimeMs,
      }
    );
  }

  // POST-CONDITION 3: Result file must be valid JSON
  let parsedResult: Record<string, unknown>;
  let rawContent: string;

  try {
    rawContent = readFileSync(resultFilePath, 'utf-8');
    parsedResult = JSON.parse(rawContent);
  } catch (parseError) {
    return createDetailedError(
      startTime,
      ValidationContractError.RESULT_FILE_INVALID_JSON,
      `Result file "${resultFile}" exists but could not be parsed as JSON: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`,
      { cmd, resultFile, parseError: String(parseError) }
    );
  }

  // POST-CONDITION 4: Result file must contain the required metric key
  if (!(metricKey in parsedResult) || !isValidNumber(parsedResult[metricKey])) {
    return createDetailedError(
      startTime,
      ValidationContractError.RESULT_FILE_MISSING_METRIC,
      `Result file "${resultFile}" is valid JSON but missing required metric "${metricKey}". ` +
        `Found keys: [${Object.keys(parsedResult).join(', ')}]`,
      {
        cmd,
        resultFile,
        metricKey,
        foundKeys: Object.keys(parsedResult),
      }
    );
  }

  // =======================================================================
  // EXTRACT: Parse metrics from result file
  // =======================================================================
  const metrics: Record<string, number> = {};

  for (const [key, value] of Object.entries(parsedResult)) {
    if (isValidNumber(value)) {
      metrics[key] = value;
    }
  }

  // =======================================================================
  // FINAL CHECK: Script must have exited zero
  // =======================================================================
  if (!scriptExitedZero) {
    return createDetailedError(
      startTime,
      ValidationContractError.VALIDATION_SCRIPT_FAILED,
      `Validation script "${cmd}" exited with error code. ` + `Script output:\n${scriptError}`,
      { cmd, scriptError, metrics }
    );
  }

  // =======================================================================
  // SUCCESS
  // =======================================================================
  return {
    success: true,
    metrics,
    durationMs,
  };
}

/**
 * Create a detailed error result.
 */
function createDetailedError(
  startTime: number,
  error: ValidationContractError,
  message: string,
  context?: Record<string, unknown>
): ValidationResultDetailed {
  const violation: ValidationContractViolation = {
    error,
    message,
  };

  // Only include context when it's defined (exactOptionalPropertyTypes compliance)
  if (context !== undefined) {
    violation.context = context;
  }

  return {
    success: false,
    metrics: {},
    error: message,
    durationMs: Date.now() - startTime,
    violation,
  };
}

/**
 * Format error output from a failed script.
 */
function formatScriptError(
  command: string,
  stdout: string,
  stderr: string,
  exitCode?: number
): string {
  const parts: string[] = [];

  parts.push(`=== SCRIPT FAILED: ${command} ===`);
  if (exitCode !== undefined) {
    parts.push(`Exit code: ${exitCode}`);
  }
  parts.push('');

  if (stdout) {
    parts.push('STDOUT:');
    parts.push(stdout);
    parts.push('');
  }

  if (stderr) {
    parts.push('STDERR:');
    parts.push(stderr);
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Validate that a result file meets contract requirements without
 * running a script.
 *
 * Useful for checking existing result files.
 *
 * @param resultFilePath - Path to the result file
 * @param metricKey - Required metric key
 * @param freshnessThresholdMs - Maximum age in milliseconds
 * @returns Validation result
 */
export function validateResultFile(
  resultFilePath: string,
  metricKey: string = DEFAULT_METRIC_KEY,
  freshnessThresholdMs: number = DEFAULT_FRESHNESS_THRESHOLD_MS
): ValidationResult {
  const startTime = Date.now();

  // Check existence
  if (!existsSync(resultFilePath)) {
    return {
      success: false,
      metrics: {},
      error: `Result file not found: ${resultFilePath}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Check freshness
  let fileStats: ReturnType<typeof statSync>;
  try {
    fileStats = statSync(resultFilePath);
  } catch (err) {
    return {
      success: false,
      metrics: {},
      error: `Failed to read result file stats: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }
  const fileAgeMs = Date.now() - fileStats.mtimeMs;

  if (fileAgeMs > freshnessThresholdMs) {
    return {
      success: false,
      metrics: {},
      error: `Result file is stale (${Math.round(fileAgeMs / 1000)}s old, threshold: ${freshnessThresholdMs / 1000}s)`,
      durationMs: Date.now() - startTime,
    };
  }

  // Parse JSON
  let parsedResult: Record<string, unknown>;
  try {
    const rawContent = readFileSync(resultFilePath, 'utf-8');
    parsedResult = JSON.parse(rawContent);
  } catch (parseError) {
    return {
      success: false,
      metrics: {},
      error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Check required metric
  if (!(metricKey in parsedResult) || !isValidNumber(parsedResult[metricKey])) {
    return {
      success: false,
      metrics: {},
      error: `Missing required metric "${metricKey}"`,
      durationMs: Date.now() - startTime,
    };
  }

  // Extract metrics
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsedResult)) {
    if (isValidNumber(value)) {
      metrics[key] = value;
    }
  }

  return {
    success: true,
    metrics,
    durationMs: Date.now() - startTime,
  };
}

export default runWithValidation;
