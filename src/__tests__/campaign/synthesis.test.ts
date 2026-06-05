import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesiseCampaign } from '../../campaign/synthesis.js';
import Anthropic from '@anthropic-ai/sdk';
import { type TrialEntry } from '../../campaign/types.js';

interface MockMessage {
  content: Array<{ type: 'text'; text: string }>;
}

describe('synthesiseCampaign', () => {
  const mockCreate = vi.fn();
  const mockClient = {
    messages: {
      create: mockCreate,
    },
  } as unknown as Anthropic;

  const defaultOpts = {
    question: 'Which LR is best?',
    metricKey: 'accuracy',
    maximize: true,
    trials: [
      {
        trialId: '1',
        campaignId: 'c1',
        timestamp: new Date().toISOString(),
        branch: 'b1',
        baseCommit: 'bc1',
        hypothesisCommit: 'hc1',
        trialHypothesis: 'LR=0.1',
        status: 'completed' as const,
        metrics: { accuracy: 0.8, loss: 0.5 },
        durationMs: 100,
      } as TrialEntry,
      {
        trialId: '2',
        campaignId: 'c1',
        timestamp: new Date().toISOString(),
        branch: 'b2',
        baseCommit: 'bc1',
        hypothesisCommit: 'hc2',
        trialHypothesis: 'LR=0.01',
        status: 'completed' as const,
        metrics: { accuracy: 0.9, loss: 0.3 },
        durationMs: 100,
      } as TrialEntry,
    ],
    client: mockClient,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns CampaignSummary for valid JSON response', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            bestConfiguration: 'LR=0.01',
            bestMetrics: { accuracy: 0.9, loss: 0.3 },
            insight: 'Lower LR performed better.',
            recommendation: 'Try 0.001',
          }),
        },
      ],
    } as MockMessage);

    const result = await synthesiseCampaign(defaultOpts);

    expect(result.bestConfiguration).toBe('LR=0.01');
    expect(result.bestMetrics['accuracy']).toBe(0.9);
    expect(result.insight).toBe('Lower LR performed better.');
  });

  it('handles response with markdown fences', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '```json\n{\n  "bestConfiguration": "LR=0.01",\n  "bestMetrics": { "accuracy": 0.9 },\n  "insight": "insight",\n  "recommendation": "rec"\n}\n```',
        },
      ],
    } as MockMessage);

    const result = await synthesiseCampaign(defaultOpts);
    expect(result.bestConfiguration).toBe('LR=0.01');
  });

  it('throws for schema-invalid response', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            bestConfiguration: 'LR=0.01',
            // missing insight and recommendation
          }),
        },
      ],
    } as MockMessage);

    await expect(synthesiseCampaign(defaultOpts)).rejects.toThrow(
      'Failed to synthesize campaign summary'
    );
  });

  it('returns summary for empty trial list (all failed)', async () => {
    const opts = {
      ...defaultOpts,
      trials: [
        {
          ...defaultOpts.trials[0],
          status: 'failed' as const,
          error: 'crash',
        } as TrialEntry,
      ],
    };

    const result = await synthesiseCampaign(opts);
    expect(result.bestConfiguration).toBe('none');
    expect(result.insight).toContain('All trials failed');
  });

  it('includes metricKey and correct sorting in prompt', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            bestConfiguration: 'LR=0.01',
            bestMetrics: { accuracy: 0.9 },
            insight: '...',
            recommendation: '...',
          }),
        },
      ],
    } as MockMessage);

    await synthesiseCampaign(defaultOpts);

    const call = mockCreate.mock.calls[0];
    if (!call) throw new Error('Expected mockCreate to be called');
    const prompt = call[0].messages[0].content;
    expect(prompt).toContain('Primary Metric: accuracy (maximize)');
    // Check sorting: LR=0.01 (0.9) should come before LR=0.1 (0.8)
    const pos1 = prompt.indexOf('LR=0.01');
    const pos2 = prompt.indexOf('LR=0.1');
    expect(pos1).toBeLessThan(pos2);
  });

  it('omits parameterEffect when not provided by model', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            bestConfiguration: 'LR=0.01',
            bestMetrics: { accuracy: 0.9 },
            insight: 'insight',
            recommendation: 'rec',
          }),
        },
      ],
    } as MockMessage);

    const result = await synthesiseCampaign(defaultOpts);
    expect(result.parameterEffect).toBeUndefined();
  });
});
