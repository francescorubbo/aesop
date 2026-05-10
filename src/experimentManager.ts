/**
 * Experiment Manager
 *
 * Manages experiment lifecycle with Git-based branching and experiment logging.
 */

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import simpleGit, { SimpleGit } from 'simple-git';

export interface ExperimentRecord {
  timestamp: string;
  branch: string;
  commitHash: string;
  status: 'pending' | 'success' | 'failed';
  metrics: Record<string, number>;
}

export interface IExperimentManager {
  createBranch(_baseBranch: string, _hypothesis: string): Promise<string>;
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
 */
export class ExperimentManager implements IExperimentManager {
  private git: SimpleGit;
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  /**
   * Create a new experiment branch from base branch.
   */
  async createBranch(baseBranch: string, hypothesis: string): Promise<string> {
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

    const ledgerPath = `${this.repoPath}/${LEDGER_FILENAME}`;
    const line = JSON.stringify(record) + '\n';

    appendFileSync(ledgerPath, line);
  }

  /**
   * Merge an experiment branch back to target.
   */
  async mergeBranch(sourceBranch: string, targetBranch: string): Promise<boolean> {
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
    const ledgerPath = `${this.repoPath}/${LEDGER_FILENAME}`;

    if (!existsSync(ledgerPath)) {
      return [];
    }

    const content = readFileSync(ledgerPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    return lines.map((line) => JSON.parse(line) as ExperimentRecord);
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
}

export default ExperimentManager;
