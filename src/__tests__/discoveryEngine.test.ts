import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExecutionAdapter,
  SlurmAdapter,
  K8sAdapter,
  LocalAdapter,
  getActiveAdapter,
} from '../discoveryEngine';

describe('ExecutionAdapter Interface', () => {
  it('should have correct method signatures', () => {
    const adapter: ExecutionAdapter = new SlurmAdapter();
    expect(typeof adapter.submitJob).toBe('function');
    expect(typeof adapter.checkStatus).toBe('function');
  });
});

describe('SlurmAdapter', () => {
  let adapter: SlurmAdapter;

  beforeEach(() => {
    adapter = new SlurmAdapter();
  });

  it('should return a job ID with slurm prefix', async () => {
    const jobId = await adapter.submitJob('feat/test', 'echo hello');
    expect(jobId).toMatch(/^slurm-[\w-]+$/);
  });

  it('should return completed status with file path', async () => {
    const jobId = await adapter.submitJob('feat/test', 'echo hello');
    const status = await adapter.checkStatus(jobId);
    expect(status.status).toBe('completed');
    expect(status.filePath).toBe(`/tmp/${jobId}/eval_result.json`);
  });

  it('should handle different branch names', async () => {
    const jobId1 = await adapter.submitJob('feat/branch-a', 'cmd1');
    const jobId2 = await adapter.submitJob('fix/branch-b', 'cmd2');
    expect(jobId1).not.toBe(jobId2);
  });

  it('should generate unique job IDs', async () => {
    const jobId1 = await adapter.submitJob('feat/test', 'cmd');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const jobId2 = await adapter.submitJob('feat/test', 'cmd');
    expect(jobId1).not.toBe(jobId2);
  });
});

describe('K8sAdapter', () => {
  let adapter: K8sAdapter;

  beforeEach(() => {
    adapter = new K8sAdapter();
  });

  it('should return a job ID with k8s prefix', async () => {
    const jobId = await adapter.submitJob('feat/test', 'kubectl run test');
    expect(jobId).toMatch(/^k8s-[\w-]+$/);
  });

  it('should return completed status with file path', async () => {
    const jobId = await adapter.submitJob('feat/test', 'kubectl run test');
    const status = await adapter.checkStatus(jobId);
    expect(status.status).toBe('completed');
    expect(status.filePath).toBe(`/tmp/${jobId}/eval_result.json`);
  });

  it('should have different prefix than SlurmAdapter', async () => {
    const slurmId = await new SlurmAdapter().submitJob('feat/test', 'cmd');
    const k8sId = await adapter.submitJob('feat/test', 'cmd');
    expect(slurmId.startsWith('slurm-')).toBe(true);
    expect(k8sId.startsWith('k8s-')).toBe(true);
  });
});

describe('LocalAdapter', () => {
  let adapter: LocalAdapter;

  beforeEach(() => {
    adapter = new LocalAdapter();
  });

  it('should return a job ID with local prefix', async () => {
    const jobId = await adapter.submitJob('feat/test', 'node script.js');
    expect(jobId).toMatch(/^local-[\w-]+$/);
  });

  it('should return unknown status for unknown job ID', async () => {
    const status = await adapter.checkStatus('unknown-job-id');
    expect(status.status).toBe('unknown');
    expect(status.filePath).toBe('/tmp/unknown-job-id/eval_result.json');
  });

  it('should support killJob method', () => {
    adapter.killJob('test-job-id');
    // Should not throw
    expect(true).toBe(true);
  });
});

describe('getActiveAdapter - Adapter Priority', () => {
  it('should return an adapter that implements ExecutionAdapter', async () => {
    const adapter = await getActiveAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.submitJob).toBe('function');
    expect(typeof adapter.checkStatus).toBe('function');
  });

  it('should return one of the known adapter types', async () => {
    const adapter = await getActiveAdapter();
    const isKnownAdapter =
      adapter instanceof SlurmAdapter ||
      adapter instanceof K8sAdapter ||
      adapter instanceof LocalAdapter;
    expect(isKnownAdapter).toBe(true);
  });

  it('should return adapters that can submit jobs', async () => {
    const adapter = await getActiveAdapter();
    const jobId = await adapter.submitJob('test-branch', 'echo test');
    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);
  });

  it('should return adapters that can check status', async () => {
    const adapter = await getActiveAdapter();
    const jobId = await adapter.submitJob('test-branch', 'echo test');
    const status = await adapter.checkStatus(jobId);
    expect(status).toHaveProperty('status');
    expect(typeof status.status).toBe('string');
  });
});

describe('File Path Generation', () => {
  it('should generate consistent eval_result.json paths', async () => {
    const jobId = 'test-job-123';

    const slurmAdapter = new SlurmAdapter();
    const slurmStatus = await slurmAdapter.checkStatus(jobId);

    const k8sAdapter = new K8sAdapter();
    const k8sStatus = await k8sAdapter.checkStatus(jobId);

    expect(slurmStatus.filePath).toBe(`/tmp/${jobId}/eval_result.json`);
    expect(k8sStatus.filePath).toBe(`/tmp/${jobId}/eval_result.json`);
  });

  it('should generate unique paths per job', async () => {
    const adapter = new SlurmAdapter();
    const jobId1 = await adapter.submitJob('branch1', 'cmd');
    const jobId2 = await adapter.submitJob('branch2', 'cmd');

    const status1 = await adapter.checkStatus(jobId1);
    const status2 = await adapter.checkStatus(jobId2);

    expect(status1.filePath).not.toBe(status2.filePath);
  });
});
