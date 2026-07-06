/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { runCampaign } from '../../campaign/runCampaign';
import { checkCampaignRatchet } from '../../campaign/campaignRatchet';
import { baselinePhaseExecutor } from '../../campaign/phases/baselinePhase';
import { searchPhaseExecutor } from '../../campaign/phases/searchPhase';

// Mock the Pi SDK session
const { mockSession, MockDefaultResourceLoader } = vi.hoisted(() => {
  class MockDefaultResourceLoader {
    reload = vi.fn().mockResolvedValue(undefined);
    constructor() {}
  }
  return {
    mockSession: {
      prompt: vi.fn(),
      dispose: vi.fn(),
    },
    MockDefaultResourceLoader,
  };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    createAgentSession: vi.fn().mockResolvedValue({
      session: mockSession,
      extensionsResult: { extensions: [], errors: [] },
    }),
    SessionManager: {
      inMemory: vi.fn(() => ({})) as any,
    },
    DefaultResourceLoader: MockDefaultResourceLoader as any,
  };
});

vi.mock('../../validateContract', () => ({
  runWithValidation: vi.fn(),
}));

vi.mock('../../campaign/runTrial', () => ({
  runTrial: vi.fn(),
}));

vi.mock('../../campaign/phases/baselinePhase', () => ({
  baselinePhaseExecutor: {
    execute: vi.fn(),
  },
}));

vi.mock('../../campaign/phases/searchPhase', () => ({
  searchPhaseExecutor: {
    execute: vi.fn(),
  },
}));

vi.mock('../../workspaceManager', () => {
  return {
    WorkspaceManager: class {
      async createEphemeralWorkspace() {
        return {
          path: '/tmp/campaign-workspace',
          dispose: vi.fn().mockResolvedValue(undefined),
        };
      }
    },
  };
});

vi.mock('../../campaign/campaignRatchet', () => ({
  checkCampaignRatchet: vi.fn().mockReturnValue({
    improved: true,
    current: 0.6,
    historicalBest: 0.5,
    bestCampaignId: 'prev-c1',
  }),
}));

// Capture callbacks for the agent tools
const captured = {
  onRunTrial: null as any,
  onComplete: null as any,
};
vi.mock('../../campaign/campaignAgent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../campaign/campaignAgent')>();
  return {
    ...original,
    createCampaignToolsExtension: vi.fn().mockImplementation((onRunTrial, onComplete) => {
      captured.onRunTrial = onRunTrial;
      captured.onComplete = onComplete;
      return vi.fn();
    }),
  };
});

describe('runCampaign', () => {
  let testRoot: string;
  let projectPath: string;
  let logs: string[];

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aesop-run-campaign-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    projectPath = join(testRoot, 'project');
    mkdirSync(projectPath, { recursive: true });
    logs = [];

    vi.clearAllMocks();
    mockSession.prompt.mockClear();
    mockSession.dispose.mockClear();
    captured.onRunTrial = null;
    captured.onComplete = null;

    (baselinePhaseExecutor.execute as any).mockResolvedValue({
      kind: 'baseline',
      status: 'completed',
      metrics: { accuracy: 0.5 },
    });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it('should execute a successful campaign where the agent completes it', async () => {
    const t1Id = crypto.randomUUID();
    (baselinePhaseExecutor.execute as any).mockResolvedValue({
      kind: 'baseline',
      status: 'completed',
      metrics: { accuracy: 0.5 },
      durationMs: 100,
    });

    (searchPhaseExecutor.execute as any).mockResolvedValue({
      kind: 'search',
      status: 'completed',
      trialCount: 1,
      bestTrialId: t1Id,
      bestMetrics: { accuracy: 0.6 },
      bestConfiguration: 'lr=0.1',
      rankedConfigs: [{ trialId: t1Id, configuration: 'lr=0.1', metrics: { accuracy: 0.6 } }],
      durationMs: 200,
    });

    const result = await runCampaign({
      projectDir: projectPath,
      question: 'Optimize LR',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxTrials: 3,
      onLog: (msg) => logs.push(msg),
    });

    expect(result.campaignEntry.status).toBe('completed');
    expect(result.campaignEntry.bestTrialId).toBe(t1Id);
    expect(result.campaignEntry.summary?.bestConfiguration).toBe('lr=0.1');
    expect(checkCampaignRatchet).toHaveBeenCalled();
  });

  it('should handle budget exhaustion', async () => {
    const t1Id = crypto.randomUUID();
    (baselinePhaseExecutor.execute as any).mockResolvedValue({
      kind: 'baseline',
      status: 'completed',
      metrics: { accuracy: 0.5 },
    });

    (searchPhaseExecutor.execute as any).mockResolvedValue({
      kind: 'search',
      status: 'completed',
      trialCount: 1,
      bestTrialId: t1Id,
      bestMetrics: { accuracy: 0.6 },
      bestConfiguration: 'lr=0.1',
      rankedConfigs: [],
    });

    const result = await runCampaign({
      projectDir: projectPath,
      question: 'Optimize LR',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxTrials: 1,
      onLog: (msg) => logs.push(msg),
    });

    expect(result.campaignEntry.status).toBe('completed');
    expect(result.campaignEntry.summary?.insight).toBe('Search completed');
  });

  it('should handle all trials failing', async () => {
    (baselinePhaseExecutor.execute as any).mockResolvedValue({
      kind: 'baseline',
      status: 'completed',
      metrics: { accuracy: 0.5 },
    });

    (searchPhaseExecutor.execute as any).mockResolvedValue({
      kind: 'search',
      status: 'completed',
      trialCount: 0,
      bestTrialId: null,
      bestMetrics: null,
      bestConfiguration: null,
      rankedConfigs: [],
    });

    const result = await runCampaign({
      projectDir: projectPath,
      question: 'Optimize LR',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxTrials: 1,
      onLog: (msg) => logs.push(msg),
    });

    expect(result.campaignEntry.bestTrialId).toBeNull();
    expect(result.campaignEntry.bestMetrics).toBeNull();
  });

  it('should throw if baseline validation fails', async () => {
    (baselinePhaseExecutor.execute as any).mockResolvedValue({
      kind: 'baseline',
      status: 'failed',
      error: 'Command not found',
    });

    await expect(
      runCampaign({
        projectDir: projectPath,
        question: 'Optimize LR',
        validateCmd: './bad.sh',
        metricKey: 'accuracy',
      })
    ).rejects.toThrow(/Baseline phase failed/);
  });
});
