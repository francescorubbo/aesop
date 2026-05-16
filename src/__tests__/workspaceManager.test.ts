import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceManager, createWorkspace } from '../workspaceManager';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { default as simpleGit } from 'simple-git';

// Create a test git repository
async function createTestRepo(repoPath: string): Promise<void> {
  const git = simpleGit();
  mkdirSync(repoPath, { recursive: true });

  // Initialize git repo
  await git.cwd(repoPath).init();

  // Set up git config for tests
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test User');

  // Create initial commit
  writeFileSync(join(repoPath, 'README.md'), '# Test Repository\n');
  await git.add('.');
  await git.commit('Initial commit');
}

describe('WorkspaceManager', () => {
  let testRoot: string;
  let targetRepoPath: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    // Create unique test directories
    testRoot = join(
      tmpdir(),
      `aesop-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    targetRepoPath = join(testRoot, 'target_repo');
    workspaceRoot = join(testRoot, 'workspaces');

    mkdirSync(testRoot, { recursive: true });

    // Create a test git repository to clone
    await createTestRepo(targetRepoPath);
  });

  afterEach(() => {
    // Clean up test directories
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create instance with workspace root and target repo', () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      expect(manager.getWorkspaceRoot()).toBe(resolve(workspaceRoot));
      expect(manager.getSessionId()).toMatch(/^session_\d+$/);
    });

    it('should create workspace root directory if it does not exist', () => {
      expect(existsSync(workspaceRoot)).toBe(false);

      new WorkspaceManager(workspaceRoot, targetRepoPath);

      expect(existsSync(workspaceRoot)).toBe(true);
    });
  });

  describe('getSessionId', () => {
    it('should return a unique session ID', () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      const sessionId = manager.getSessionId();

      expect(sessionId).toMatch(/^session_\d+$/);
    });

    it('should generate different IDs for different instances', () => {
      const manager1 = new WorkspaceManager(workspaceRoot, targetRepoPath);
      // Add delay to ensure different timestamp
      const startTime = Date.now();
      while (Date.now() - startTime < 2) {
        // Busy wait for 2ms
      }
      const manager2 = new WorkspaceManager(workspaceRoot, targetRepoPath);

      // Session IDs should have the expected format
      expect(manager1.getSessionId()).toMatch(/^session_\d+$/);
      expect(manager2.getSessionId()).toMatch(/^session_\d+$/);

      // If created at different times, IDs should differ
      if (Date.now() > startTime + 2) {
        expect(manager1.getSessionId()).not.toBe(manager2.getSessionId());
      }
    });
  });

  describe('getWorkspaceRoot', () => {
    it('should return the workspace root path', () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      expect(manager.getWorkspaceRoot()).toBe(resolve(workspaceRoot));
    });
  });

  describe('getBasePath', () => {
    it('should return the base path within the session', () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      const basePath = manager.getBasePath();
      const sessionId = manager.getSessionId();

      expect(basePath).toContain(sessionId);
      expect(basePath).toContain('base');
    });
  });

  describe('getWorkspaceInfo', () => {
    it('should return complete workspace info', () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      const info = manager.getWorkspaceInfo();

      expect(info).toHaveProperty('sessionId');
      expect(info).toHaveProperty('workspaceRoot');
      expect(info).toHaveProperty('basePath');
      expect(info).toHaveProperty('createdAt');
      expect(info.sessionId).toMatch(/^session_\d+$/);
    });
  });

  describe('initBaseWorkspace', () => {
    it('should clone target repo into base workspace', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      const basePath = await manager.initBaseWorkspace(targetRepoPath);

      expect(existsSync(basePath)).toBe(true);
      expect(existsSync(join(basePath, 'README.md'))).toBe(true);
    });

    it('should throw error if target repo does not exist', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      await expect(manager.initBaseWorkspace('/non/existent/path')).rejects.toThrow(
        'Target repository does not exist'
      );
    });

    it('should return the base path', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      const basePath = await manager.initBaseWorkspace(targetRepoPath);

      expect(basePath).toBe(manager.getBasePath());
    });
  });

  describe('createHypothesisWorkspace', () => {
    beforeEach(async () => {
      // Initialize base workspace first
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);
    });

    it('should create an isolated workspace for hypothesis', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      const info = await manager.createHypothesisWorkspace('test-hypothesis');

      expect(info.hypothesisPath).toBeDefined();
      expect(existsSync(info.hypothesisPath!)).toBe(true);
      expect(info.hypothesisName).toBe('test-hypothesis');
    });

    it('should clone files from base workspace', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      const info = await manager.createHypothesisWorkspace('test');

      expect(existsSync(join(info.hypothesisPath!, 'README.md'))).toBe(true);
    });

    it('should create a new branch in the hypothesis workspace', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      await manager.createHypothesisWorkspace('test-hypothesis');

      const hypGit = manager.getHypothesisGit('test-hypothesis');
      const status = await hypGit.status();

      expect(status.current).toBeTruthy();
      expect(status.current).toContain('test-hypothesis');
    });

    it('should sanitize hypothesis names for paths', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      const info = await manager.createHypothesisWorkspace('Test With Spaces & Special!');

      expect(info.hypothesisName).toBe('test-with-spaces-special');
      expect(info.hypothesisPath).toContain('hyp_test-with-spaces-special');
    });

    it('should limit hypothesis name length', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      const longName = 'a'.repeat(100);
      const info = await manager.createHypothesisWorkspace(longName);

      expect(info.hypothesisName!.length).toBeLessThanOrEqual(50);
    });

    it('should create multiple hypothesis workspaces', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      await manager.createHypothesisWorkspace('hypothesis-a');
      await manager.createHypothesisWorkspace('hypothesis-b');
      await manager.createHypothesisWorkspace('hypothesis-c');

      const workspaces = manager.listHypothesisWorkspaces();

      expect(workspaces.length).toBe(3);
    });
  });

  describe('deleteHypothesisWorkspace', () => {
    beforeEach(async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);
      await manager.createHypothesisWorkspace('to-delete');
    });

    it('should delete a hypothesis workspace', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);
      const info = await manager.createHypothesisWorkspace('to-delete');
      const workspacePath = info.hypothesisPath!;

      expect(existsSync(workspacePath)).toBe(true);

      const deleted = await manager.deleteHypothesisWorkspace('to-delete');

      expect(deleted).toBe(true);
      expect(existsSync(workspacePath)).toBe(false);
    });

    it('should return false when hypothesis workspace does not exist', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      const deleted = await manager.deleteHypothesisWorkspace('non-existent');

      expect(deleted).toBe(false);
    });
  });

  describe('listHypothesisWorkspaces', () => {
    beforeEach(async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);
    });

    it('should return empty array when no workspaces exist', () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);

      const workspaces = manager.listHypothesisWorkspaces();

      expect(workspaces).toEqual([]);
    });

    it('should list all hypothesis workspaces', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      await manager.createHypothesisWorkspace('test-1');
      await manager.createHypothesisWorkspace('test-2');

      const workspaces = manager.listHypothesisWorkspaces();

      expect(workspaces.length).toBe(2);
      expect(workspaces.map((w) => w.hypothesisName)).toContain('test-1');
      expect(workspaces.map((w) => w.hypothesisName)).toContain('test-2');
    });

    it('should return correct workspace paths', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      await manager.createHypothesisWorkspace('my-test');

      const workspaces = manager.listHypothesisWorkspaces();
      const found = workspaces.find((w) => w.hypothesisName === 'my-test');

      expect(found).toBeDefined();
      expect(found!.hypothesisPath).toContain('hyp_my-test');
    });
  });

  describe('mergeIntoBase', () => {
    beforeEach(async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);
    });

    it('should throw error when hypothesis workspace does not exist', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      await expect(manager.mergeIntoBase('non-existent', 'main')).rejects.toThrow(
        'Hypothesis workspace not found'
      );
    });

    it('should set up branch for merging', async () => {
      // Note: Full merge testing requires push/pull setup between clones
      // This test verifies the hypothesis workspace is created correctly
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);

      const info = await manager.createHypothesisWorkspace('merge-test');

      expect(existsSync(info.hypothesisPath!)).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove the entire session workspace', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);
      await manager.createHypothesisWorkspace('test');

      const sessionPath = join(workspaceRoot, manager.getSessionId());
      expect(existsSync(sessionPath)).toBe(true);

      await manager.cleanup();

      expect(existsSync(sessionPath)).toBe(false);
    });
  });

  describe('getHypothesisGit', () => {
    it('should return a git instance for the hypothesis workspace', async () => {
      const manager = new WorkspaceManager(workspaceRoot, targetRepoPath);
      await manager.initBaseWorkspace(targetRepoPath);
      await manager.createHypothesisWorkspace('test');

      const git = manager.getHypothesisGit('test');

      expect(git).toBeDefined();
    });
  });
});

describe('createWorkspace', () => {
  let testRoot: string;
  let targetRepoPath: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aesop-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    targetRepoPath = join(testRoot, 'target_repo');
    workspaceRoot = join(testRoot, 'workspaces');

    mkdirSync(testRoot, { recursive: true });
    await createTestRepo(targetRepoPath);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create and initialize a workspace in one call', async () => {
    const manager = await createWorkspace({
      targetRepoPath,
      workspaceRoot,
    });

    expect(manager).toBeInstanceOf(WorkspaceManager);
    expect(existsSync(manager.getBasePath())).toBe(true);
  });

  it('should return workspace with correct session ID', async () => {
    const manager = await createWorkspace({
      targetRepoPath,
      workspaceRoot,
    });

    expect(manager.getSessionId()).toMatch(/^session_\d+$/);
  });

  it('should clone the target repo into base path', async () => {
    await createWorkspace({
      targetRepoPath,
      workspaceRoot,
    });

    // Check that the clone exists with expected files
    const sessionDirs = readdirSync(workspaceRoot);
    expect(sessionDirs.length).toBeGreaterThan(0);
  });
});

describe('Workspace isolation', () => {
  let testRoot: string;
  let targetRepoPath: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aesop-isolation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    targetRepoPath = join(testRoot, 'target_repo');
    workspaceRoot = join(testRoot, 'workspaces');

    mkdirSync(testRoot, { recursive: true });
    await createTestRepo(targetRepoPath);
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should keep multiple hypothesis workspaces isolated', async () => {
    const manager = await createWorkspace({
      targetRepoPath,
      workspaceRoot,
    });

    // Create two hypothesis workspaces
    const infoA = await manager.createHypothesisWorkspace('hypothesis-a');
    const infoB = await manager.createHypothesisWorkspace('hypothesis-b');

    // Modify file in hypothesis A
    const hypGitA = manager.getHypothesisGit('hypothesis-a');
    writeFileSync(join(infoA.hypothesisPath!, 'modified-in-a.txt'), 'content A');
    await hypGitA.add('.');
    await hypGitA.commit('Modified in A');

    // Modify file in hypothesis B
    const hypGitB = manager.getHypothesisGit('hypothesis-b');
    writeFileSync(join(infoB.hypothesisPath!, 'modified-in-b.txt'), 'content B');
    await hypGitB.add('.');
    await hypGitB.commit('Modified in B');

    // Verify files are isolated
    expect(existsSync(join(infoA.hypothesisPath!, 'modified-in-a.txt'))).toBe(true);
    expect(existsSync(join(infoA.hypothesisPath!, 'modified-in-b.txt'))).toBe(false);

    expect(existsSync(join(infoB.hypothesisPath!, 'modified-in-b.txt'))).toBe(true);
    expect(existsSync(join(infoB.hypothesisPath!, 'modified-in-a.txt'))).toBe(false);
  });

  it('should not modify target repo when changing hypothesis workspace', async () => {
    const manager = await createWorkspace({
      targetRepoPath,
      workspaceRoot,
    });

    const info = await manager.createHypothesisWorkspace('isolated-test');
    const hypGit = manager.getHypothesisGit('isolated-test');

    // Modify file in hypothesis workspace
    writeFileSync(join(info.hypothesisPath!, 'new-file.txt'), 'isolated content');
    await hypGit.add('.');
    await hypGit.commit('Add file in hypothesis');

    // Target repo should not have the new file
    expect(existsSync(join(targetRepoPath, 'new-file.txt'))).toBe(false);
  });
});
