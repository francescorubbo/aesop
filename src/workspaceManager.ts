/**
 * Workspace Manager
 *
 * Manages ephemeral workspaces for hypothesis isolation. Each hypothesis
 * gets its own isolated clone of the target repository, ensuring:
 * - Zero pollution of the user's main working directory
 * - Massive parallelism (multiple hypotheses can run simultaneously)
 * - Safety (experiments can't corrupt the user's actual code)
 */

import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import simpleGit, { SimpleGit } from 'simple-git';

export interface WorkspaceInfo {
  /** Unique session identifier */
  sessionId: string;
  /** Root directory for all workspaces in this session */
  workspaceRoot: string;
  /** Path to the base clone (clean copy of target repo) */
  basePath: string;
  /** Path to this specific hypothesis workspace */
  hypothesisPath?: string;
  /** Name of the hypothesis */
  hypothesisName?: string;
  /** When the workspace was created */
  createdAt: Date;
}

export interface CreateWorkspaceOptions {
  /** Path to the target repository to sandbox */
  targetRepoPath: string;
  /** Root directory for workspaces (default: .aesop_workspaces/) */
  workspaceRoot?: string;
  /** Whether to show progress during clone operations */
  showProgress?: boolean;
}

export interface CreateHypothesisOptions {
  /** Name for the hypothesis */
  hypothesisName: string;
  /** Branch name to checkout (default: auto-generated) */
  branchName?: string | undefined;
  /** Base branch to use (default: main) */
  baseBranch?: string | undefined;
}

/**
 * Manages ephemeral workspaces for isolated experiment execution.
 *
 * Directory structure:
 * .aesop_workspaces/
 * ├── session_<timestamp>/
 * │   ├── base/              # Clean clone of target repo
 * │   └── hyp_<name>/        # Isolated clone for hypothesis
 * └── ...
 */
export class WorkspaceManager {
  private git: SimpleGit;
  private workspaceRoot: string;
  private basePath: string;
  private sessionId: string;
  private createdAt: Date;

  constructor(workspaceRoot: string, _targetRepoPath: string, showProgress = false) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.sessionId = `session_${Date.now()}`;
    this.createdAt = new Date();
    this.git = simpleGit();

    if (showProgress) {
      this.git.env({ GIT_PROGRESS: '1' });
    }

    // Ensure workspace root exists
    mkdirSync(this.workspaceRoot, { recursive: true });

    this.basePath = join(this.workspaceRoot, this.sessionId, 'base');
  }

  /**
   * Get the session ID for this workspace.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the workspace root directory.
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Get the base path (clean clone of target repo).
   */
  getBasePath(): string {
    return this.basePath;
  }

  /**
   * Get info about the current workspace.
   */
  getWorkspaceInfo(): WorkspaceInfo {
    return {
      sessionId: this.sessionId,
      workspaceRoot: join(this.workspaceRoot, this.sessionId),
      basePath: this.basePath,
      createdAt: this.createdAt,
    };
  }

  /**
   * Initialize the base workspace by cloning the target repository.
   *
   * This creates a clean, sandboxed baseline that can be cloned
   * for each hypothesis.
   *
   * @param targetRepoPath - Path to the user's actual code
   * @returns Promise resolving to base workspace path
   */
  async initBaseWorkspace(targetRepoPath: string): Promise<string> {
    const resolvedTarget = resolve(targetRepoPath);

    if (!existsSync(resolvedTarget)) {
      throw new Error(`Target repository does not exist: ${resolvedTarget}`);
    }

    // Ensure the base directory parent exists
    mkdirSync(this.basePath, { recursive: true });

    console.log(`[WorkspaceManager] Cloning ${resolvedTarget} to ${this.basePath}...`);

    // Clone the target repo as the base
    const options: string[] = ['--quiet'];

    await this.git.clone(resolvedTarget, this.basePath, options);

    // Configure git identity in the cloned workspace
    const baseGit = simpleGit(this.basePath);
    await baseGit.addConfig('user.email', 'aesop@ephemeral.workspace', false, 'local');
    await baseGit.addConfig('user.name', 'Aesop Ephemeral Workspace', false, 'local');

    console.log(`[WorkspaceManager] Base workspace initialized at ${this.basePath}`);

    return this.basePath;
  }

  /**
   * Create an isolated workspace for a hypothesis by cloning the base.
   *
   * Each hypothesis gets its own complete clone of the target repo,
   * allowing parallel execution without file conflicts.
   *
   * @param hypothesisName - Name for the hypothesis
   * @param options - Optional configuration
   * @returns Promise resolving to workspace path
   */
  async createHypothesisWorkspace(
    hypothesisName: string,
    options: Partial<CreateHypothesisOptions> = {}
  ): Promise<WorkspaceInfo> {
    const sanitizedName = this.sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.workspaceRoot, this.sessionId, `hyp_${sanitizedName}`);
    const branchName = options.branchName ?? sanitizedName;

    console.log(`[WorkspaceManager] Creating hypothesis workspace: ${hypothesisPath}`);

    // Ensure parent directory exists
    mkdirSync(hypothesisPath, { recursive: true });

    // Clone from base into hypothesis directory
    const options2: string[] = ['--quiet'];
    await this.git.clone(this.basePath, hypothesisPath, options2);

    // Open the new clone and create branch
    const hypGit = simpleGit(hypothesisPath);

    // Configure git identity in the hypothesis workspace
    await hypGit.addConfig('user.email', 'aesop@ephemeral.workspace', false, 'local');
    await hypGit.addConfig('user.name', 'Aesop Ephemeral Workspace', false, 'local');

    // Optionally switch to a branch
    if (options.baseBranch && options.baseBranch !== 'main') {
      try {
        await hypGit.fetch('origin', options.baseBranch);
        await hypGit.checkout(['-b', branchName, `origin/${options.baseBranch}`]);
      } catch {
        // If fetch fails, just create branch from current HEAD
        await hypGit.checkout(['-b', branchName]);
      }
    } else {
      await hypGit.checkout(['-b', branchName]);
    }

    console.log(`[WorkspaceManager] Hypothesis workspace created at ${hypothesisPath}`);

    return {
      sessionId: this.sessionId,
      workspaceRoot: join(this.workspaceRoot, this.sessionId),
      basePath: this.basePath,
      hypothesisPath,
      hypothesisName: sanitizedName,
      createdAt: this.createdAt,
    };
  }

  /**
   * Delete a hypothesis workspace to free up space.
   *
   * @param hypothesisName - Name of the hypothesis to remove
   * @returns Promise resolving to true if deleted, false if not found
   */
  async deleteHypothesisWorkspace(hypothesisName: string): Promise<boolean> {
    const sanitizedName = this.sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.workspaceRoot, this.sessionId, `hyp_${sanitizedName}`);

    if (!existsSync(hypothesisPath)) {
      console.warn(`[WorkspaceManager] Hypothesis workspace not found: ${hypothesisPath}`);
      return false;
    }

    console.log(`[WorkspaceManager] Deleting hypothesis workspace: ${hypothesisPath}`);
    rmSync(hypothesisPath, { recursive: true, force: true });

    return true;
  }

  /**
   * Clean up the entire session workspace.
   *
   * @returns Promise resolving when cleanup is complete
   */
  async cleanup(): Promise<void> {
    const sessionPath = join(this.workspaceRoot, this.sessionId);

    if (existsSync(sessionPath)) {
      console.log(`[WorkspaceManager] Cleaning up session workspace: ${sessionPath}`);
      rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  /**
   * List all hypothesis workspaces in this session.
   *
   * @returns Array of hypothesis workspace info
   */
  listHypothesisWorkspaces(): WorkspaceInfo[] {
    const sessionPath = join(this.workspaceRoot, this.sessionId);

    if (!existsSync(sessionPath)) {
      return [];
    }

    const entries = readdirSync(sessionPath, { withFileTypes: true });

    return entries
      .filter(
        (entry: { isDirectory: () => boolean; name: string }) =>
          entry.isDirectory() && entry.name.startsWith('hyp_')
      )
      .map((entry: { name: string }) => ({
        sessionId: this.sessionId,
        workspaceRoot: sessionPath,
        basePath: this.basePath,
        hypothesisPath: join(sessionPath, entry.name),
        hypothesisName: entry.name.slice(4), // Remove 'hyp_' prefix
        createdAt: this.createdAt,
      }));
  }

  /**
   * Merge a successful hypothesis workspace back into the base.
   *
   * This merges the hypothesis branch into the base directory,
   * preparing it for potential promotion to the original repository.
   *
   * @param hypothesisName - Name of the hypothesis to merge
   * @param targetBranch - Target branch in base (default: main)
   * @returns Promise resolving to true if merge successful
   */
  async mergeIntoBase(hypothesisName: string, targetBranch = 'main'): Promise<boolean> {
    const sanitizedName = this.sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.workspaceRoot, this.sessionId, `hyp_${sanitizedName}`);

    if (!existsSync(hypothesisPath)) {
      throw new Error(`Hypothesis workspace not found: ${hypothesisPath}`);
    }

    const hypGit = simpleGit(hypothesisPath);
    const baseGit = simpleGit(this.basePath);

    // Get current branch name in hypothesis workspace
    const status = await hypGit.status();
    const currentBranch = status.current ?? sanitizedName;

    console.log(`[WorkspaceManager] Merging ${currentBranch} into base...`);

    // Checkout target branch in base
    try {
      await baseGit.checkout(targetBranch);
    } catch {
      // Branch might not exist, create it
      await baseGit.checkout(['-b', targetBranch]);
    }

    // Merge the hypothesis branch
    const baseGit2 = simpleGit(this.basePath);
    try {
      const result = await baseGit2.merge([currentBranch]);
      console.log(`[WorkspaceManager] Merge result: ${result.result}`);
      return result.result === 'success';
    } catch (error: unknown) {
      const err = error as { message?: string };
      if (err.message?.includes('CONFLICT')) {
        // Abort merge on conflict
        await baseGit2.merge(['--abort']);
        return false;
      }
      throw error;
    }
  }

  /**
   * Get git instance for a hypothesis workspace.
   *
   * @param hypothesisName - Name of the hypothesis
   * @returns SimpleGit instance for the hypothesis workspace
   */
  getHypothesisGit(hypothesisName: string): SimpleGit {
    const sanitizedName = this.sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.workspaceRoot, this.sessionId, `hyp_${sanitizedName}`);
    return simpleGit(hypothesisPath);
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

/**
 * Create a new workspace manager and initialize the base workspace.
 *
 * @param options - Configuration options
 * @returns Promise resolving to initialized WorkspaceManager
 */
export async function createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceManager> {
  const workspaceRoot = options.workspaceRoot ?? '.aesop_workspaces';

  const manager = new WorkspaceManager(workspaceRoot, options.targetRepoPath, options.showProgress);

  await manager.initBaseWorkspace(options.targetRepoPath);

  return manager;
}

export default WorkspaceManager;
