/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { runCampaign } from '../../campaign/runCampaign';
import { runWithValidation } from '../../validateContract';
import { runTrial } from '../../campaign/runTrial';
import { checkCampaignRatchet } from '../../campaign/campaignRatchet';

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

vi.mock('../../campaign/campaignLedger', () => {
  class MockCampaignLedger {
    append = vi.fn().mockResolvedValue(undefined);
    readAll = vi.fn().mockReturnValue([]);
    readLast = vi.fn().mockReturnValue(null);
    exists = vi.fn().mockReturnValue(false);
    getPath = vi.fn().mockReturnValue('/tmp/campaigns.jsonl');
  }
  return {
    CampaignLedger: MockCampaignLedger,
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

    (runWithValidation as any).mockResolvedValue({
      success: true,
      metrics: { accuracy: 0.5 },
    });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it('should execute a successful campaign where the agent completes it', async () => {
    const trial1 = {
      trialEntry: {
        trialId: 't1',
        campaignId: 'c1',
        timestamp: new Date().toISOString(),
        branch: 'trial/c1/t1',
        baseCommit: 'b1',
        hypothesisCommit: 'h1',
        trialHypothesis: 'lr=0.1',
        status: 'completed' as any,
        metrics: { accuracy: 0.6 },
        durationMs: 100,
      },
      traceDir: '/tmp/t1',
    };

    (runTrial as any).mockResolvedValueOnce(trial1);

    let promptResolver: any = null;
    mockSession.prompt.mockImplementation(() => {
      return new Promise((resolve) => {
        promptResolver = resolve;
      });
    });

    const campaignPromise = runCampaign({
      projectDir: projectPath,
      question: 'Optimize LR',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxTrials: 3,
      onLog: (msg) => logs.push(msg),
    });

    await vi.waitFor(() => expect(mockSession.prompt).toHaveBeenCalled());

    await captured.onRunTrial({ hypothesis: 'lr=0.1' });
    promptResolver?.(undefined);

    await vi.waitFor(() => expect(mockSession.prompt).toHaveBeenCalledTimes(2));

    await captured.onComplete({
      bestTrialId: 't1',
      bestConfiguration: 'lr=0.1',
      insight: 'Higher LR is better',
      recommendation: 'Stop here',
    });
    promptResolver?.(undefined);

    const result = await campaignPromise;

    expect(result.campaignEntry.status).toBe('completed');
    expect(result.campaignEntry.bestTrialId).toBe('t1');
    expect(result.campaignEntry.summary?.bestConfiguration).toBe('lr=0.1');
    expect(result.campaignEntry.summary?.insight).toBe('Higher LR is better');
    expect(checkCampaignRatchet).toHaveBeenCalled();
  });

  it('should handle budget exhaustion', async () => {
    (runTrial as any).mockResolvedValue({
      trialEntry: {
        trialId: 't1',
        campaignId: 'c1',
        timestamp: new Date().toISOString(),
        branch: 'trial/c1/t1',
        baseCommit: 'b1',
        hypothesisCommit: 'h1',
        trialHypothesis: 'lr=0.1',
        status: 'completed' as any,
        metrics: { accuracy: 0.6 },
        durationMs: 100,
      },
      traceDir: '/tmp/t1',
    });

    let promptResolver: any = null;
    mockSession.prompt.mockImplementation(() => {
      return new Promise((resolve) => {
        promptResolver = resolve;
      });
    });

    const campaignPromise = runCampaign({
      projectDir: projectPath,
      question: 'Optimize LR',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxTrials: 1,
      onLog: (msg) => logs.push(msg),
    });

    await vi.waitFor(() => expect(mockSession.prompt).toHaveBeenCalled());
    promptResolver?.(undefined);

    await vi.waitFor(() =>
      expect(mockSession.prompt).toHaveBeenCalledWith(
        expect.stringContaining('You have used all 1 trials')
      )
    );

    await captured.onComplete({
      bestTrialId: 't1',
      bestConfiguration: 'lr=0.1',
      insight: 'Budget ran out',
      recommendation: 'More trials needed',
    });
    promptResolver?.(undefined);

    const result = await campaignPromise;

    expect(result.campaignEntry.status).toBe('budget_exhausted');
    expect(result.campaignEntry.summary?.insight).toBe('Budget ran out');
  });

  it('should handle all trials failing', async () => {
    (runTrial as any).mockResolvedValue({
      trialEntry: {
        trialId: 't1',
        campaignId: 'c1',
        timestamp: new Date().toISOString(),
        branch: 'trial/c1/t1',
        baseCommit: 'b1',
        hypothesisCommit: 'h1',
        trialHypothesis: 'lr=0.1',
        status: 'failed' as any,
        metrics: {},
        durationMs: 100,
        error: 'Crash',
      },
      traceDir: '/tmp/t1',
    });

    let promptResolver: any = null;
    mockSession.prompt.mockImplementation(() => {
      return new Promise((resolve) => {
        promptResolver = resolve;
      });
    });

    const campaignPromise = runCampaign({
      projectDir: projectPath,
      question: 'Optimize LR',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxTrials: 1,
      onLog: (msg) => logs.push(msg),
    });

    await vi.waitFor(() => expect(mockSession.prompt).toHaveBeenCalled());

    await captured.onRunTrial({ hypothesis: 'lr=0.1' });
    promptResolver?.(undefined);

    await vi.waitFor(() =>
      expect(mockSession.prompt).toHaveBeenCalledWith(
        expect.stringContaining('You have used all 1 trials')
      )
    );

    await captured.onComplete({
      bestTrialId: 't1',
      bestConfiguration: 'none',
      insight: 'Everything failed',
      recommendation: 'Fix the code',
    });
    promptResolver?.(undefined);

    const result = await campaignPromise;

    expect(result.campaignEntry.bestTrialId).toBeNull();
    expect(result.campaignEntry.bestMetrics).toBeNull();
    expect(result.campaignEntry.summary?.insight).toBe('Everything failed');
  });

  it('should throw if baseline validation fails', async () => {
    (runWithValidation as any).mockResolvedValue({
      success: false,
      error: 'Command not found',
    });

    await expect(
      runCampaign({
        projectDir: projectPath,
        question: 'Optimize LR',
        validateCmd: './bad.sh',
        metricKey: 'accuracy',
      })
    ).rejects.toThrow(/Baseline validation failed/);
  });
});
