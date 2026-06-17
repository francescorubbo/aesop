import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runProgrammaticTrial, type PhaseContext } from '../../campaign/phases/types';
import { runWithValidation } from '../../validateContract';

vi.mock('../../validateContract', () => ({
  runWithValidation: vi.fn(),
}));

describe('runProgrammaticTrial', () => {
  const baseCtx: PhaseContext = {
    workspacePath: '/workspace/test',
    validateCmd: './aesop_validate.sh',
    metricKey: 'accuracy',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (runWithValidation as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      metrics: { accuracy: 0.95 },
      durationMs: 100,
    });
  });

  it('passes result through unchanged', async () => {
    const mockResult = {
      success: true,
      metrics: { accuracy: 0.9 },
      durationMs: 50,
    };
    (runWithValidation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const result = await runProgrammaticTrial(baseCtx, {});

    expect(result).toBe(mockResult);
  });

  it('calls runWithValidation with correct args for empty args', async () => {
    await runProgrammaticTrial(baseCtx, {});

    expect(runWithValidation).toHaveBeenCalledOnce();
    expect(runWithValidation).toHaveBeenCalledWith(
      '/workspace/test',
      './aesop_validate.sh',
      'accuracy'
    );
  });

  it('calls runWithValidation with correct args for single arg', async () => {
    await runProgrammaticTrial(baseCtx, { '--lr': '0.001' });

    expect(runWithValidation).toHaveBeenCalledOnce();
    expect(runWithValidation).toHaveBeenCalledWith(
      '/workspace/test',
      './aesop_validate.sh --lr 0.001',
      'accuracy'
    );
  });

  it('calls runWithValidation with correct args for multiple args', async () => {
    await runProgrammaticTrial(baseCtx, {
      '--lr': '0.001',
      '--epochs': '100',
      '--batch-size': '32',
    });

    expect(runWithValidation).toHaveBeenCalledOnce();
    expect(runWithValidation).toHaveBeenCalledWith(
      '/workspace/test',
      './aesop_validate.sh --lr 0.001 --epochs 100 --batch-size 32',
      'accuracy'
    );
  });

  it('handles missing metricKey in context', async () => {
    const ctxWithoutMetric: PhaseContext = {
      workspacePath: '/workspace/test',
      validateCmd: './aesop_validate.sh',
    };

    await runProgrammaticTrial(ctxWithoutMetric, {});

    expect(runWithValidation).toHaveBeenCalledWith(
      '/workspace/test',
      './aesop_validate.sh',
      undefined
    );
  });
});
