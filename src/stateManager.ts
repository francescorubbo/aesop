import { appendFileSync } from 'node:fs';
import simpleGit, { SimpleGit } from 'simple-git';

export interface ExperimentRecord {
  timestamp: string;
  branch: string;
  commitHash: string;
  status: 'pending' | 'success' | 'failed';
  metrics: Record<string, number>;
}

export interface HypothesisStateManager {
  createHypothesisBranch(baseBranch: string, hypothesisName: string): Promise<string>;
  logExperiment(
    hypothesisName: string,
    status: 'pending' | 'success' | 'failed',
    metrics: Record<string, number>
  ): Promise<void>;
  mergeSuccessfulHypothesis(
    targetBranch: string,
    hypothesisBranch: string
  ): Promise<boolean>;
}

const LEDGER_FILENAME = 'autoresearch.jsonl';

export class HypothesisStateManager implements HypothesisStateManager {
  private git: SimpleGit;
  private repoPath: string;

  constructor(repoPath: string = process.cwd()) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  async createHypothesisBranch(baseBranch: string, hypothesisName: string): Promise<string> {
    await this.git.fetch('origin');
    await this.git.checkout(['--force', '-b', baseBranch, `origin/${baseBranch}`]);

    const branchName = `hypothesis/${hypothesisName}`;
    await this.git.checkout(['-b', branchName]);

    return branchName;
  }

  async logExperiment(
    hypothesisName: string,
    status: 'pending' | 'success' | 'failed',
    metrics: Record<string, number>
  ): Promise<void> {
    const statusResult = await this.git.status();
    const currentBranch = statusResult.current ?? hypothesisName;

    const commitHash = statusResult.hash ?? 'unknown';

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

  async mergeSuccessfulHypothesis(
    targetBranch: string,
    hypothesisBranch: string
  ): Promise<boolean> {
    await this.git.checkout(targetBranch);

    try {
      const mergeResult = await this.git.merge([hypothesisBranch]);
      return mergeResult.result === 'success';
    } catch (error: unknown) {
      const err = error as { message?: string };
      if (err.message?.includes('CONFLICT') || err.message?.includes('conflict')) {
        await this.git.merge(['--abort']);
        await this.git.reset(['--hard', `origin/${targetBranch}`]);
        return false;
      }
      throw error;
    }
  }
}

export default HypothesisStateManager;