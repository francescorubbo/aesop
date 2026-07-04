import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchPhaseExecutor } from '../../../campaign/phases/searchPhase.js';
import { runProgrammaticTrial } from '../../../campaign/phases/types.js';
import type { PhaseContext } from '../../../campaign/phases/types.js';
import type { SearchPlan } from '../../../campaign/types.js';
import type { ValidationResult } from '../../../validateContract.js';

vi.mock('../../../campaign/phases/types.js', async () => {
  const actual = await vi.importActual('../../../campaign/phases/types.js');
  return {
    ...actual,
    runProgrammaticTrial: vi.fn(),
  };
});

describe('searchPhaseExecutor', () => {
  let ctx: PhaseContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = {
      workspacePath: '/tmp/workspace',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maximize: true,
    };
  });

  it('should execute a grid search with the correct number of trials', async () => {
    const plan: SearchPlan = {
      kind: 'search',
      strategy: 'grid',
      searchSpace: {
        lr: ['0.01', '0.001'],
        batch: ['32', '64', '128'],
      },
    };

    const mockResult: ValidationResult = {
      success: true,
      metrics: { accuracy: 0.8 },
      durationMs: 100,
    };

    vi.mocked(runProgrammaticTrial).mockResolvedValue(mockResult);

    const result = await searchPhaseExecutor.execute(plan, ctx);

    expect(runProgrammaticTrial).toHaveBeenCalledTimes(6);
    expect(result.trialCount).toBe(6);
    expect(result.status).toBe('completed');
  });

  it('should execute a random search respecting maxTrials', async () => {
    const plan: SearchPlan = {
      kind: 'search',
      strategy: 'random',
      searchSpace: {
        lr: ['0.01', '0.001', '0.0001'],
        batch: ['32', '64', '128'],
      },
      maxTrials: 2,
    };

    const mockResult: ValidationResult = {
      success: true,
      metrics: { accuracy: 0.8 },
      durationMs: 100,
    };

    vi.mocked(runProgrammaticTrial).mockResolvedValue(mockResult);

    const result = await searchPhaseExecutor.execute(plan, ctx);

    expect(runProgrammaticTrial).toHaveBeenCalledTimes(2);
    expect(result.trialCount).toBe(2);
  });

  it('should rank results correctly based on maximize=true', async () => {
    const plan: SearchPlan = {
      kind: 'search',
      strategy: 'grid',
      searchSpace: {
        param: ['a', 'b', 'c'],
      },
    };

    const mockResults: ValidationResult[] = [
      { success: true, metrics: { accuracy: 0.5 }, durationMs: 100 },
      { success: true, metrics: { accuracy: 0.9 }, durationMs: 100 },
      { success: true, metrics: { accuracy: 0.7 }, durationMs: 100 },
    ];

    vi.mocked(runProgrammaticTrial)
      .mockResolvedValueOnce(mockResults[0] as ValidationResult)
      .mockResolvedValueOnce(mockResults[1] as ValidationResult)
      .mockResolvedValueOnce(mockResults[2] as ValidationResult);

    const result = await searchPhaseExecutor.execute(plan, ctx);

    expect(result.bestMetrics?.['accuracy']).toBe(0.9);
    expect(result.rankedConfigs[0]?.metrics['accuracy']).toBe(0.9);
    expect(result.rankedConfigs[2]?.metrics['accuracy']).toBe(0.5);
  });

  it('should rank results correctly based on maximize=false', async () => {
    ctx.maximize = false;
    const plan: SearchPlan = {
      kind: 'search',
      strategy: 'grid',
      searchSpace: {
        param: ['a', 'b', 'c'],
      },
    };

    const mockResults: ValidationResult[] = [
      { success: true, metrics: { accuracy: 0.5 }, durationMs: 100 },
      { success: true, metrics: { accuracy: 0.9 }, durationMs: 100 },
      { success: true, metrics: { accuracy: 0.7 }, durationMs: 100 },
    ];

    vi.mocked(runProgrammaticTrial)
      .mockResolvedValueOnce(mockResults[0] as ValidationResult)
      .mockResolvedValueOnce(mockResults[1] as ValidationResult)
      .mockResolvedValueOnce(mockResults[2] as ValidationResult);

    const result = await searchPhaseExecutor.execute(plan, ctx);

    expect(result.bestMetrics?.['accuracy']).toBe(0.5);
    expect(result.rankedConfigs[0]?.metrics['accuracy']).toBe(0.5);
    expect(result.rankedConfigs[2]?.metrics['accuracy']).toBe(0.9);
  });

  it('should handle failed trials by excluding them from ranked results', async () => {
    const plan: SearchPlan = {
      kind: 'search',
      strategy: 'grid',
      searchSpace: {
        param: ['a', 'b'],
      },
    };

    vi.mocked(runProgrammaticTrial)
      .mockResolvedValueOnce({ success: false, metrics: {}, error: 'Failed', durationMs: 100 })
      .mockResolvedValueOnce({ success: true, metrics: { accuracy: 0.8 }, durationMs: 100 });

    const result = await searchPhaseExecutor.execute(plan, ctx);

    expect(result.rankedConfigs).toHaveLength(1);
    expect(result.bestMetrics?.['accuracy']).toBe(0.8);
  });
});
