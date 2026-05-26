import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateResult,
  MergeQueue,
  processQueue,
  MergeConflictError,
  EvalResultSchema,
  readEvalResult,
  createDefaultEvalConfig,
  type EvalResult,
} from '../tournamentRatchet';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Helper to create temp eval result files
function createTempEvalResult(
  metricValue: number,
  branch: string = 'hypothesis/test',
  extra: Partial<EvalResult> = {}
): string {
  const dir = join(tmpdir(), `aesop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  const result: EvalResult = {
    timestamp: new Date().toISOString(),
    branch,
    commitHash: 'abc123',
    primaryMetric: metricValue,
    metrics: {
      primaryMetric: metricValue,
      accuracy: metricValue,
      loss: 1 - metricValue,
    },
    ...extra,
  };

  const filePath = join(dir, 'eval_result.json');
  writeFileSync(filePath, JSON.stringify(result));
  return filePath;
}

// Cleanup helper
function cleanupPath(filePath: string): void {
  const dir = join(tmpdir(), filePath).replace('/eval_result.json', '');
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('EvalResultSchema', () => {
  it('should parse valid eval result', () => {
    const valid = {
      timestamp: '2024-01-15T10:30:00.000Z',
      branch: 'hypothesis/test',
      commitHash: 'abc123',
      primaryMetric: 0.95,
      metrics: { accuracy: 0.95, loss: 0.05 },
    };

    const result = EvalResultSchema.parse(valid);
    expect(result.primaryMetric).toBe(0.95);
    expect(result.metrics['accuracy']).toBe(0.95);
  });

  it('should reject invalid timestamp', () => {
    const invalid = {
      timestamp: 'not-a-date',
      branch: 'test',
      commitHash: 'abc',
      primaryMetric: 0.5,
      metrics: {},
    };

    expect(() => EvalResultSchema.parse(invalid)).toThrow();
  });

  it('should accept optional status field', () => {
    const withStatus = {
      timestamp: '2024-01-15T10:30:00.000Z',
      branch: 'test',
      commitHash: 'abc',
      primaryMetric: 0.5,
      metrics: {},
      status: 'success' as const,
    };

    const result = EvalResultSchema.parse(withStatus);
    expect(result.status).toBe('success');
  });
});

describe('evaluateResult', () => {
  it('should return true when new metric is higher (maximize=true)', async () => {
    const baseline = 0.8;
    const newMetric = 0.9;
    const filePath = createTempEvalResult(newMetric);

    try {
      const result = await evaluateResult(filePath, baseline, 'primaryMetric', true);
      expect(result).toBe(true);
    } finally {
      cleanupPath(filePath);
    }
  });

  it('should return false when new metric is lower (maximize=true)', async () => {
    const baseline = 0.95;
    const newMetric = 0.8;
    const filePath = createTempEvalResult(newMetric);

    try {
      const result = await evaluateResult(filePath, baseline, 'primaryMetric', true);
      expect(result).toBe(false);
    } finally {
      cleanupPath(filePath);
    }
  });

  it('should return false when new metric equals baseline', async () => {
    const baseline = 0.9;
    const newMetric = 0.9;
    const filePath = createTempEvalResult(newMetric);

    try {
      const result = await evaluateResult(filePath, baseline, 'primaryMetric', true);
      expect(result).toBe(false); // Strictly better required
    } finally {
      cleanupPath(filePath);
    }
  });

  it('should return true when new metric is lower (maximize=false)', async () => {
    const baseline = 0.1; // e.g., loss metric
    const newMetric = 0.05;
    const filePath = createTempEvalResult(newMetric);

    try {
      const result = await evaluateResult(filePath, baseline, 'primaryMetric', false);
      expect(result).toBe(true);
    } finally {
      cleanupPath(filePath);
    }
  });

  it('should use custom metric key when specified', async () => {
    const baseline = 0.5;
    const filePath = createTempEvalResult(0.9, 'test', {
      metrics: {
        primaryMetric: 0.3,
        customMetric: 0.95,
      },
    });

    try {
      const result = await evaluateResult(filePath, baseline, 'customMetric', true);
      expect(result).toBe(true);
    } finally {
      cleanupPath(filePath);
    }
  });

  it('should throw when file does not exist', async () => {
    await expect(evaluateResult('/nonexistent/path/eval_result.json', 0.5)).rejects.toThrow(
      'Result file not found'
    );
  });

  it('should throw on invalid JSON', async () => {
    const dir = join(tmpdir(), `aesop-test-invalid-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'eval_result.json');
    writeFileSync(filePath, 'not valid json');

    try {
      await expect(evaluateResult(filePath, 0.5)).rejects.toThrow();
    } finally {
      cleanupPath(filePath);
    }
  });
});

describe('MergeQueue', () => {
  let queue: MergeQueue;

  beforeEach(() => {
    queue = new MergeQueue();
  });

  it('should start empty', () => {
    expect(queue.isEmpty).toBe(true);
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeNull();
    expect(queue.shift()).toBeNull();
  });

  it('should add branches to the queue', () => {
    queue.add('hypothesis/test-1', 0.9, '/path/1');
    expect(queue.size).toBe(1);
    expect(queue.isEmpty).toBe(false);
  });

  it('should sort by metric value descending when maximize is true', () => {
    queue.add('branch-1', 0.7, '/path/1');
    queue.add('branch-2', 0.9, '/path/2');
    queue.add('branch-3', 0.8, '/path/3');

    expect(queue.peek()).toBe('branch-2'); // Highest metric first
  });

  it('should sort by metric value ascending when maximize is false', () => {
    const ascQueue = new MergeQueue(false);
    ascQueue.add('branch-1', 0.7, '/path/1');
    ascQueue.add('branch-2', 0.9, '/path/2');
    ascQueue.add('branch-3', 0.8, '/path/3');

    expect(ascQueue.peek()).toBe('branch-1'); // Lowest metric first
  });

  it('should return entries in order', () => {
    queue.add('branch-low', 0.5, '/path/low');
    queue.add('branch-high', 0.95, '/path/high');
    queue.add('branch-mid', 0.75, '/path/mid');

    const entries = queue.getEntries();
    expect(entries[0]?.branchName).toBe('branch-high');
    expect(entries[1]?.branchName).toBe('branch-mid');
    expect(entries[2]?.branchName).toBe('branch-low');
  });

  it('should shift entries in order', () => {
    queue.add('first', 0.9, '/path/first');
    queue.add('second', 0.8, '/path/second');

    expect(queue.shift()).toBe('first');
    expect(queue.shift()).toBe('second');
    expect(queue.isEmpty).toBe(true);
  });

  it('should clear all entries', () => {
    queue.add('branch-1', 0.9, '/path/1');
    queue.add('branch-2', 0.8, '/path/2');

    queue.clear();

    expect(queue.isEmpty).toBe(true);
    expect(queue.size).toBe(0);
  });
});

describe('processQueue', () => {
  it('should merge all branches when all succeed', async () => {
    const queue = new MergeQueue();
    queue.add('branch-1', 0.95, '/path/1');
    queue.add('branch-2', 0.9, '/path/2');

    const mockStateManager = {
      mergeBranch: vi.fn().mockResolvedValue(true),
    };

    const result = await processQueue(queue, mockStateManager, 'main');

    expect(result.merged).toEqual(['branch-1', 'branch-2']);
    expect(result.failed).toEqual([]);
    expect(mockStateManager.mergeBranch).toHaveBeenCalledTimes(2);
    expect(mockStateManager.mergeBranch).toHaveBeenNthCalledWith(1, 'branch-1', 'main');
    expect(mockStateManager.mergeBranch).toHaveBeenNthCalledWith(2, 'branch-2', 'main');
  });

  it('should stop and throw MergeConflictError on conflict', async () => {
    const queue = new MergeQueue();
    queue.add('branch-1', 0.95, '/path/1');
    queue.add('branch-2', 0.9, '/path/2');

    const mockStateManager = {
      mergeBranch: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false), // Conflict on second
    };

    await expect(processQueue(queue, mockStateManager, 'main')).rejects.toThrow(MergeConflictError);

    expect(mockStateManager.mergeBranch).toHaveBeenCalledTimes(2);
  });

  it('should not throw when queue is empty', async () => {
    const queue = new MergeQueue();
    const mockStateManager = {
      mergeBranch: vi.fn(),
    };

    const result = await processQueue(queue, mockStateManager, 'main');

    expect(result.merged).toEqual([]);
    expect(mockStateManager.mergeBranch).not.toHaveBeenCalled();
  });

  it('should process in metric order', async () => {
    const queue = new MergeQueue();
    queue.add('low-priority', 0.5, '/path/low');
    queue.add('high-priority', 0.95, '/path/high');
    queue.add('medium-priority', 0.75, '/path/med');

    const callOrder: string[] = [];
    const mockStateManager = {
      mergeBranch: vi.fn().mockImplementation(async (branch: string) => {
        callOrder.push(branch);
        return true;
      }),
    };

    await processQueue(queue, mockStateManager, 'main');

    expect(callOrder).toEqual(['high-priority', 'medium-priority', 'low-priority']);
  });
});

describe('MergeConflictError', () => {
  it('should have correct name and message', () => {
    const error = new MergeConflictError('test-branch');
    expect(error.name).toBe('MergeConflictError');
    expect(error.message).toContain('test-branch');
    expect(error.branchName).toBe('test-branch');
  });

  it('should accept custom message', () => {
    const error = new MergeConflictError('branch-123', 'Custom error message');
    expect(error.message).toBe('Custom error message');
    expect(error.branchName).toBe('branch-123');
  });

  it('should be an instance of Error', () => {
    const error = new MergeConflictError('test');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof MergeConflictError).toBe(true);
  });
});

describe('readEvalResult', () => {
  it('should return parsed result for valid file', () => {
    const filePath = createTempEvalResult(0.85, 'experiment-1');

    try {
      const result = readEvalResult(filePath);
      expect(result).not.toBeNull();
      expect(result!.primaryMetric).toBe(0.85);
      expect(result!.branch).toBe('experiment-1');
    } finally {
      cleanupPath(filePath);
    }
  });

  it('should return null for non-existent file', () => {
    const result = readEvalResult('/nonexistent/path.json');
    expect(result).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    const dir = join(tmpdir(), `aesop-test-read-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'eval_result.json');
    writeFileSync(filePath, 'invalid json');

    try {
      const result = readEvalResult(filePath);
      expect(result).toBeNull();
    } finally {
      cleanupPath(filePath);
    }
  });
});

describe('createDefaultEvalConfig', () => {
  it('should create config with correct defaults', () => {
    const config = createDefaultEvalConfig(0.5);

    expect(config.baselineMetric).toBe(0.5);
    expect(config.targetMetricKey).toBe('primaryMetric');
    expect(config.maximize).toBe(true);
  });

  it('should accept custom values', () => {
    const config = createDefaultEvalConfig(0.3, 'customMetric', false);

    expect(config.baselineMetric).toBe(0.3);
    expect(config.targetMetricKey).toBe('customMetric');
    expect(config.maximize).toBe(false);
  });
});
