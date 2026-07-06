import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ScaffoldPhaseExecutor } from '../../../campaign/phases/scaffoldPhase.js';
import { PhaseContext } from '../../../campaign/phases/types.js';
import { ScaffoldPlan } from '../../../campaign/phases/scaffoldTypes.js';
import { createAgentSession, type AgentSession } from '@earendil-works/pi-coding-agent';

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual('@earendil-works/pi-coding-agent');
  return {
    ...actual,
    createAgentSession: vi.fn(),
  };
});

vi.mock('../../../validateContract.js', () => ({
  runWithValidation: vi.fn(),
}));

describe('ScaffoldPhaseExecutor', () => {
  let executor: ScaffoldPhaseExecutor;
  let mockSession: AgentSession;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new ScaffoldPhaseExecutor();
    mockSession = {
      prompt: vi.fn(),
      dispose: vi.fn(),
    } as unknown as AgentSession;
    (createAgentSession as unknown as Mock).mockResolvedValue({
      session: mockSession,
    });
  });

  it('should fail if agent does not call complete_sc scaffold', async () => {
    const plan: ScaffoldPlan = {
      hypothesis: 'Implement ResNet-50',
      maxIterations: 1,
    };
    const ctx: PhaseContext = {
      workspacePath: '/tmp/aesop-workspace',
      validateCmd: './aesop_validate.sh',
      metricKey: 'accuracy',
    };

    (mockSession.prompt as unknown as Mock).mockResolvedValue('I am working on it...');

    const result = await executor.execute(plan, ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Agent failed to call complete_scaffold');
  });
});
