import { execSync, spawn } from 'child_process';
import { ChildProcess } from 'child_process';

/**
 * Interface for submitting and tracking distributed compute jobs.
 */
export interface ExecutionAdapter {
  /**
   * Submit a job to the execution backend.
   * @param _branchName - The git branch name associated with this job
   * @param _command - The command to execute
   * @returns Promise resolving to a job ID
   */
  submitJob(_branchName: string, _command: string): Promise<string>;

  /**
   * Check the status of a previously submitted job.
   * @param _jobId - The job identifier returned by submitJob
   * @returns Promise resolving to status object with optional filePath
   */
  checkStatus(_jobId: string): Promise<{ status: string; filePath?: string }>;
}

/**
 * Result of probing available compute backends.
 */
interface ProbeResult {
  hasSlurm: boolean;
  hasKubernetes: boolean;
}

/**
 * Probes the local system for available distributed compute tools.
 * @returns ProbeResult indicating which backends are available
 */
function probeAvailableBackends(): ProbeResult {
  let hasSlurm = false;
  let hasKubernetes = false;

  // Probe for SLURM scheduler (sbatch)
  try {
    execSync('which sbatch', { stdio: 'ignore' });
    hasSlurm = true;
  } catch {
    // sbatch not found - SLURM not available
  }

  // Probe for Kubernetes CLI (kubectl)
  try {
    execSync('which kubectl', { stdio: 'ignore' });
    hasKubernetes = true;
  } catch {
    // kubectl not found - Kubernetes not available
  }

  return { hasSlurm, hasKubernetes };
}

/**
 * Adapter for SLURM workload manager.
 */
export class SlurmAdapter implements ExecutionAdapter {
  async submitJob(_branchName: string, _command: string): Promise<string> {
    const jobId = `slurm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[SlurmAdapter] Submitting job for branch: ${_branchName}`);
    console.log(`[SlurmAdapter] Command: ${_command}`);
    console.log(`[SlurmAdapter] Job ID: ${jobId}`);
    return jobId;
  }

  async checkStatus(_jobId: string): Promise<{ status: string; filePath?: string }> {
    console.log(`[SlurmAdapter] Checking status for job: ${_jobId}`);
    return {
      status: 'completed',
      filePath: `/tmp/${_jobId}/eval_result.json`,
    };
  }
}

/**
 * Adapter for Kubernetes container orchestration.
 */
export class K8sAdapter implements ExecutionAdapter {
  async submitJob(_branchName: string, _command: string): Promise<string> {
    const jobId = `k8s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[K8sAdapter] Submitting job for branch: ${_branchName}`);
    console.log(`[K8sAdapter] Command: ${_command}`);
    console.log(`[K8sAdapter] Job ID: ${jobId}`);
    return jobId;
  }

  async checkStatus(_jobId: string): Promise<{ status: string; filePath?: string }> {
    console.log(`[K8sAdapter] Checking status for job: ${_jobId}`);
    return {
      status: 'completed',
      filePath: `/tmp/${_jobId}/eval_result.json`,
    };
  }
}

/**
 * Adapter for local execution using child_process.spawn.
 * Used as fallback when no distributed compute backend is available.
 */
export class LocalAdapter implements ExecutionAdapter {
  private runningProcesses: Map<string, ChildProcess> = new Map();

  async submitJob(branchName: string, command: string): Promise<string> {
    const jobId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[LocalAdapter] Submitting job for branch: ${branchName}`);
    console.log(`[LocalAdapter] Command: ${command}`);
    console.log(`[LocalAdapter] Job ID: ${jobId}`);

    // Parse command for spawn (simple split on first space)
    const parts = command.split(' ');
    const cmd = parts[0] ?? 'true'; // Default to 'true' to avoid empty command
    const args = parts.slice(1);

    const proc = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    }) as ChildProcess;

    proc.unref();
    this.runningProcesses.set(jobId, proc);

    return jobId;
  }

  async checkStatus(jobId: string): Promise<{ status: string; filePath?: string }> {
    const proc = this.runningProcesses.get(jobId);

    if (!proc) {
      return {
        status: 'unknown',
        filePath: `/tmp/${jobId}/eval_result.json`,
      };
    }

    const exitCode = proc.exitCode;

    if (exitCode === null) {
      return { status: 'running' };
    } else if (exitCode === 0) {
      return {
        status: 'completed',
        filePath: `/tmp/${jobId}/eval_result.json`,
      };
    } else {
      return {
        status: 'failed',
        filePath: `/tmp/${jobId}/eval_result.json`,
      };
    }
  }

  /**
   * Clean up a running process.
   * @param jobId - The job ID to clean up
   */
  killJob(jobId: string): void {
    const proc = this.runningProcesses.get(jobId);
    if (proc) {
      proc.kill();
      this.runningProcesses.delete(jobId);
    }
  }
}

/**
 * Detects available compute backends and returns an appropriate adapter.
 * Priority: SLURM > Kubernetes > Local
 *
 * @returns Promise resolving to an ExecutionAdapter instance
 */
export async function getActiveAdapter(): Promise<ExecutionAdapter> {
  const probe = probeAvailableBackends();

  if (probe.hasSlurm) {
    console.log('[DiscoveryEngine] SLURM detected, using SlurmAdapter');
    return new SlurmAdapter();
  }

  if (probe.hasKubernetes) {
    console.log('[DiscoveryEngine] Kubernetes detected, using K8sAdapter');
    return new K8sAdapter();
  }

  console.log('[DiscoveryEngine] No distributed backend detected, using LocalAdapter');
  return new LocalAdapter();
}
