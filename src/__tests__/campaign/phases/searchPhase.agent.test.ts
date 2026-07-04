import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchPhaseExecutor } from '../../../campaign/phases/searchPhase.js';
import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { PhaseContext } from '../../../campaign/phases/types.js';

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual('@earendil-works/pi-coding-agent');
  return {
    ...actual,
    createAgentSession: vi.fn(),
    SessionManager: {
      inMemory: vi.fn(),
    },
    DefaultResourceLoader: vi.fn(),
  };
});

vi.mock('../../../campaign/phases/types.js', async () => {
  const actual = await vi.importActual('../../../campaign/phases/types.js');
  return {
    ...actual,
    runProgrammaticTrial: vi.fn().mockResolvedValue({
      success: true,
      metrics: { accuracy: 0.9 },
    }),
  };
});

describe('searchPhaseExecutor (agent_guided)', () => {
  const mockCtx: PhaseContext = {
    workspacePath: '/tmp/workspace',
    validateCmd: './validate.sh',
    metricKey: 'accuracy',
    maximize: true,
  };

  const mockPlan = {
    kind: 'search' as const,
    strategy: 'agent_guided' as const,
    searchSpace: { lr: ['0.01', '0.001'] },
    maxTrials: 2,
  };

  let mockSession: {
    prompt: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSession = {
      prompt: vi.fn().mockResolvedValue({}),
      dispose: vi.fn(),
    };

    (createAgentSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: mockSession,
    });

    (DefaultResourceLoader as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
      return {
        reload: vi.fn().mockResolvedValue(undefined),
      };
    });
  });

  it('should execute the agent loop and dispose the session', async () => {
    const result = await searchPhaseExecutor.execute(mockPlan, mockCtx);

    expect(result.kind).toBe('search');
    expect(result.status).toBe('completed');
    expect(mockSession.prompt).toHaveBeenCalled();
    expect(mockSession.dispose).toHaveBeenCalled();
  });
});
