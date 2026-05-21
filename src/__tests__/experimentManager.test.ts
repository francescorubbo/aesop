import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ExperimentManager,
  type ExperimentRecord,
  type IExperimentManager,
} from '../experimentManager';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Create mock git instance
const mockGitInstance = {
  fetch: vi.fn().mockResolvedValue(undefined),
  checkout: vi.fn().mockResolvedValue(undefined),
  raw: vi.fn().mockResolvedValue('abc123def456789'),
  status: vi.fn().mockResolvedValue({ current: 'main' }),
  merge: vi.fn().mockResolvedValue({ result: 'success' }),
  diff: vi.fn().mockResolvedValue(''),
  log: vi.fn().mockResolvedValue({ all: [], latest: null }),
  reset: vi.fn().mockResolvedValue(undefined),
  clone: vi.fn().mockResolvedValue(undefined),
  addConfig: vi.fn().mockResolvedValue(undefined),
};

// Mock simple-git module
vi.mock('simple-git', () => {
  const MockSimpleGit = vi.fn(() => mockGitInstance);
  return { default: MockSimpleGit };
});

describe('ExperimentManager', () => {
  let manager: ExperimentManager;
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockGitInstance.fetch.mockResolvedValue(undefined);
    mockGitInstance.checkout.mockResolvedValue(undefined);
    mockGitInstance.raw.mockResolvedValue('abc123def456789');
    mockGitInstance.status.mockResolvedValue({ current: 'main' });
    mockGitInstance.merge.mockResolvedValue({ result: 'success' });
    mockGitInstance.reset.mockResolvedValue(undefined);

    // Create a unique test directory
    testDir = join(tmpdir(), `aesop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    manager = new ExperimentManager(testDir);
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default path', () => {
      const m = new ExperimentManager();
      expect(m).toBeInstanceOf(ExperimentManager);
    });

    it('should create instance with custom path', () => {
      const m = new ExperimentManager('/custom/path');
      expect(m).toBeInstanceOf(ExperimentManager);
    });
  });

  describe('ephemeral mode persistence', () => {
    it('should write ledger to host repo path even when operating in ephemeral workspace', async () => {
      const hostRepoPath = testDir;
      const workspaceRoot = join(tmpdir(), `aesop-ws-${Date.now()}`);
      mkdirSync(workspaceRoot, { recursive: true });

      try {
        const ephemeralManager = new ExperimentManager(hostRepoPath);

        // 1. Initialize ephemeral workspace
        // This changes manager.repoPath to point into the sandbox
        await ephemeralManager.initEphemeralWorkspace(hostRepoPath, workspaceRoot);

        const currentRepoPath = (ephemeralManager as unknown as { repoPath: string }).repoPath;
        if (typeof currentRepoPath !== 'string') {
          throw new Error('currentRepoPath should be a string');
        }
        expect(currentRepoPath).not.toBe(hostRepoPath);
        expect(currentRepoPath).toContain(workspaceRoot);

        // 2. Log an experiment
        mockGitInstance.status.mockResolvedValue({ current: 'hypothesis/ephemeral-test' });
        await ephemeralManager.logExperiment('hypothesis/ephemeral-test', 'success', {
          accuracy: 0.99,
        });

        // 3. Verify ledger exists in HOST path, NOT ephemeral path
        const hostLedgerPath = join(hostRepoPath, 'experiments.jsonl');
        const ephemeralLedgerPath = join(currentRepoPath, 'experiments.jsonl');

        expect(existsSync(hostLedgerPath)).toBe(true);
        expect(existsSync(ephemeralLedgerPath)).toBe(false);

        // 4. Verify content is correct

        // 4. Verify content is correct
        const content = readFileSync(hostLedgerPath, 'utf-8');
        const record = JSON.parse(content.trim());
        expect(record.branch).toBe('hypothesis/ephemeral-test');
        expect(record.metrics.accuracy).toBe(0.99);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });

    it('should read log from host repo path even when operating in ephemeral workspace', async () => {
      const hostRepoPath = testDir;
      const workspaceRoot = join(tmpdir(), `aesop-ws-read-${Date.now()}`);
      mkdirSync(workspaceRoot, { recursive: true });

      try {
        // Pre-seed host ledger
        const hostLedgerPath = join(hostRepoPath, 'experiments.jsonl');
        writeFileSync(
          hostLedgerPath,
          JSON.stringify({
            timestamp: new Date().toISOString(),
            branch: 'main',
            commitHash: 'abc',
            status: 'success',
            metrics: {},
          }) + '\n'
        );

        const ephemeralManager = new ExperimentManager(hostRepoPath);
        await ephemeralManager.initEphemeralWorkspace(hostRepoPath, workspaceRoot);

        const log = ephemeralManager.getExperimentLog();
        expect(log).toHaveLength(1);
        expect(log[0]!.branch).toBe('main');
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  describe('createBranch', () => {
    it('should create branch with timestamp-prefixed name', async () => {
      const branch = await manager.createBranch('main', 'Test hypothesis');

      expect(branch).toMatch(/^hypothesis\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-test-hypothesis$/);
    });

    it('should sanitize hypothesis for branch name', async () => {
      const branch = await manager.createBranch('main', 'Test with SPECIAL & weird! chars@#');

      // Should contain cleaned version
      expect(branch).toContain('test-with-special-weird-chars');
      expect(branch).not.toContain('&');
      expect(branch).not.toContain('@');
      expect(branch).not.toContain('#');
    });

    it('should limit total branch name length', async () => {
      const longHypothesis = 'a'.repeat(100);
      const branch = await manager.createBranch('main', longHypothesis);

      // The total branch name should be under 100 chars (timestamp + hyphen + sanitized + truncated)
      expect(branch.length).toBeLessThan(100);
      // Should still start with hypothesis/
      expect(branch).toMatch(/^hypothesis\/\d{4}/);
    });

    it('should fetch and checkout base branch', async () => {
      await manager.createBranch('develop', 'Test');

      expect(mockGitInstance.fetch).toHaveBeenCalledWith('origin');
      expect(mockGitInstance.checkout).toHaveBeenCalled();
    });

    it('should fall back to local checkout if origin fetch fails', async () => {
      mockGitInstance.checkout
        .mockRejectedValueOnce(new Error('error: pathspec did not match any'))
        .mockResolvedValueOnce(undefined);

      await manager.createBranch('main', 'Test');

      expect(mockGitInstance.checkout).toHaveBeenCalled();
    });
  });

  describe('logExperiment', () => {
    it('should append experiment record to ledger', async () => {
      mockGitInstance.status.mockResolvedValue({ current: 'hypothesis/test' });

      await manager.logExperiment('hypothesis/test', 'success', { accuracy: 0.95 });

      const ledgerPath = join(testDir, 'experiments.jsonl');
      expect(existsSync(ledgerPath)).toBe(true);

      const content = readFileSync(ledgerPath, 'utf-8');
      const record = JSON.parse(content.trim());

      expect(record.branch).toBe('hypothesis/test');
      expect(record.status).toBe('success');
      expect(record.metrics).toEqual({ accuracy: 0.95 });
      expect(record.timestamp).toBeDefined();
      expect(record.commitHash).toBeDefined();
    });

    it('should use current branch from git status when branch not provided', async () => {
      mockGitInstance.status.mockResolvedValue({ current: 'hypothesis/current-branch' });

      await manager.logExperiment('ignored-branch', 'pending', {});

      const ledgerPath = join(testDir, 'experiments.jsonl');
      const content = readFileSync(ledgerPath, 'utf-8');
      const record = JSON.parse(content.trim());

      expect(record.branch).toBe('hypothesis/current-branch');
    });

    it('should use provided branch when current branch is null', async () => {
      mockGitInstance.status.mockResolvedValue({ current: null });

      await manager.logExperiment('hypothesis/fallback-branch', 'pending', {});

      const ledgerPath = join(testDir, 'experiments.jsonl');
      const content = readFileSync(ledgerPath, 'utf-8');
      const record = JSON.parse(content.trim());

      expect(record.branch).toBe('hypothesis/fallback-branch');
    });

    it('should append to existing ledger', async () => {
      // Create existing ledger
      const ledgerPath = join(testDir, 'experiments.jsonl');
      writeFileSync(
        ledgerPath,
        '{"timestamp":"2024-01-01T00:00:00.000Z","branch":"old","commitHash":"abc","status":"success","metrics":{}}\n'
      );
      mockGitInstance.status.mockResolvedValue({ current: 'hypothesis/new' });

      await manager.logExperiment('hypothesis/new', 'success', { metric: 0.8 });

      const content = readFileSync(ledgerPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('"branch":"old"');
      expect(lines[1]).toContain('"branch":"hypothesis/new"');
    });

    it('should record all status types', async () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');
      mockGitInstance.status.mockResolvedValue({ current: 'main' });

      for (const status of ['pending', 'success', 'failed'] as const) {
        mockGitInstance.status.mockResolvedValue({ current: `hypothesis/${status}` });
        await manager.logExperiment(`hypothesis/${status}`, status, {});
      }

      const content = readFileSync(ledgerPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      expect(lines.length).toBe(3);
      expect(lines[0]).toContain('"status":"pending"');
      expect(lines[1]).toContain('"status":"success"');
      expect(lines[2]).toContain('"status":"failed"');
    });

    it('should get commit hash from git', async () => {
      mockGitInstance.raw.mockResolvedValue('def456789abc\n');
      mockGitInstance.status.mockResolvedValue({ current: 'hypothesis/test' });

      await manager.logExperiment('hypothesis/test', 'success', {});

      const ledgerPath = join(testDir, 'experiments.jsonl');
      const content = readFileSync(ledgerPath, 'utf-8');
      const record = JSON.parse(content.trim());

      expect(record.commitHash).toBe('def456789abc');
    });
  });

  describe('mergeBranch', () => {
    beforeEach(() => {
      // Default: checkout succeeds, merge succeeds
      mockGitInstance.checkout.mockResolvedValue(undefined);
      mockGitInstance.merge.mockResolvedValue({ result: 'success' });
    });

    it('should switch to target branch before merging', async () => {
      await manager.mergeBranch('hypothesis/test', 'main');

      // Should checkout target branch first
      expect(mockGitInstance.checkout).toHaveBeenCalledWith('main');
    });

    it('should merge source branch into target', async () => {
      const result = await manager.mergeBranch('hypothesis/test', 'main');

      expect(result).toBe(true);
      expect(mockGitInstance.merge).toHaveBeenCalledWith(['hypothesis/test']);
    });

    it('should return true on successful merge', async () => {
      const result = await manager.mergeBranch('source', 'target');

      expect(result).toBe(true);
    });

    it('should return false on merge conflict', async () => {
      // Set up mocks: checkout succeeds, merge fails with conflict
      mockGitInstance.merge.mockRejectedValueOnce(
        new Error('CONFLICT: merge conflict in file.txt')
      );

      const result = await manager.mergeBranch('source', 'target');

      expect(result).toBe(false);
    });

    it('should abort merge and reset on conflict', async () => {
      // Set up mocks: checkout succeeds, merge fails with conflict
      mockGitInstance.merge
        .mockRejectedValueOnce(new Error('conflict'))
        .mockResolvedValue({ result: 'success' }); // For the abort call

      await manager.mergeBranch('source', 'target');

      expect(mockGitInstance.merge).toHaveBeenCalledWith(['--abort']);
      expect(mockGitInstance.reset).toHaveBeenCalledWith(['--hard', 'origin/target']);
    });

    it('should handle non-conflict errors by rethrowing', async () => {
      // Set up mocks: checkout succeeds, merge fails with non-conflict error
      mockGitInstance.merge.mockRejectedValueOnce(new Error('Network error'));

      await expect(manager.mergeBranch('source', 'target')).rejects.toThrow('Network error');
    });

    it('should handle conflict error with uppercase CONFLICT', async () => {
      // Set up mocks: checkout succeeds, merge fails with uppercase conflict
      mockGitInstance.merge.mockRejectedValueOnce(new Error('MERGE CONFLICT detected'));

      const result = await manager.mergeBranch('source', 'target');

      expect(result).toBe(false);
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch from git status', async () => {
      mockGitInstance.status.mockResolvedValue({ current: 'hypothesis/test-branch' });

      const branch = await manager.getCurrentBranch();

      expect(branch).toBe('hypothesis/test-branch');
    });

    it('should return null when no current branch', async () => {
      mockGitInstance.status.mockResolvedValue({ current: null });

      const branch = await manager.getCurrentBranch();

      expect(branch).toBeNull();
    });

    it('should call git status', async () => {
      await manager.getCurrentBranch();

      expect(mockGitInstance.status).toHaveBeenCalled();
    });
  });

  describe('getExperimentLog', () => {
    it('should return empty array when ledger does not exist', () => {
      const records = manager.getExperimentLog();

      expect(records).toEqual([]);
    });

    it('should parse valid experiment records', () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');
      const records = [
        {
          timestamp: '2024-01-15T10:30:00.000Z',
          branch: 'hypothesis/test-1',
          commitHash: 'abc123',
          status: 'success',
          metrics: { accuracy: 0.95 },
        },
        {
          timestamp: '2024-01-15T11:00:00.000Z',
          branch: 'hypothesis/test-2',
          commitHash: 'def456',
          status: 'failed',
          metrics: { accuracy: 0.5 },
        },
      ];
      writeFileSync(ledgerPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

      const result = manager.getExperimentLog();

      expect(result).toHaveLength(2);
      expect(result[0]!.branch).toBe('hypothesis/test-1');
      expect(result[0]!['metrics']['accuracy']).toBe(0.95);
      expect(result[1]!.status).toBe('failed');
    });

    it('should filter empty lines', () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');
      writeFileSync(
        ledgerPath,
        '\n\n{"timestamp":"2024-01-01T00:00:00.000Z","branch":"test","commitHash":"abc","status":"success","metrics":{}}\n\n\n'
      );

      const result = manager.getExperimentLog();

      expect(result).toHaveLength(1);
    });

    it('should return ExperimentRecord type for each entry', () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');
      writeFileSync(
        ledgerPath,
        '{"timestamp":"2024-01-01T00:00:00.000Z","branch":"test","commitHash":"abc","status":"success","metrics":{"acc":0.9}}\n'
      );

      const result = manager.getExperimentLog();

      expect(result[0]!).toHaveProperty('timestamp');
      expect(result[0]!).toHaveProperty('branch');
      expect(result[0]!).toHaveProperty('commitHash');
      expect(result[0]!).toHaveProperty('status');
      expect(result[0]!).toHaveProperty('metrics');
    });
  });

  describe('ExperimentRecord type', () => {
    it('should have correct shape for valid record', () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');
      const record: ExperimentRecord = {
        timestamp: '2024-01-15T10:30:00.000Z',
        branch: 'hypothesis/test',
        commitHash: 'abc123def456',
        status: 'success',
        metrics: { accuracy: 0.95, loss: 0.05, f1: 0.93 },
      };
      writeFileSync(ledgerPath, JSON.stringify(record) + '\n');

      const result = manager.getExperimentLog();

      expect(result[0]!.timestamp).toBe('2024-01-15T10:30:00.000Z');
      expect(result[0]!.branch).toBe('hypothesis/test');
      expect(result[0]!.commitHash).toBe('abc123def456');
      expect(result[0]!.status).toBe('success');
      expect(result[0]!.metrics).toEqual({ accuracy: 0.95, loss: 0.05, f1: 0.93 });
    });

    it('should support all status values', () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');

      for (const status of ['pending', 'success', 'failed'] as const) {
        const record: ExperimentRecord = {
          timestamp: new Date().toISOString(),
          branch: `hypothesis/${status}`,
          commitHash: 'abc',
          status,
          metrics: {},
        };
        writeFileSync(ledgerPath, JSON.stringify(record) + '\n');

        const result = manager.getExperimentLog();
        expect(result[0]!.status).toBe(status);
      }
    });

    it('should handle empty metrics', () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');
      const record: ExperimentRecord = {
        timestamp: '2024-01-01T00:00:00.000Z',
        branch: 'test',
        commitHash: 'abc',
        status: 'success',
        metrics: {},
      };
      writeFileSync(ledgerPath, JSON.stringify(record) + '\n');

      const result = manager.getExperimentLog();

      expect(result[0]!.metrics).toEqual({});
    });

    it('should handle numeric metrics', () => {
      const ledgerPath = join(testDir, 'experiments.jsonl');
      const record = {
        timestamp: '2024-01-01T00:00:00.000Z',
        branch: 'test',
        commitHash: 'abc',
        status: 'success',
        metrics: { count: 42, ratio: 0.5 },
      };
      writeFileSync(ledgerPath, JSON.stringify(record) + '\n');

      const result = manager.getExperimentLog();

      expect(result[0]!['metrics']['count']).toBe(42);
      expect(result[0]!['metrics']['ratio']).toBe(0.5);
    });
  });

  describe('IExperimentManager interface', () => {
    it('should implement IExperimentManager interface', () => {
      // This ensures the class implements the interface contract
      const managerTyped: IExperimentManager = manager;

      expect(managerTyped.createBranch).toBeDefined();
      expect(managerTyped.logExperiment).toBeDefined();
      expect(managerTyped.mergeBranch).toBeDefined();
      expect(managerTyped.getCurrentBranch).toBeDefined();
      expect(managerTyped.getExperimentLog).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle hypothesis that starts with special chars', async () => {
      const branch = await manager.createBranch('main', '...leading special');

      // Should not have leading hyphens
      expect(branch).not.toMatch(/^hypothesis\/-+/);
    });

    it('should handle hypothesis that ends with special chars', async () => {
      const branch = await manager.createBranch('main', 'trailing special...');

      // Should not have trailing hyphens
      const parts = branch.split('-');
      expect(parts[parts.length - 1]).not.toBe('');
    });

    it('should handle hypothesis with only special chars', async () => {
      const branch = await manager.createBranch('main', '...###...');

      // Should produce valid branch name
      expect(branch).toMatch(/^hypothesis\/\d{4}-\d{2}-\d{2}T/);
    });

    it('should handle multiple concurrent logExperiment calls', async () => {
      mockGitInstance.status.mockResolvedValue({ current: 'main' });

      const promises = Array.from({ length: 5 }, (_, i) =>
        manager.logExperiment(`hypothesis/branch-${i}`, 'pending', { index: i })
      );

      await Promise.all(promises);

      const records = manager.getExperimentLog();
      expect(records.length).toBe(5);
    });
  });
});
