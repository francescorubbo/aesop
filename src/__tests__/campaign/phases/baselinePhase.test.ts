import { describe, expect, it, vi, beforeEach } from 'vitest';
import { baselinePhaseExecutor } from '../../../campaign/phases/baselinePhase';
import type { BaselinePlan } from '../../../campaign/types';
import type { PhaseContext } from '../../../campaign/phases/types';

const mockRunWithValidation = vi.hoisted(() => vi.fn());

vi.mock('../../../validateContract', () => ({
  runWithValidation: mockRunWithValidation,
}));

describe('baselinePhaseExecutor', () => {
  const plan: BaselinePlan = {
    kind: 'baseline',
    config: {},
  };

  const ctx: PhaseContext = {
    workspacePath: '/workspace/test',
    validateCmd: './aesop_validate.sh',
    metricKey: 'accuracy',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunWithValidation.mockResolvedValue({
      success: true,
      metrics: { accuracy: 0.95 },
      durationMs: 100,
    });
  });

  it('returns completed status with metrics when validation succeeds', async () => {
    const mockMetrics = { accuracy: 0.85, loss: 0.15 };
    mockRunWithValidation.mockResolvedValue({
      success: true,
      metrics: mockMetrics,
      durationMs: 100,
    });

    const result = await baselinePhaseExecutor.execute(plan, ctx);

    expect(result.kind).toBe('baseline');
    expect(result.status).toBe('completed');
    expect(result.metrics).toEqual(mockMetrics);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns failed status with error when validation fails', async () => {
    const mockError = 'Validation script exited with code 1';
    mockRunWithValidation.mockResolvedValue({
      success: false,
      metrics: {},
      error: mockError,
      durationMs: 50,
    });

    const result = await baselinePhaseExecutor.execute(plan, ctx);

    expect(result.kind).toBe('baseline');
    expect(result.status).toBe('failed');
    expect(result.metrics).toEqual({});
    expect(result.error).toBe(mockError);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('calls runWithValidation with no extra flags appended to validate command', async () => {
    await baselinePhaseExecutor.execute(plan, ctx);

    expect(mockRunWithValidation).toHaveBeenCalledTimes(1);
    expect(mockRunWithValidation).toHaveBeenCalledWith(
      '/workspace/test',
      './aesop_validate.sh',
      'accuracy'
    );
  });

  it('passes ctx.workspacePath and ctx.validateCmd through to runWithValidation', async () => {
    const customCtx: PhaseContext = {
      workspacePath: '/custom/workspace',
      validateCmd: './custom_validate.sh',
      metricKey: 'f1',
    };

    mockRunWithValidation.mockResolvedValue({
      success: true,
      metrics: { f1: 0.95 },
      durationMs: 75,
    });

    await baselinePhaseExecutor.execute(plan, customCtx);

    expect(mockRunWithValidation).toHaveBeenCalledWith(
      '/custom/workspace',
      './custom_validate.sh',
      'f1'
    );
  });

  it('includes durationMs in result', async () => {
    mockRunWithValidation.mockResolvedValue({
      success: true,
      metrics: { accuracy: 0.8 },
      durationMs: 42,
    });

    const before = Date.now();
    const result = await baselinePhaseExecutor.execute(plan, ctx);
    const after = Date.now();

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThanOrEqual(after - before + 10);
  });
});
