import { describe, expect, it, vi, beforeEach } from 'vitest';
import { longRunPhaseExecutor } from '../../../campaign/phases/longRunPhase';
import type { LongRunPlan } from '../../../campaign/types';
import type { PhaseContext } from '../../../campaign/phases/types';

const mockRunProgrammaticTrial = vi.hoisted(() => vi.fn());

vi.mock('../../../campaign/phases/baselinePhase', () => ({
  runProgrammaticTrial: mockRunProgrammaticTrial,
}));

vi.mock('../../../validateContract', () => ({
  runWithValidation: vi.fn(),
}));

describe('longRunPhaseExecutor', () => {
  const ctx: PhaseContext = {
    workspacePath: '/workspace/test',
    validateCmd: './aesop_validate.sh',
    metricKey: 'accuracy',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunProgrammaticTrial.mockResolvedValue({
      success: true,
      metrics: { accuracy: 0.95 },
      durationMs: 100,
    });
  });

  describe('execute', () => {
    it('returns completed status with metrics when validation succeeds', async () => {
      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: { '--lr': '0.001' },
        epochs: 100,
      };

      const mockMetrics = { accuracy: 0.92, loss: 0.08 };
      mockRunProgrammaticTrial.mockResolvedValue({
        success: true,
        metrics: mockMetrics,
        durationMs: 500,
      });

      const result = await longRunPhaseExecutor.execute(plan, ctx);

      expect(result.kind).toBe('long_run');
      expect(result.status).toBe('completed');
      expect(result.metrics).toEqual(mockMetrics);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('returns failed status with error when validation fails', async () => {
      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: { '--lr': '0.001' },
        epochs: 100,
      };

      const mockError = 'Validation script exited with code 1';
      mockRunProgrammaticTrial.mockResolvedValue({
        success: false,
        metrics: {},
        error: mockError,
        durationMs: 100,
      });

      const result = await longRunPhaseExecutor.execute(plan, ctx);

      expect(result.kind).toBe('long_run');
      expect(result.status).toBe('failed');
      expect(result.metrics).toEqual({});
      expect(result.error).toBe(mockError);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('appends --epochs flag with the epoch count from plan', async () => {
      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: {},
        epochs: 500,
      };

      await longRunPhaseExecutor.execute(plan, ctx);

      expect(mockRunProgrammaticTrial).toHaveBeenCalledTimes(1);
      expect(mockRunProgrammaticTrial).toHaveBeenCalledWith(ctx, {
        '--epochs': '500',
      });
    });

    it('forwards best args from plan to validation command', async () => {
      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: { '--lr': '0.001', '--batch-size': '32' },
        epochs: 50,
      };

      await longRunPhaseExecutor.execute(plan, ctx);

      expect(mockRunProgrammaticTrial).toHaveBeenCalledTimes(1);
      expect(mockRunProgrammaticTrial).toHaveBeenCalledWith(ctx, {
        '--lr': '0.001',
        '--batch-size': '32',
        '--epochs': '50',
      });
    });

    it('combines best args with --epochs flag correctly', async () => {
      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: { '--lr': '0.0005', '--optimizer': 'adam', '--dropout': '0.3' },
        epochs: 200,
      };

      await longRunPhaseExecutor.execute(plan, ctx);

      expect(mockRunProgrammaticTrial).toHaveBeenCalledWith(ctx, {
        '--lr': '0.0005',
        '--optimizer': 'adam',
        '--dropout': '0.3',
        '--epochs': '200',
      });
    });

    it('handles empty best args gracefully', async () => {
      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: {},
        epochs: 1000,
      };

      await longRunPhaseExecutor.execute(plan, ctx);

      expect(mockRunProgrammaticTrial).toHaveBeenCalledWith(ctx, {
        '--epochs': '1000',
      });
    });

    it('includes durationMs in result', async () => {
      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: {},
        epochs: 100,
      };

      mockRunProgrammaticTrial.mockResolvedValue({
        success: true,
        metrics: { accuracy: 0.9 },
        durationMs: 42,
      });

      const before = Date.now();
      const result = await longRunPhaseExecutor.execute(plan, ctx);
      const after = Date.now();

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThanOrEqual(after - before + 10);
    });

    it('passes ctx through to runProgrammaticTrial', async () => {
      const customCtx: PhaseContext = {
        workspacePath: '/custom/workspace',
        validateCmd: './custom_validate.sh',
        metricKey: 'f1',
      };

      const plan: LongRunPlan = {
        kind: 'long_run',
        bestArgs: { '--lr': '0.01' },
        epochs: 50,
      };

      mockRunProgrammaticTrial.mockResolvedValue({
        success: true,
        metrics: { f1: 0.88 },
        durationMs: 100,
      });

      await longRunPhaseExecutor.execute(plan, customCtx);

      expect(mockRunProgrammaticTrial).toHaveBeenCalledWith(customCtx, {
        '--lr': '0.01',
        '--epochs': '50',
      });
    });
  });
});

/*
 * Note: runProgrammaticTrial re-export is tested via runProgrammaticTrial.test.ts
 * and indirectly through longRunPhaseExecutor tests above.
 */
