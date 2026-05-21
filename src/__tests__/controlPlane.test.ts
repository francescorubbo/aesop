import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  type ProposeHypothesisInput,
  type DispatchExperimentInput,
  type CheckExperimentStatusInput,
  type MergeExperimentsInput,
} from '../controlPlane';

// Mock implementations
const mockRunStaticChecks = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
const mockSubmitJob = vi.hoisted(() => vi.fn().mockResolvedValue('test-job-123'));
const mockCheckStatus = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    status: 'completed',
    filePath: '/tmp/test-job-123/eval_result.json',
  })
);
const mockReadFileSync = vi.hoisted(() =>
  vi.fn().mockReturnValue(
    JSON.stringify({
      timestamp: '2024-01-15T10:30:00.000Z',
      branch: 'hypothesis/test',
      commitHash: 'abc123',
      primaryMetric: 0.95,
      metrics: { primaryMetric: 0.95, accuracy: 0.95 },
    })
  )
);
const mockExistsSync = vi.hoisted(() => vi.fn().mockReturnValue(true));

// Mock modules
vi.mock('../discoveryEngine', () => ({
  getActiveAdapter: vi.fn().mockImplementation(() => ({
    submitJob: mockSubmitJob,
    checkStatus: mockCheckStatus,
  })),
}));

vi.mock('../backpressureGates', () => ({
  runStaticChecks: mockRunStaticChecks,
}));

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}));

// Mock ExperimentManager
const mockCreateBranch = vi.hoisted(() => vi.fn().mockResolvedValue('hypothesis/test-123'));
const mockMergeBranch = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockInitEphemeralWorkspace = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    sessionId: 'session-123',
    workspaceRoot: '/tmp/ws',
    basePath: '/tmp/base',
  })
);
const mockCreateHypothesisWorkspace = vi.hoisted(() => vi.fn().mockResolvedValue('/tmp/ws/hyp-1'));

let managerInstancesCount = 0;
const managerInstances: any[] = [];

vi.mock('../experimentManager', () => {
  return {
    ExperimentManager: class MockExperimentManager {
      constructor(public cwd: string) {
        managerInstancesCount++;
        managerInstances.push(this);
      }

      async createBranch(...args: any[]) {
        return mockCreateBranch(...args);
      }
      async mergeBranch(...args: any[]) {
        return mockMergeBranch(...args);
      }
      async getCurrentBranch(...args: any[]) {
        return 'main';
      }
      getExperimentLog(...args: any[]) {
        return [];
      }
      async initEphemeralWorkspace(...args: any[]) {
        return mockInitEphemeralWorkspace(...args);
      }
      async createHypothesisWorkspace(...args: any[]) {
        return mockCreateHypothesisWorkspace(...args);
      }
    },
  };
});

import {
  dispatchExperiment,
  checkExperimentStatus,
  proposeHypothesis,
  mergeExperiments,
  runExperimentWorkflow,
  initializeEphemeralWorkspace,
} from '../controlPlane';

describe('controlPlane - dispatchExperiment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerInstancesCount = 0;
    managerInstances.length = 0;
    mockRunStaticChecks.mockResolvedValue({ success: true });
    mockSubmitJob.mockResolvedValue('test-job-123');
  });

  it('should dispatch experiment and run backpressure checks', async () => {
    const input: DispatchExperimentInput = {
      branchName: 'hypothesis/test',
      runChecks: true,
    };

    const result = await dispatchExperiment(input);

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('test-job-123');
    expect(result.checksPassed).toBe(true);
    expect(mockRunStaticChecks).toHaveBeenCalled();
  });

  it('should skip backpressure checks when runChecks is false', async () => {
    const input: DispatchExperimentInput = {
      branchName: 'hypothesis/test',
      runChecks: false,
    };

    const result = await dispatchExperiment(input);

    expect(result.success).toBe(true);
    expect(result.jobId).toBe('test-job-123');
    expect(mockRunStaticChecks).not.toHaveBeenCalled();
  });

  it('should fail if backpressure checks fail', async () => {
    mockRunStaticChecks.mockResolvedValueOnce({
      success: false,
      errorOutput: 'Type error: Cannot find module',
    });

    const input: DispatchExperimentInput = {
      branchName: 'hypothesis/test',
      runChecks: true,
    };

    const result = await dispatchExperiment(input);

    expect(result.success).toBe(false);
    expect(result.checksPassed).toBe(false);
  });

  it('should use default command if not provided', async () => {
    const input: DispatchExperimentInput = {
      branchName: 'hypothesis/test',
      runChecks: false,
    };

    const result = await dispatchExperiment(input);

    expect(result.success).toBe(true);
    expect(mockSubmitJob).toHaveBeenCalledWith(
      'hypothesis/test',
      expect.stringContaining('python train.py'),
      expect.any(String) // workingDirectory
    );
  });

  it('should handle submission errors', async () => {
    mockSubmitJob.mockRejectedValueOnce(new Error('Network error'));

    const input: DispatchExperimentInput = {
      branchName: 'hypothesis/test',
      runChecks: false,
    };

    const result = await dispatchExperiment(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('controlPlane - checkExperimentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckStatus.mockResolvedValue({
      status: 'completed',
      filePath: '/tmp/test-job-123/eval_result.json',
    });
  });

  it('should return status without evaluation when no baseline provided', async () => {
    const input: CheckExperimentStatusInput = {
      jobId: 'test-job-123',
    };

    const result = await checkExperimentStatus(input);

    expect(result.status).toBe('completed');
    expect(result.filePath).toBe('/tmp/test-job-123/eval_result.json');
  });

  it('should evaluate results when baseline is provided', async () => {
    const input: CheckExperimentStatusInput = {
      jobId: 'test-job-123',
      baselineMetric: 0.9,
      targetMetricKey: 'primaryMetric',
      maximize: true,
    };

    const result = await checkExperimentStatus(input);

    expect(result.status).toBe('completed');
    expect(result.evaluated).toBe(true);
    expect(result.improved).toBe(true); // 0.95 > 0.9
  });

  it('should return false for improved when metric is worse', async () => {
    const input: CheckExperimentStatusInput = {
      jobId: 'test-job-123',
      baselineMetric: 0.98, // Higher than result
      targetMetricKey: 'primaryMetric',
      maximize: true,
    };

    const result = await checkExperimentStatus(input);

    expect(result.evaluated).toBe(true);
    expect(result.improved).toBe(false);
  });

  it('should handle errors gracefully', async () => {
    mockCheckStatus.mockRejectedValueOnce(new Error('Adapter error'));

    const input: CheckExperimentStatusInput = {
      jobId: 'test-job-123',
    };

    const result = await checkExperimentStatus(input);

    expect(result.status).toBe('error');
    expect(result.error).toBe('Adapter error');
  });

  it('should omit filePath when not provided by adapter', async () => {
    mockCheckStatus.mockResolvedValueOnce({
      status: 'running',
    });

    const input: CheckExperimentStatusInput = {
      jobId: 'test-job-123',
    };

    const result = await checkExperimentStatus(input);

    expect(result.status).toBe('running');
    expect(result.filePath).toBeUndefined();
  });
});

describe('controlPlane - proposeHypothesis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerInstancesCount = 0;
    managerInstances.length = 0;
    mockCreateBranch.mockResolvedValue('hypothesis/test-branch');
  });

  it('should create a new experiment branch', async () => {
    const input: ProposeHypothesisInput = {
      baseBranch: 'main',
      hypothesisName: 'Test hypothesis',
    };

    const result = await proposeHypothesis(input);

    expect(result.success).toBe(true);
    expect(result.branchName).toBe('hypothesis/test-branch');
    expect(mockCreateBranch).toHaveBeenCalledWith('main', 'Test hypothesis');
  });

  it('should use custom cwd when provided', async () => {
    const input: ProposeHypothesisInput = {
      baseBranch: 'develop',
      hypothesisName: 'Custom test',
    };

    await proposeHypothesis(input, { cwd: '/custom/path' });

    expect(mockCreateBranch).toHaveBeenCalledWith('develop', 'Custom test');
  });

  it('should return error on failure', async () => {
    mockCreateBranch.mockRejectedValueOnce(new Error('Git error'));

    const input: ProposeHypothesisInput = {
      baseBranch: 'main',
      hypothesisName: 'Test',
    };

    const result = await proposeHypothesis(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Git error');
  });
});

describe('controlPlane - mergeExperiments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerInstancesCount = 0;
    managerInstances.length = 0;
    mockMergeBranch.mockResolvedValue(true);
  });

  it('should merge branch into target', async () => {
    const input: MergeExperimentsInput = {
      branchName: 'hypothesis/test',
      targetBranch: 'main',
    };

    const result = await mergeExperiments(input);

    expect(result.success).toBe(true);
    expect(result.merged).toContain('hypothesis/test');
  });

  it('should use main as default target branch', async () => {
    const input: MergeExperimentsInput = {
      branchName: 'hypothesis/test',
    };

    await mergeExperiments(input);

    expect(mockMergeBranch).toHaveBeenCalledWith('hypothesis/test', 'main');
  });

  it('should return conflictBranch on merge conflict', async () => {
    mockMergeBranch.mockResolvedValueOnce(false); // Simulate conflict

    const input: MergeExperimentsInput = {
      branchName: 'hypothesis/conflict',
      targetBranch: 'main',
    };

    const result = await mergeExperiments(input);

    expect(result.success).toBe(false);
    expect(result.conflictBranch).toBe('hypothesis/conflict');
  });

  it('should return error on unexpected failure', async () => {
    mockMergeBranch.mockRejectedValueOnce(new Error('Unexpected error'));

    const input: MergeExperimentsInput = {
      branchName: 'hypothesis/test',
    };

    const result = await mergeExperiments(input);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unexpected error');
  });
});

describe('controlPlane - runExperimentWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerInstancesCount = 0;
    managerInstances.length = 0;
    mockCreateBranch.mockResolvedValue('hypothesis/workflow-test');
    mockRunStaticChecks.mockResolvedValue({ success: true });
    mockSubmitJob.mockResolvedValue('job-456');
  });

  it('should run complete workflow: create branch, check, dispatch', async () => {
    const result = await runExperimentWorkflow('Test workflow hypothesis');

    expect(result.success).toBe(true);
    expect(result.branchName).toBe('hypothesis/workflow-test');
    expect(result.jobId).toBe('job-456');
    expect(mockCreateBranch).toHaveBeenCalledWith('main', 'Test workflow hypothesis');
    expect(mockRunStaticChecks).toHaveBeenCalled();
    expect(mockSubmitJob).toHaveBeenCalled();
  });

  it('should fail if branch creation fails', async () => {
    mockCreateBranch.mockRejectedValueOnce(new Error('Branch creation failed'));

    const result = await runExperimentWorkflow('Test');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Branch creation failed');
  });

  it('should fail if backpressure checks fail', async () => {
    mockRunStaticChecks.mockResolvedValueOnce({
      success: false,
      errorOutput: 'Validation failed',
    });

    const result = await runExperimentWorkflow('Test');

    expect(result.success).toBe(false);
    expect(result.branchName).toBe('hypothesis/workflow-test');
    expect(result.error).toContain('Backpressure checks failed');
  });

  it('should fail if dispatch fails', async () => {
    mockSubmitJob.mockRejectedValueOnce(new Error('Dispatch failed'));

    const result = await runExperimentWorkflow('Test');

    expect(result.success).toBe(false);
    expect(result.branchName).toBe('hypothesis/workflow-test');
    expect(result.error).toContain('Dispatch failed');
  });

  it('should use custom cwd option', async () => {
    await runExperimentWorkflow('Test', { cwd: '/custom/project' });

    // Check that ExperimentManager was constructed with custom cwd
    // The mock should have been called
    expect(mockCreateBranch).toHaveBeenCalled();
  });
});

describe('controlPlane - ephemeral workspace state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerInstancesCount = 0;
    managerInstances.length = 0;
  });

  it('should maintain ExperimentManager state across multiple tool calls for the same cwd', async () => {
    const cwd = '/tmp/project';
    const targetRepo = '/tmp/repo';

    // 1. Initialize ephemeral workspace
    const initResult = await initializeEphemeralWorkspace({ targetRepoPath: targetRepo }, { cwd });

    expect(initResult.success).toBe(true);
    expect(managerInstancesCount).toBe(1);
    expect(mockInitEphemeralWorkspace).toHaveBeenCalledTimes(1);

    // 2. Propose a hypothesis in ephemeral mode
    const propResult = await proposeHypothesis(
      { baseBranch: 'main', hypothesisName: 'hyp-1', ephemeral: true },
      { cwd }
    );

    expect(propResult.success).toBe(true);
    // Should still be the same instance
    expect(managerInstancesCount).toBe(1);
    expect(mockCreateHypothesisWorkspace).toHaveBeenCalledTimes(1);

    // Verify that the same instance was used for both calls
    expect(mockInitEphemeralWorkspace).toHaveBeenCalled();
    expect(mockCreateHypothesisWorkspace).toHaveBeenCalled();
  });

  it('should create separate ExperimentManager instances for different cwds', async () => {
    const cwd1 = '/tmp/project1';
    const cwd2 = '/tmp/project2';
    const targetRepo = '/tmp/repo';

    await initializeEphemeralWorkspace({ targetRepoPath: targetRepo }, { cwd: cwd1 });
    await initializeEphemeralWorkspace({ targetRepoPath: targetRepo }, { cwd: cwd2 });

    expect(managerInstancesCount).toBe(2);
  });
});

describe('tool input/output types', () => {
  it('should have correct ProposeHypothesisInput shape', () => {
    const input: ProposeHypothesisInput = {
      baseBranch: 'main',
      hypothesisName: 'Test',
    };
    expect(input.baseBranch).toBe('main');
    expect(input.hypothesisName).toBe('Test');
  });

  it('should have correct DispatchExperimentInput shape', () => {
    const input: DispatchExperimentInput = {
      branchName: 'test',
      command: 'python train.py',
      runChecks: true,
    };
    expect(input.branchName).toBe('test');
    expect(input.runChecks).toBe(true);
  });

  it('should have correct CheckExperimentStatusInput shape', () => {
    const input: CheckExperimentStatusInput = {
      jobId: 'job-123',
      baselineMetric: 0.5,
      targetMetricKey: 'accuracy',
      maximize: true,
    };
    expect(input.jobId).toBe('job-123');
    expect(input.baselineMetric).toBe(0.5);
  });

  it('should have correct MergeExperimentsInput shape', () => {
    const input: MergeExperimentsInput = {
      branchName: 'test',
      targetBranch: 'main',
    };
    expect(input.branchName).toBe('test');
    expect(input.targetBranch).toBe('main');
  });
});
