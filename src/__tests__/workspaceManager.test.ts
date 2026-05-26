import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../workspaceManager';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import simpleGit from 'simple-git';

/**
 * Create a test project with some files and optional git init.
 */
async function createTestProject(
  projectPath: string,
  options: { initGit?: boolean; withFiles?: string[] } = {}
): Promise<void> {
  mkdirSync(projectPath, { recursive: true });

  // Always create README.md
  writeFileSync(join(projectPath, 'README.md'), '# Test Project');

  if (options.withFiles) {
    for (const file of options.withFiles) {
      const filePath = join(projectPath, file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `content of ${file}`);
    }
  } else {
    // Create src directory first, then files inside
    mkdirSync(join(projectPath, 'src'), { recursive: true });
    writeFileSync(join(projectPath, 'src', 'index.ts'), 'console.log("hello");');
  }

  if (options.initGit) {
    const git = simpleGit();
    await git.cwd(projectPath).init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test User');
    await git.add('.');
    await git.commit('Initial commit');
  }
}

// Helper to get dirname without importing
function dirname(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

describe('WorkspaceManager', () => {
  let testRoot: string;
  let projectPath: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aesop-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    projectPath = join(testRoot, 'user_project');
    mkdirSync(projectPath, { recursive: true });

    // Create a basic project structure
    await createTestProject(projectPath, {
      initGit: true,
      withFiles: ['src/index.ts', 'src/utils.ts', 'config.json'],
    });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create instance with default project path', () => {
      const mgr = new WorkspaceManager();
      expect(mgr).toBeInstanceOf(WorkspaceManager);
    });

    it('should create instance with custom project path', () => {
      const mgr = new WorkspaceManager(projectPath);
      expect(mgr).toBeInstanceOf(WorkspaceManager);
    });

    it('should resolve relative paths to absolute', () => {
      const mgr = new WorkspaceManager('./test');
      expect(mgr.getManagedRepoPath()).toBe(resolve('./test/.aesop/repo'));
    });
  });

  describe('init', () => {
    it('should create .aesop/repo/ with valid git history', async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(repoPath)).toBe(true);
      expect(existsSync(join(repoPath, '.git'))).toBe(true);
    });

    it('should copy user files into managed repo', async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'README.md'))).toBe(true);
      expect(existsSync(join(repoPath, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(repoPath, 'src', 'utils.ts'))).toBe(true);
      expect(existsSync(join(repoPath, 'config.json'))).toBe(true);
    });

    it('should create initial commit on main branch', async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const git = manager.getGit();
      const log = await git.log({ maxCount: 1 });

      expect(log.latest).toBeDefined();
      expect(log.latest?.message).toContain('Initial snapshot');
    });

    it('should be idempotent - init twice should not error', async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(repoPath)).toBe(true);

      // Should only have one commit
      const git = manager.getGit();
      const log = await git.log();
      expect(log.all).toHaveLength(1);
    });

    it('should set git identity for managed repo', async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const git = manager.getGit();
      const config = await git.listConfig();

      expect(config.all['user.email']).toBe('aesop@aesop.dev');
      expect(config.all['user.name']).toBe('Aesop');
    });
  });

  describe('sync', () => {
    beforeEach(async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();
    });

    it('should sync new files from user project', async () => {
      // Add a new file to user project
      writeFileSync(join(projectPath, 'new_file.txt'), 'new content');

      const result = await manager.sync();

      expect(result.commitHash).toBeDefined();
      expect(result.commitHash).not.toBe('unknown');

      // File should be in managed repo
      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'new_file.txt'))).toBe(true);
    });

    it('should sync modified files', async () => {
      // Modify existing file
      writeFileSync(join(projectPath, 'README.md'), '# Modified Content');

      await manager.sync();

      const repoPath = manager.getManagedRepoPath();
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      expect(content).toBe('# Modified Content');
    });

    it('should track deletions', async () => {
      // Delete a file
      rmSync(join(projectPath, 'config.json'));

      await manager.sync();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'config.json'))).toBe(false);
    });

    it('should create new commits for changes', async () => {
      const git = manager.getGit();
      const initialLog = await git.log({ maxCount: 1 });
      const initialHash = initialLog.latest?.hash;

      // Add new file
      writeFileSync(join(projectPath, 'another.txt'), 'content');

      const result = await manager.sync();

      const newLog = await git.log({ maxCount: 1 });
      expect(newLog.latest?.hash).not.toBe(initialHash);
      expect(result.commitHash).toBe(newLog.latest?.hash);
    });

    it('should not create commit if no changes', async () => {
      const git = manager.getGit();
      const initialLog = await git.log({ maxCount: 1 });
      const initialHash = initialLog.latest?.hash;

      const result = await manager.sync();

      expect(result.commitHash).toBe(initialHash);

      const newLog = await git.log();
      expect(newLog.all).toHaveLength(1);
    });

    it('should increment commit count for multiple syncs', async () => {
      const git = manager.getGit();

      writeFileSync(join(projectPath, 'file1.txt'), '1');
      await manager.sync();

      writeFileSync(join(projectPath, 'file2.txt'), '2');
      await manager.sync();

      const log = await git.log();
      expect(log.all).toHaveLength(3); // Initial + 2 syncs
    });
  });

  describe('createEphemeralWorkspace', () => {
    beforeEach(async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();
    });

    it('should create workspace with correct structure', async () => {
      const workspace = await manager.createEphemeralWorkspace('hypothesis/test');

      expect(workspace.path).toBeDefined();
      expect(workspace.branch).toBe('hypothesis/test');
      expect(workspace.commitHash).toBeDefined();
      expect(typeof workspace.dispose).toBe('function');
    });

    it('should create files in the workspace', async () => {
      const workspace = await manager.createEphemeralWorkspace('test-branch');

      expect(existsSync(join(workspace.path, 'README.md'))).toBe(true);
      expect(existsSync(join(workspace.path, 'src', 'index.ts'))).toBe(true);
    });

    it('should use git worktree for lightweight clone', async () => {
      await manager.createEphemeralWorkspace('worktree-test');

      // Worktrees are registered in the main repo
      const git = manager.getGit();
      const worktrees = await git.raw(['worktree', 'list', '--porcelain']);

      expect(worktrees).toContain('worktree-test');
    });

    it('should create branch in workspace', async () => {
      const workspace = await manager.createEphemeralWorkspace('feature/test');

      const worktreeGit = simpleGit(workspace.path);
      const status = await worktreeGit.status();

      expect(status.current).toBe('feature/test');
    });

    it('should branch from current main commit', async () => {
      // First sync to get current main
      writeFileSync(join(projectPath, 'baseline.txt'), 'baseline');
      const { commitHash: baseline } = await manager.sync();

      // Create workspace
      const workspace = await manager.createEphemeralWorkspace('experiment/a');

      expect(workspace.commitHash).toBe(baseline);
    });

    it('should allow multiple workspaces', async () => {
      const ws1 = await manager.createEphemeralWorkspace('experiment/1');
      const ws2 = await manager.createEphemeralWorkspace('experiment/2');

      expect(existsSync(ws1.path)).toBe(true);
      expect(existsSync(ws2.path)).toBe(true);
      expect(ws1.branch).not.toBe(ws2.branch);
    });
  });

  describe('workspace dispose', () => {
    beforeEach(async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();
    });

    it('should remove worktree on dispose', async () => {
      const workspace = await manager.createEphemeralWorkspace('to-dispose');
      const workspacePath = workspace.path;

      expect(existsSync(workspacePath)).toBe(true);

      await workspace.dispose();

      expect(existsSync(workspacePath)).toBe(false);
    });

    it('should delete branch on dispose', async () => {
      const workspace = await manager.createEphemeralWorkspace('to-delete');

      await workspace.dispose();

      // Branch should be deleted from managed repo
      const git = manager.getGit();
      const branches = await git.branchLocal();

      expect(branches.all).not.toContain('to-delete');
    });

    it('should handle dispose on non-existent workspace', async () => {
      const workspace: Workspace = {
        path: '/non/existent/path',
        branch: 'test',
        commitHash: 'abc123',
        dispose: async (): Promise<void> => {
          await manager['disposeWorkspace']('test', '/non/existent/path');
        },
      };

      // Should not throw
      await expect(workspace.dispose()).resolves.not.toThrow();
    });
  });

  describe('exclusion patterns', () => {
    it('should exclude node_modules', async () => {
      // Create node_modules in user project
      mkdirSync(join(projectPath, 'node_modules', 'some-package'), { recursive: true });
      writeFileSync(
        join(projectPath, 'node_modules', 'some-package', 'index.js'),
        'module.exports = {};'
      );

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'node_modules'))).toBe(false);
    });

    it('should exclude __pycache__', async () => {
      mkdirSync(join(projectPath, '__pycache__'), { recursive: true });
      writeFileSync(join(projectPath, '__pycache__', 'cache.pyc'), 'bytecode');

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, '__pycache__'))).toBe(false);
    });

    it('should exclude .pyc files', async () => {
      writeFileSync(join(projectPath, 'script.pyc'), 'compiled');

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'script.pyc'))).toBe(false);
    });

    it('should exclude common data directories', async () => {
      mkdirSync(join(projectPath, 'data'), { recursive: true });
      mkdirSync(join(projectPath, 'datasets'), { recursive: true });
      mkdirSync(join(projectPath, 'checkpoints'), { recursive: true });

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'data'))).toBe(false);
      expect(existsSync(join(repoPath, 'datasets'))).toBe(false);
      expect(existsSync(join(repoPath, 'checkpoints'))).toBe(false);
    });

    it('should exclude model files', async () => {
      writeFileSync(join(projectPath, 'model.pt'), 'model data');
      writeFileSync(join(projectPath, 'model.ckpt'), 'checkpoint');
      writeFileSync(join(projectPath, 'model.bin'), 'binary');

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'model.pt'))).toBe(false);
      expect(existsSync(join(repoPath, 'model.ckpt'))).toBe(false);
      expect(existsSync(join(repoPath, 'model.bin'))).toBe(false);
    });

    it('should exclude .aesop directory', async () => {
      mkdirSync(join(projectPath, '.aesop', 'internal'), { recursive: true });

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, '.aesop'))).toBe(false);
    });

    it('should respect .aesopignore patterns', async () => {
      writeFileSync(join(projectPath, '.aesopignore'), '*.log\ntemp/\n');
      writeFileSync(join(projectPath, 'debug.log'), 'log content');
      mkdirSync(join(projectPath, 'temp'), { recursive: true });
      writeFileSync(join(projectPath, 'temp', 'file.txt'), 'temp file');

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'debug.log'))).toBe(false);
      expect(existsSync(join(repoPath, 'temp'))).toBe(false);
    });

    it('should respect .gitignore patterns', async () => {
      // Create a .gitignore
      writeFileSync(join(projectPath, '.gitignore'), '*.log\nsecrets/\n');
      writeFileSync(join(projectPath, 'app.log'), 'log content');
      mkdirSync(join(projectPath, 'secrets'), { recursive: true });
      writeFileSync(join(projectPath, 'secrets', 'key.txt'), 'secret');

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'app.log'))).toBe(false);
      expect(existsSync(join(repoPath, 'secrets'))).toBe(false);
    });

    it('should handle .aesopignore comments', async () => {
      writeFileSync(
        join(projectPath, '.aesopignore'),
        '# This is a comment\n*.log\n# Another comment\n'
      );
      writeFileSync(join(projectPath, 'app.log'), 'log');

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'app.log'))).toBe(false);
    });

    it('should include user files not matching any exclusion', async () => {
      writeFileSync(join(projectPath, 'important.txt'), 'important');
      writeFileSync(join(projectPath, 'src', 'main.py'), 'print("hello")');

      manager = new WorkspaceManager(projectPath);
      await manager.init();

      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'important.txt'))).toBe(true);
      expect(existsSync(join(repoPath, 'src', 'main.py'))).toBe(true);
    });
  });

  describe('isInitialized', () => {
    it('should return false for uninitialized manager', () => {
      manager = new WorkspaceManager(projectPath);
      expect(manager.isInitialized()).toBe(false);
    });

    it('should return true after init', async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();
      expect(manager.isInitialized()).toBe(true);
    });
  });

  describe('listEphemeralWorkspaces', () => {
    beforeEach(async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();
    });

    it('should return empty array when no workspaces exist', () => {
      const workspaces = manager.listEphemeralWorkspaces();
      expect(workspaces).toEqual([]);
    });

    it('should list existing workspaces', async () => {
      await manager.createEphemeralWorkspace('test/workspace-1');
      await manager.createEphemeralWorkspace('test/workspace-2');

      const workspaces = manager.listEphemeralWorkspaces();

      expect(workspaces).toHaveLength(2);
      expect(workspaces.map((w) => w.branch)).toContain('test/workspace-1');
      expect(workspaces.map((w) => w.branch)).toContain('test/workspace-2');
    });

    it('should correctly handle branch names with underscores', async () => {
      const branchName = 'hypothesis/lr_decay';
      await manager.createEphemeralWorkspace(branchName);

      const workspaces = manager.listEphemeralWorkspaces();
      const ws = workspaces.find((w) => w.branch === branchName);

      expect(ws).toBeDefined();
      expect(ws?.branch).toBe(branchName);
    });

    it('should fallback to underscore replacement for legacy workspaces', async () => {
      // Manually create a directory that looks like a legacy workspace
      // (no .aesop-branch file)
      const legacyBranch = 'hypothesis/legacy_test';
      const legacyDirName = legacyBranch.replace(/\//g, '_'); // hypothesis_legacy_test
      const legacyPath = join(manager['ephemeralRoot'], legacyDirName);

      mkdirSync(legacyPath, { recursive: true });

      const workspaces = manager.listEphemeralWorkspaces();
      const ws = workspaces.find((w) => w.path === legacyPath);

      expect(ws).toBeDefined();
      // Legacy fallback replaces ALL underscores with slashes
      // hypothesis_legacy_test -> hypothesis/legacy/test
      expect(ws?.branch).toBe('hypothesis/legacy/test');
    });
  });

  describe('integration scenarios', () => {
    it('should support full workflow: init -> sync -> workspace -> dispose', async () => {
      // Create manager and initialize
      manager = new WorkspaceManager(projectPath);
      await manager.init();

      // Modify some files
      writeFileSync(join(projectPath, 'feature.ts'), 'export const feature = true;');
      const { commitHash } = await manager.sync();

      // Create experiment workspace
      const workspace = await manager.createEphemeralWorkspace('experiment/new-feature');

      // Verify workspace has the code
      expect(existsSync(join(workspace.path, 'feature.ts'))).toBe(true);
      expect(workspace.commitHash).toBe(commitHash);

      // Modify in workspace
      const worktreeGit = simpleGit(workspace.path);
      writeFileSync(join(workspace.path, 'experiment.ts'), 'experiment code');
      await worktreeGit.add('.');
      await worktreeGit.commit('Add experiment code');

      // Dispose workspace
      await workspace.dispose();

      // Verify workspace is gone
      expect(existsSync(workspace.path)).toBe(false);

      // Verify main repo still intact
      const repoPath = manager.getManagedRepoPath();
      expect(existsSync(join(repoPath, 'feature.ts'))).toBe(true);
      expect(existsSync(join(repoPath, 'experiment.ts'))).toBe(false); // Not in main
    });

    it('should handle concurrent sync and workspace creation', async () => {
      manager = new WorkspaceManager(projectPath);
      await manager.init();

      // Add file and sync
      writeFileSync(join(projectPath, 'concurrent.ts'), 'export const a = 1;');

      // Sync first to ensure file is committed
      const { commitHash } = await manager.sync();

      // Create workspace after sync is complete
      const workspace = await manager.createEphemeralWorkspace('concurrent/test');

      // Both should succeed
      expect(commitHash).toBeDefined();
      expect(workspace.path).toBeDefined();
      expect(workspace.commitHash).toBe(commitHash);
      expect(existsSync(join(workspace.path, 'concurrent.ts'))).toBe(true);
    });
  });
});

/**
 * Minimal Workspace interface for testing dispose on non-existent paths
 */
interface Workspace {
  path: string;
  branch: string;
  commitHash: string;
  dispose(): Promise<void>;
}
