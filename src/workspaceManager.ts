/**
 * WorkspaceManager
 *
 * Manages an internal Git repository that Aesop owns, seeded from the user's
 * project directory. This provides:
 *
 * - A baseline snapshot of user code for experiment comparison
 * - Lightweight ephemeral workspaces using git worktree
 * - Deterministic sync with file exclusion support
 *
 * Directory structure:
 * <user-project>/
 * ├── .aesop/
 * │   └── repo/                 # The managed git repository
 * │       ├── .git/
 * │       └── (snapshot files)
 * └── .aesop_ephemeral/         # Worktree workspaces
 *     └── <branch-name>/
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import simpleGit, { SimpleGit } from 'simple-git';

/** Absolute path to the managed repository */
export const MANAGED_REPO_DIR = '.aesop/repo';

/** Absolute path to ephemeral workspaces */
export const EPHEMERAL_ROOT = '.aesop_ephemeral';

/** Default exclusion patterns (always applied) */
const DEFAULT_EXCLUSIONS = [
  '__pycache__/',
  '*.pyc',
  'node_modules/',
  'data/',
  'datasets/',
  'checkpoints/',
  '*.pt',
  '*.ckpt',
  '*.bin',
  '.aesop/',
  '.git/',
];

// ============================================================================
// NEW API (primary interface)
// ============================================================================

/**
 * Represents an ephemeral workspace created from a branch in the managed repo.
 */
export interface Workspace {
  /** Absolute path to the worktree */
  path: string;
  /** Branch name, e.g., hypothesis/test-lr */
  branch: string;
  /** Commit hash of main that this workspace branched from */
  commitHash: string;
  /** Remove worktree and delete branch */
  dispose(): Promise<void>;
}

/**
 * Interface for the workspace manager.
 */
export interface IWorkspaceManager {
  /** Initialize the managed repo (idempotent) */
  init(): Promise<void>;
  /** Sync user code into managed repo and commit to main */
  sync(): Promise<{ commitHash: string }>;
  /** Create an ephemeral workspace on a new branch */
  createEphemeralWorkspace(_name: string): Promise<Workspace>;
}

// ============================================================================
// BACKWARD COMPATIBILITY API (legacy interface)
// ============================================================================

/**
 * Legacy interface - kept for backward compatibility.
 * @deprecated Use Workspace instead
 */
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

/**
 * Options for creating a workspace.
 * @deprecated Use IWorkspaceManager instead
 */
export interface CreateWorkspaceOptions {
  /** Path to the target repository to sandbox */
  targetRepoPath: string;
  /** Root directory for workspaces (default: .aesop_workspaces/) */
  workspaceRoot?: string;
  /** Whether to show progress during clone operations */
  showProgress?: boolean;
}

/**
 * Options for creating a hypothesis workspace.
 * @deprecated Use createEphemeralWorkspace instead
 */
export interface CreateHypothesisOptions {
  /** Name for the hypothesis */
  hypothesisName: string;
  /** Branch name to checkout (default: auto-generated) */
  branchName?: string | undefined;
  /** Base branch to use (default: main) */
  baseBranch?: string | undefined;
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Builds exclusion patterns for rsync.
 * Priority: .aesopignore > .gitignore > defaults
 */
function buildExclusionPatterns(projectPath: string): string[] {
  const exclusions = new Set<string>(DEFAULT_EXCLUSIONS);

  // Check for .aesopignore
  const aesopignorePath = join(projectPath, '.aesopignore');
  if (existsSync(aesopignorePath)) {
    const patterns = readFileSync(aesopignorePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    patterns.forEach((p) => exclusions.add(p));
  }

  // Check for .gitignore
  const gitignorePath = join(projectPath, '.gitignore');
  if (existsSync(gitignorePath)) {
    const patterns = readFileSync(gitignorePath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    patterns.forEach((p) => exclusions.add(p));
  }

  return Array.from(exclusions);
}

/**
 * Sync files from source to destination.
 * Uses rsync if available, otherwise falls back to Node.js fs.
 * Excludes patterns defined in the exclusion list.
 */
function syncFiles(sourcePath: string, destPath: string, exclusions: string[]): void {
  const resolvedSource = resolve(sourcePath);
  const resolvedDest = resolve(destPath);

  // Build rsync args
  const rsyncArgs = ['-a', '--delete'];

  // Add exclusions
  for (const pattern of exclusions) {
    rsyncArgs.push('--exclude', pattern);
  }

  // Source and dest
  rsyncArgs.push(resolvedSource + '/');
  rsyncArgs.push(resolvedDest + '/');

  try {
    execSync(`rsync ${rsyncArgs.join(' ')}`, { shell: '/bin/sh', stdio: 'pipe' });
  } catch {
    // Fallback: use Node.js fs to copy files manually
    syncFilesNode(resolvedSource, resolvedDest, exclusions);
  }
}

/**
 * Node.js-based file sync (fallback when rsync is not available).
 */
function syncFilesNode(sourcePath: string, destPath: string, exclusions: string[]): void {
  // Ensure destination exists
  mkdirSync(destPath, { recursive: true });

  const copyDir = (src: string, dest: string): void => {
    const entries = readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPathFile = join(dest, entry.name);

      // Check if excluded
      if (isExcluded(srcPath, sourcePath, exclusions)) {
        continue;
      }

      if (entry.isDirectory()) {
        mkdirSync(destPathFile, { recursive: true });
        copyDir(srcPath, destPathFile);
      } else {
        // Copy file
        const content = readFileSync(srcPath);
        writeFileSync(destPathFile, content);
      }
    }
  };

  copyDir(sourcePath, destPath);
}

/**
 * Check if a path matches any exclusion pattern.
 */
function isExcluded(filePath: string, basePath: string, exclusions: string[]): boolean {
  const relPath = relative(basePath, filePath).replace(/\\/g, '/');

  for (const pattern of exclusions) {
    if (pattern.endsWith('/')) {
      // Directory pattern
      const dirPattern = pattern.slice(0, -1);
      if (relPath.startsWith(dirPattern + '/') || relPath === dirPattern) {
        return true;
      }
    } else if (pattern.startsWith('*.')) {
      // Glob pattern for extension
      const ext = pattern.slice(1);
      if (relPath.endsWith(ext)) {
        return true;
      }
    } else {
      // Exact or prefix match
      if (relPath === pattern || relPath.startsWith(pattern + '/')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Sanitize hypothesis name for use in paths and branch names.
 */
function sanitizeHypothesisName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

// ============================================================================
// WORKSPACEMANAGER CLASS
// ============================================================================

/**
 * WorkspaceManager - Manages the internal Git repository for Aesop.
 *
 * This class creates and maintains a snapshot of the user's project that can
 * be used for experiment isolation and baseline comparison.
 *
 * Supports two APIs:
 * - New API: init(), sync(), createEphemeralWorkspace()
 * - Legacy API: initBaseWorkspace(), createHypothesisWorkspace(), etc.
 */
export class WorkspaceManager implements IWorkspaceManager {
  private readonly projectPath: string;
  private readonly managedRepoPath: string;
  private readonly ephemeralRoot: string;

  // Legacy properties
  private readonly sessionId: string;
  private readonly createdAt: Date;
  private readonly basePath: string;

  /**
   * Create a new WorkspaceManager.
   *
   * @param projectPath - Path to the user's project (default: cwd)
   * @param _targetRepoPath - Deprecated, kept for backward compatibility
   * @param _showProgress - Deprecated, kept for backward compatibility
   * @param _sessionId - Deprecated, kept for backward compatibility
   */
  constructor(
    projectPath = process.cwd(),
    _targetRepoPath?: string,
    _showProgress?: boolean,
    _sessionId?: string
  ) {
    this.projectPath = resolve(projectPath);
    this.managedRepoPath = join(this.projectPath, MANAGED_REPO_DIR);
    this.ephemeralRoot = join(this.projectPath, EPHEMERAL_ROOT);

    // Legacy properties
    this.sessionId = _sessionId ?? `session_${Date.now()}`;
    this.createdAt = new Date();
    this.basePath = join(this.ephemeralRoot, this.sessionId, 'base');
  }

  // ========================================================================
  // LEGACY API (backward compatibility)
  // ========================================================================

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
    return join(this.ephemeralRoot, this.sessionId);
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
      workspaceRoot: join(this.ephemeralRoot, this.sessionId),
      basePath: this.basePath,
      createdAt: this.createdAt,
    };
  }

  /**
   * Initialize the base workspace by cloning the target repository.
   *
   * @deprecated Use init() instead
   */
  async initBaseWorkspace(targetRepoPath: string): Promise<string> {
    const resolvedTarget = resolve(targetRepoPath);

    if (!existsSync(resolvedTarget)) {
      throw new Error(`Target repository does not exist: ${resolvedTarget}`);
    }

    mkdirSync(this.basePath, { recursive: true });

    const git = simpleGit();
    await git.clone(resolvedTarget, this.basePath, ['--quiet']);

    const baseGit = simpleGit(this.basePath);
    await baseGit.addConfig('user.email', 'aesop@ephemeral.workspace', false, 'local');
    await baseGit.addConfig('user.name', 'Aesop Ephemeral Workspace', false, 'local');

    return this.basePath;
  }

  /**
   * Create an isolated workspace for a hypothesis by cloning the base.
   *
   * @deprecated Use createEphemeralWorkspace() instead
   */
  async createHypothesisWorkspace(
    hypothesisName: string,
    options: Partial<CreateHypothesisOptions> = {}
  ): Promise<WorkspaceInfo> {
    const sanitizedName = sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.ephemeralRoot, this.sessionId, `hyp_${sanitizedName}`);
    const branchName = options.branchName ?? sanitizedName;

    mkdirSync(hypothesisPath, { recursive: true });

    const git = simpleGit();
    await git.clone(this.basePath, hypothesisPath, ['--quiet']);

    const hypGit = simpleGit(hypothesisPath);
    await hypGit.addConfig('user.email', 'aesop@ephemeral.workspace', false, 'local');
    await hypGit.addConfig('user.name', 'Aesop Ephemeral Workspace', false, 'local');

    if (options.baseBranch && options.baseBranch !== 'main') {
      try {
        await hypGit.fetch('origin', options.baseBranch);
        await hypGit.checkout(['-b', branchName, `origin/${options.baseBranch}`]);
      } catch {
        await hypGit.checkout(['-b', branchName]);
      }
    } else {
      await hypGit.checkout(['-b', branchName]);
    }

    return {
      sessionId: this.sessionId,
      workspaceRoot: join(this.ephemeralRoot, this.sessionId),
      basePath: this.basePath,
      hypothesisPath,
      hypothesisName: sanitizedName,
      createdAt: this.createdAt,
    };
  }

  /**
   * Delete a hypothesis workspace to free up space.
   *
   * @deprecated Use workspace.dispose() instead
   */
  async deleteHypothesisWorkspace(hypothesisName: string): Promise<boolean> {
    const sanitizedName = sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.ephemeralRoot, this.sessionId, `hyp_${sanitizedName}`);

    if (!existsSync(hypothesisPath)) {
      return false;
    }

    rmSync(hypothesisPath, { recursive: true, force: true });
    return true;
  }

  /**
   * Clean up the entire session workspace.
   */
  async cleanup(): Promise<void> {
    const sessionPath = join(this.ephemeralRoot, this.sessionId);

    if (existsSync(sessionPath)) {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  /**
   * List all hypothesis workspaces in this session.
   */
  listHypothesisWorkspaces(): WorkspaceInfo[] {
    const sessionPath = join(this.ephemeralRoot, this.sessionId);

    if (!existsSync(sessionPath)) {
      return [];
    }

    const entries = readdirSync(sessionPath, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('hyp_'))
      .map((entry) => ({
        sessionId: this.sessionId,
        workspaceRoot: sessionPath,
        basePath: this.basePath,
        hypothesisPath: join(sessionPath, entry.name),
        hypothesisName: entry.name.slice(4),
        createdAt: this.createdAt,
      }));
  }

  /**
   * Merge a successful hypothesis workspace back into the base.
   *
   * @deprecated This API is being redesigned
   */
  async mergeIntoBase(hypothesisName: string, targetBranch = 'main'): Promise<boolean> {
    const sanitizedName = sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.ephemeralRoot, this.sessionId, `hyp_${sanitizedName}`);

    if (!existsSync(hypothesisPath)) {
      throw new Error(`Hypothesis workspace not found: ${hypothesisPath}`);
    }

    const hypGit = simpleGit(hypothesisPath);
    const baseGit = simpleGit(this.basePath);

    const status = await hypGit.status();
    const currentBranch = status.current ?? sanitizedName;

    try {
      await baseGit.checkout(targetBranch);
    } catch {
      await baseGit.checkout(['-b', targetBranch]);
    }

    const baseGit2 = simpleGit(this.basePath);
    try {
      const result = await baseGit2.merge([currentBranch]);
      return result.result === 'success';
    } catch (error) {
      const err = error as Error & { message?: string };
      if (err.message?.includes('CONFLICT')) {
        await baseGit2.merge(['--abort']);
        return false;
      }
      throw error;
    }
  }

  /**
   * Get git instance for a hypothesis workspace.
   */
  getHypothesisGit(hypothesisName: string): SimpleGit {
    const sanitizedName = sanitizeHypothesisName(hypothesisName);
    const hypothesisPath = join(this.ephemeralRoot, this.sessionId, `hyp_${sanitizedName}`);
    return simpleGit(hypothesisPath);
  }

  // ========================================================================
  // NEW API
  // ========================================================================

  /**
   * Get the path to the managed repository.
   */
  getManagedRepoPath(): string {
    return this.managedRepoPath;
  }

  /**
   * Initialize the managed repository.
   *
   * On first call: creates .aesop/repo/, copies user code, commits to main.
   * On subsequent calls: idempotent, no-op if already initialized.
   */
  async init(): Promise<void> {
    // Check if already initialized
    if (existsSync(join(this.managedRepoPath, '.git'))) {
      return;
    }

    // Create the managed repo directory
    mkdirSync(this.managedRepoPath, { recursive: true });

    // Initialize git repo
    const repoGit = simpleGit(this.managedRepoPath);
    await repoGit.init();

    // Configure git identity
    await repoGit.addConfig('user.email', 'aesop@aesop.dev', false, 'local');
    await repoGit.addConfig('user.name', 'Aesop', false, 'local');

    // Sync files from user project to managed repo
    const exclusions = buildExclusionPatterns(this.projectPath);
    syncFiles(this.projectPath, this.managedRepoPath, exclusions);

    // Commit initial state
    await repoGit.add('.');
    await repoGit.commit('Initial snapshot from user project');
  }

  /**
   * Sync changes from the user directory into the managed repository.
   *
   * This copies the current user code into .aesop/repo/ and creates a new
   * commit on the main branch. The commit hash is returned.
   */
  async sync(): Promise<{ commitHash: string }> {
    // Ensure initialized
    await this.init();

    const repoGit = simpleGit(this.managedRepoPath);

    // Sync files from user project
    const exclusions = buildExclusionPatterns(this.projectPath);
    syncFiles(this.projectPath, this.managedRepoPath, exclusions);

    // Stage all changes
    await repoGit.add('.');

    // Check if there are changes to commit
    const status = await repoGit.status();

    if (
      status.staged.length === 0 &&
      status.modified.length === 0 &&
      status.created.length === 0 &&
      status.deleted.length === 0
    ) {
      // No changes, return current HEAD
      const log = await repoGit.log({ maxCount: 1 });
      return { commitHash: log.latest?.hash ?? 'unknown' };
    }

    // Create commit
    const result = await repoGit.commit('Sync from user project');

    return { commitHash: result.commit };
  }

  /**
   * Create an ephemeral workspace by checking out a branch in a worktree.
   *
   * @param branchName - Name for the new branch/workspace (e.g., "hypothesis/test-lr")
   * @returns Workspace object with path, branch, commitHash, and dispose method
   */
  async createEphemeralWorkspace(branchName: string): Promise<Workspace> {
    // Ensure managed repo is initialized
    await this.init();

    // Create ephemeral root if needed
    mkdirSync(this.ephemeralRoot, { recursive: true });

    const repoGit = simpleGit(this.managedRepoPath);

    // Get current main branch commit - use HEAD since we're in the managed repo
    const log = await repoGit.log({ maxCount: 1 });
    const mainCommit = log.latest?.hash;
    if (!mainCommit) {
      throw new Error('No commits found in managed repository');
    }

    // Create and checkout the branch in a worktree
    const worktreePath = join(this.ephemeralRoot, branchName.replace(/\//g, '_'));

    try {
      await repoGit.raw(['worktree', 'add', '--detach', worktreePath, mainCommit]);
    } catch (error) {
      // If worktree already exists, just use it
      if (!existsSync(worktreePath)) {
        throw error;
      }
    }

    // Create the branch in the worktree
    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.checkout(['-b', branchName]);

    const workspace: Workspace = {
      path: worktreePath,
      branch: branchName,
      commitHash: mainCommit,
      dispose: async (): Promise<void> => {
        await this.disposeWorkspace(branchName, worktreePath);
      },
    };

    return workspace;
  }

  /**
   * Remove a worktree and delete its branch.
   */
  private async disposeWorkspace(branchName: string, worktreePath: string): Promise<void> {
    const repoGit = simpleGit(this.managedRepoPath);

    // Remove the worktree
    try {
      await repoGit.raw(['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // Worktree might not exist, try to clean up path directly
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    // Delete the branch (don't fail if it doesn't exist)
    try {
      await repoGit.deleteLocalBranch(branchName, true);
    } catch {
      // Branch might already be deleted or never existed
    }
  }

  /**
   * Get the git instance for the managed repository.
   */
  getGit(): SimpleGit {
    return simpleGit(this.managedRepoPath);
  }

  /**
   * Check if the managed repository has been initialized.
   */
  isInitialized(): boolean {
    return existsSync(join(this.managedRepoPath, '.git'));
  }

  /**
   * List all ephemeral workspaces.
   */
  listEphemeralWorkspaces(): Array<{ path: string; branch: string }> {
    if (!existsSync(this.ephemeralRoot)) {
      return [];
    }

    const entries = readdirSync(this.ephemeralRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        path: join(this.ephemeralRoot, entry.name),
        branch: entry.name.replace(/_/g, '/'),
      }));
  }
}

// ============================================================================
// LEGACY FUNCTIONS
// ============================================================================

/**
 * Create a new workspace manager and initialize the base workspace.
 *
 * @deprecated Use new WorkspaceManager().init() instead
 */
export async function createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceManager> {
  const workspaceRoot = options.workspaceRoot ?? '.aesop_workspaces';
  const manager = new WorkspaceManager(workspaceRoot, options.targetRepoPath, options.showProgress);
  await manager.initBaseWorkspace(options.targetRepoPath);
  return manager;
}

/**
 * Parse an ephemeral workspace path to extract session ID and hypothesis name.
 *
 * @deprecated This function will be redesigned in a future release
 */
export function parseEphemeralWorkspace(
  workspaceRoot: string,
  currentDir = process.cwd()
): { sessionId: string; hypothesisName: string; hypothesisPath: string } | null {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedCwd = resolve(currentDir);

  if (!resolvedCwd.startsWith(resolvedRoot)) {
    return null;
  }

  const relativePath = resolvedCwd.slice(resolvedRoot.length + 1);
  const parts = relativePath.split(/[\\/]/);

  if (parts.length < 2) {
    return null;
  }

  const sessionId = parts[0]!;

  if (!sessionId.startsWith('session_')) {
    return null;
  }

  const hypIndex = parts.findIndex((p) => p.startsWith('hyp_'));

  if (hypIndex === -1) {
    return null;
  }

  const hypothesisDir = parts[hypIndex]!;
  const hypothesisName = hypothesisDir.slice(4);
  const hypothesisPath = join(resolvedRoot, sessionId, hypothesisDir);

  return {
    sessionId,
    hypothesisName,
    hypothesisPath,
  };
}

export default WorkspaceManager;
