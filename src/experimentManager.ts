/**
 * Experiment Manager
 *
 * Manages experiment lifecycle with Git-based branching and experiment logging.
 * Supports ephemeral workspaces for complete isolation of hypothesis experiments.
 */

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import simpleGit, { SimpleGit } from 'simple-git';
import { WorkspaceManager, createWorkspace, type WorkspaceInfo } from './workspaceManager.js';

export interface ExperimentRecord {
  timestamp: string;
  branch: string;
  commitHash: string;
  status: 'pending' | 'success' | 'failed';
  metrics: Record<string, number>;
}

export interface CreateBranchOptions {
  /** Whether to use ephemeral workspace (default: false) */
  ephemeral?: boolean;
  /** Workspace root for ephemeral mode */
  workspaceRoot?: string;
}

export interface IExperimentManager {
  createBranch(
    _baseBranch: string,
    _hypothesis: string,
    _options?: CreateBranchOptions
  ): Promise<string>;
  logExperiment(
    _branch: string,
    _status: 'pending' | 'success' | 'failed',
    _metrics: Record<string, number>
  ): Promise<void>;
  mergeBranch(_sourceBranch: string, _targetBranch: string): Promise<boolean>;
  getCurrentBranch(): Promise<string | null>;
  getExperimentLog(): ExperimentRecord[];
}

const LEDGER_FILENAME = 'experiments.jsonl';

/**
 * Manages distributed ML experiments with Git-based versioning.
 *
 * When ephemeral mode is enabled, all operations happen within isolated
 * workspace directories, keeping the user's main repository untouched.
 */
export class ExperimentManager implements IExperimentManager {
  private git: SimpleGit;
  private hostRepoPath: string;
  private repoPath: string;
  private workspaceManager: WorkspaceManager | null = null;
  private currentWorkspacePath: string | null = null;
  private isEphemeral: boolean = false;

  constructor(repoPath: string = process.cwd(), options: CreateBranchOptions = {}) {
    this.hostRepoPath = resolve(repoPath);
    this.repoPath = this.hostRepoPath;
    this.git = simpleGit(this.repoPath);

    if (options.ephemeral && options.workspaceRoot) {
      // Workspace manager will be initialized lazily
      this.isEphemeral = true;
    }
  }

  /**
   * Initialize ephemeral workspace mode.
   * Call this before creating branches if using ephemeral workspaces.
   *
   * @param targetRepoPath - Path to the user's actual code
   * @param workspaceRoot - Root directory for workspaces
   * @returns Promise resolving to WorkspaceInfo
   */
  async initEphemeralWorkspace(
    targetRepoPath: string,
    workspaceRoot: string = '.aesop_workspaces'
  ): Promise<WorkspaceInfo> {
    this.workspaceManager = await createWorkspace({
      targetRepoPath,
      workspaceRoot,
    });

    this.currentWorkspacePath = this.workspaceManager.getBasePath();
    this.repoPath = this.currentWorkspacePath;
    this.git = simpleGit(this.repoPath);

    return this.workspaceManager.getWorkspaceInfo();
  }

  /**
   * Get the current workspace path (null in non-ephemeral mode).
   */
  getCurrentWorkspacePath(): string | null {
    return this.currentWorkspacePath;
  }

  /**
   * Get the workspace manager instance (null in non-ephemeral mode).
   */
  getWorkspaceManager(): WorkspaceManager | null {
    return this.workspaceManager;
  }

  /**
   * Create a new experiment branch.
   *
   * In ephemeral mode, this creates a complete isolated clone for the hypothesis.
   * In normal mode, this creates a new branch in the current repository.
   */
  async createBranch(
    baseBranch: string,
    hypothesis: string,
    options: CreateBranchOptions = {}
  ): Promise<string> {
    if (options.ephemeral || this.isEphemeral) {
      return this.createEphemeralBranch(baseBranch, hypothesis);
    }
    return this.createLocalBranch(baseBranch, hypothesis);
  }

  /**
   * Create a branch in an ephemeral workspace.
   */
  private async createEphemeralBranch(baseBranch: string, hypothesis: string): Promise<string> {
    if (!this.workspaceManager) {
      throw new Error('Ephemeral workspace not initialized. Call initEphemeralWorkspace first.');
    }

    const workspaceInfo = await this.workspaceManager.createHypothesisWorkspace(hypothesis, {
      baseBranch,
    });

    this.currentWorkspacePath = workspaceInfo.hypothesisPath ?? null;

    // Return the workspace path for the agent to use
    const sanitizedName = this.sanitizeHypothesisName(hypothesis);
    return workspaceInfo.hypothesisPath ?? join(this.workspaceRoot(), `hyp_${sanitizedName}`);
  }

  /**
   * Create a branch locally in the repository.
   */
  private async createLocalBranch(baseBranch: string, hypothesis: string): Promise<string> {
    const branchName = this.formatBranchName(hypothesis);

    // Fetch and checkout base branch
    await this.git.fetch('origin');
    await this.git
      .checkout(['--force', '-b', baseBranch, `origin/${baseBranch}`])
      .catch(async () => {
        // Branch might exist locally
        await this.git.checkout([baseBranch]);
      });

    // Create experiment branch
    await this.git.checkout(['-b', branchName]);

    return branchName;
  }

  /**
   * Log an experiment result to the ledger.
   */
  async logExperiment(
    branch: string,
    status: 'pending' | 'success' | 'failed',
    metrics: Record<string, number>
  ): Promise<void> {
    const statusResult = await this.git.status();
    const currentBranch = statusResult.current ?? branch;

    const commitHash = (await this.git.raw(['rev-parse', 'HEAD'])).trim();

    const record: ExperimentRecord = {
      timestamp: new Date().toISOString(),
      branch: currentBranch,
      commitHash,
      status,
      metrics,
    };

    const ledgerPath = join(this.hostRepoPath, LEDGER_FILENAME);
    const line = JSON.stringify(record) + '\n';

    appendFileSync(ledgerPath, line);
  }

  /**
   * Merge an experiment branch back to target.
   *
   * In ephemeral mode, merges into the base workspace first,
   * then optionally pushes to the original repository.
   */
  async mergeBranch(sourceBranch: string, targetBranch: string): Promise<boolean> {
    if (this.isEphemeral && this.workspaceManager) {
      return this.workspaceManager.mergeIntoBase(sourceBranch, targetBranch);
    }

    // Switch to target branch
    await this.git.checkout(targetBranch);

    try {
      const mergeResult = await this.git.merge([sourceBranch]);
      return mergeResult.result === 'success';
    } catch (error: unknown) {
      const err = error as { message?: string };
      if (err.message?.includes('CONFLICT') || err.message?.includes('conflict')) {
        // Abort merge and reset on conflict
        await this.git.merge(['--abort']);
        await this.git.reset(['--hard', `origin/${targetBranch}`]);
        return false;
      }
      throw error;
    }
  }

  /**
   * Get current branch name.
   */
  async getCurrentBranch(): Promise<string | null> {
    const status = await this.git.status();
    return status.current;
  }

  /**
   * Get all experiment records from the ledger.
   */
  getExperimentLog(): ExperimentRecord[] {
    const ledgerPath = join(this.hostRepoPath, LEDGER_FILENAME);

    if (!existsSync(ledgerPath)) {
      return [];
    }

    const content = readFileSync(ledgerPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    return lines.map((line) => JSON.parse(line) as ExperimentRecord);
  }

  /**
   * Create a new ephemeral workspace for a hypothesis.
   *
   * This is the primary method for creating isolated experiment environments.
   *
   * @param hypothesisName - Name/description of the hypothesis
   * @param baseBranch - Base branch to clone from (default: main)
   * @returns Promise resolving to workspace path
   */
  async createHypothesisWorkspace(hypothesisName: string, baseBranch = 'main'): Promise<string> {
    if (!this.workspaceManager) {
      throw new Error('Ephemeral workspace not initialized. Call initEphemeralWorkspace first.');
    }

    const workspaceInfo = await this.workspaceManager.createHypothesisWorkspace(hypothesisName, {
      baseBranch,
    });

    this.currentWorkspacePath = workspaceInfo.hypothesisPath ?? null;

    return (
      workspaceInfo.hypothesisPath ??
      this.workspaceRoot() + `/hyp_${this.sanitizeHypothesisName(hypothesisName)}`
    );
  }

  /**
   * Get the workspace root path.
   */
  private workspaceRoot(): string {
    return this.workspaceManager?.getWorkspaceRoot() ?? this.repoPath;
  }

  /**
   * Format branch name from hypothesis.
   */
  private formatBranchName(hypothesis: string): string {
    const sanitized = hypothesis
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    return `hypothesis/${timestamp}-${sanitized}`;
  }

  /**
   * Sanitize hypothesis name for use in paths and branch names.
   */
  private sanitizeHypothesisName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
  }
}

export default ExperimentManager;
