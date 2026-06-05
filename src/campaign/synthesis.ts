import Anthropic from '@anthropic-ai/sdk';
import { CampaignSummarySchema, type CampaignSummary, type TrialEntry } from './types.js';

export async function synthesiseCampaign(opts: {
  question: string;
  metricKey: string;
  maximize: boolean;
  trials: TrialEntry[];
  client?: Anthropic;
}): Promise<CampaignSummary> {
  const client = opts.client ?? new Anthropic();

  const completedTrials = opts.trials.filter((t) => t.status === 'completed');

  if (completedTrials.length === 0) {
    return {
      bestConfiguration: 'none',
      bestMetrics: {},
      insight: 'All trials failed or were not completed.',
      recommendation:
        'Review the trial hypotheses and validation scripts to identify why they are failing.',
    };
  }

  // Sort trials by the primary metric
  const sortedTrials = [...completedTrials].sort((a, b) => {
    const valA = a.metrics[opts.metricKey] ?? 0;
    const valB = b.metrics[opts.metricKey] ?? 0;
    return opts.maximize ? valB - valA : valA - valB;
  });

  const trialsMarkdown = sortedTrials
    .map((t, i) => {
      const metricsStr = Object.entries(t.metrics)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      return `${i + 1}. Hypothesis: ${t.trialHypothesis}\n   Metrics: ${metricsStr}`;
    })
    .join('\n\n');

  const prompt = `
You are an ML experiment synthesis agent. Your goal is to analyze a series of trials and summarize the results.

Question: ${opts.question}
Primary Metric: ${opts.metricKey} (${opts.maximize ? 'maximize' : 'minimize'})

Trial Results (sorted by primary metric):
${trialsMarkdown}

Please provide a summary of the campaign.
Return the response as a JSON object with the following structure:
- bestConfiguration: The hypothesis or configuration that performed best.
- bestMetrics: The full set of metrics for the best configuration.
- insight: A concise analysis of what worked and why, considering all metrics and trade-offs.
- recommendation: Suggested next steps based on the findings.
- parameterEffect: (Optional) If there is a clear parameter being varied, describe its effect:
    - parameterName: Name of the parameter.
    - observations: List of { value, metrics } for different settings.
    - trend: 'monotone_increasing', 'monotone_decreasing', 'peaked', or 'irregular'.
    - peakValue: (Optional) The value that performed best.

Respond ONLY with the JSON object. Do not include any preamble or markdown formatting.
`;

  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20240620',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const firstContent = response.content[0];
  if (!firstContent) {
    throw new Error('Model returned no content');
  }
  const text = firstContent.type === 'text' ? firstContent.text : '';
  const jsonText = text.replace(/^```json\s*|\s*```$/g, '').trim();

  try {
    const parsed = JSON.parse(jsonText);
    const validated = CampaignSummarySchema.parse(parsed);
    return validated;
  } catch (e) {
    throw new Error(
      `Failed to synthesize campaign summary. Model output was invalid JSON or failed schema validation: ${e instanceof Error ? e.message : String(e)}\n\nRaw output: ${text}`
    );
  }
}
