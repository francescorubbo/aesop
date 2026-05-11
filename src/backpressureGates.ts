/**
 * Static Backpressure Gates
 *
 * Language-agnostic validation layer that executes user-defined checks
 * before wasting cluster resources. Users provide their own validation
 * script (e.g., `./aesop_validate.sh`, `pytest .`, `cargo test`).
 *
 * This keeps the harness independent of any specific language or environment.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface StaticCheckResult {
  success: boolean;
  errorOutput?: string;
}

/**
 * Run user-defined static checks on a project.
 *
 * Executes a user-provided validation command in the target directory.
 * The user defines what checks to run in their validation script
 * (e.g., `./aesop_validate.sh`, `pytest .`, `cargo test`).
 *
 * @param directoryPath - Path to the project directory
 * @param checkCommand - The validation command to run (default: './aesop_validate.sh')
 * @returns Promise resolving to check result with errorOutput if check failed
 */
export async function runStaticChecks(
  directoryPath: string,
  checkCommand: string = './aesop_validate.sh'
): Promise<StaticCheckResult> {
  console.log(`[BackpressureGates] Running: ${checkCommand}`);

  try {
    const { stderr } = await execAsync(checkCommand, {
      cwd: directoryPath,
      timeout: 300000, // 5 minute timeout
    });

    const stdErrStr = Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : (stderr ?? '');

    // Even on success, log any stderr (warnings, etc.)
    if (stdErrStr) {
      console.log(`[BackpressureGates] stderr: ${stdErrStr}`);
    }

    console.log('[BackpressureGates] Checks passed.');
    return { success: true };
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number;
    };
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

    const errorOutput = formatErrorOutput(checkCommand, stdOutStr, stdErrStr);
    console.error(`[BackpressureGates] Checks failed (exit code: ${execError.code ?? 'unknown'})`);

    return {
      success: false,
      errorOutput,
    };
  }
}

/**
 * Format error output for agent readability.
 *
 * @param command - The command that failed
 * @param stdout - Standard output from the command
 * @param stderr - Standard error from the command
 * @returns Formatted error string
 */
function formatErrorOutput(command: string, stdout: string, stderr: string): string {
  const parts: string[] = [];

  parts.push(`=== VALIDATION FAILED: ${command} ===`);
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

export default runStaticChecks;
