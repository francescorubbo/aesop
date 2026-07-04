import { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface CompleteCampaignArgs {
  bestTrialId: string;
  bestConfiguration: string;
  insight: string;
  recommendation: string;
  parameterEffect?: {
    parameterName: string;
    trend: 'monotone_increasing' | 'monotone_decreasing' | 'peaked' | 'irregular';
    peakValue?: string;
  };
}

export function buildCampaignSystemPrompt(
  question: string,
  metricKey: string,
  baseline: number,
  maximize: boolean
): string {
  const direction = maximize ? 'maximize' : 'minimize';
  const goal = maximize ? 'higher' : 'lower';

  return `You are an expert ML researcher coordinating a campaign of experiments to answer the following question:
"${question}"

Your goal is to find the robust optimum for the metric "${metricKey}".
Current baseline: ${baseline}

Optimization Goal: ${direction} (Better means ${goal}).

You have two tools:
1. run_trial(args: Record<string, string>): Runs a single experiment with the given parameter configurations. 
   The args object should contain the parameter names and their values (e.g., { "learning_rate": "0.001", "batch_size": "32" }).
   It returns the trial ID, the metrics observed, and whether it succeeded.

2. complete_campaign(args: CompleteCampaignArgs): Call this when you have found a satisfactory optimum or have enough evidence to make a definitive recommendation.

Strategy:
- Do not just look for the first improvement. Explore the parameter space to understand the trend.
- Be precise in your configurations.
- Once you believe you've reached the optimum or the budget is exhausted, summarize your findings using complete_campaign.

Always analyze the results of the previous trial before proposing the next one.`;
}

export function buildCampaignIterationPrompt(
  trialHistory: Array<{
    trialId: string;
    hypothesis: string;
    metrics: Record<string, number> | null;
    status: string;
  }>,
  trialsRemaining: number
): string {
  const historyLog = trialHistory
    .map(
      (t, i) =>
        `${i + 1}. [${t.trialId}] Hyp: ${t.hypothesis} | Status: ${t.status} | Metrics: ${JSON.stringify(t.metrics)}`
    )
    .join('\n');

  return `Current Trial History:
${historyLog}

Trials remaining in budget: ${trialsRemaining}

Based on the history above, what is your next move? 
Either call run_trial with a new hypothesis to further explore/optimize, or call complete_campaign if you are finished.`;
}

export function createCampaignToolsExtension(
  onRunTrial: (_args: Record<string, string>) => Promise<{
    trialId: string;
    metrics: Record<string, number> | null;
    status: string;
    error?: string;
  }>,
  onComplete: (_args: CompleteCampaignArgs) => void
) {
  return function campaignToolsExtension(pi: ExtensionAPI): void {
    pi.registerTool({
      name: 'run_trial',
      label: 'Run Trial',
      description: 'Run a single experiment trial with specific parameter configurations.',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'The parameter configurations to test.',
          },
        },
        required: ['args'],
      },
      execute: async (_toolCallId, params) => {
        const { args: trialArgs } = params as { args: Record<string, string> };
        const result = await onRunTrial(trialArgs);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
      },
    });

    pi.registerTool({
      name: 'complete_campaign',
      label: 'Complete Campaign',
      description: 'Complete the campaign and provide a final synthesis of the findings.',
      parameters: {
        type: 'object',
        properties: {
          bestTrialId: {
            type: 'string',
            description: 'The ID of the trial that performed best.',
          },
          bestConfiguration: {
            type: 'string',
            description: 'Description of the best configuration found.',
          },
          insight: {
            type: 'string',
            description: 'The key insight learned about the parameter being tuned.',
          },
          recommendation: {
            type: 'string',
            description: 'Actionable next step or final recommendation.',
          },
          parameterEffect: {
            type: 'object',
            properties: {
              parameterName: { type: 'string' },
              trend: {
                type: 'string',
                enum: ['monotone_increasing', 'monotone_decreasing', 'peaked', 'irregular'],
              },
              peakValue: { type: 'string' },
            },
            required: ['parameterName', 'trend'],
          },
        },
        required: ['bestTrialId', 'bestConfiguration', 'insight', 'recommendation'],
      },
      execute: async (_toolCallId, params) => {
        onComplete(params as CompleteCampaignArgs);
        return {
          content: [{ type: 'text', text: 'Campaign completed successfully.' }],
          details: {},
        };
      },
    });
  };
}
