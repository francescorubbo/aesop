import { z } from 'zod';

// ── Trial ────────────────────────────────────────────────────────────────────

export const TrialStatusSchema = z.enum(['completed', 'failed']);
export type TrialStatus = z.infer<typeof TrialStatusSchema>;

export const TrialEntrySchema = z.object({
  trialId: z.string().uuid(),
  campaignId: z.string().uuid(),
  timestamp: z.string().datetime(),
  branch: z.string(),
  baseCommit: z.string(),
  hypothesisCommit: z.string(),
  trialHypothesis: z.string(),
  status: TrialStatusSchema,
  metrics: z.record(z.string(), z.number()),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});
export type TrialEntry = z.infer<typeof TrialEntrySchema>;

// ── Campaign summary (synthesis output) ──────────────────────────────────────

export const ParameterEffectSchema = z.object({
  parameterName: z.string(),
  observations: z.array(
    z.object({
      value: z.string(),
      metrics: z.record(z.string(), z.number()),
    })
  ),
  trend: z.enum(['monotone_increasing', 'monotone_decreasing', 'peaked', 'irregular']),
  peakValue: z.string().optional(),
});

export const CampaignSummarySchema = z.object({
  bestConfiguration: z.string(),
  bestMetrics: z.record(z.string(), z.number()),
  insight: z.string(),
  recommendation: z.string(),
  parameterEffect: ParameterEffectSchema.optional(),
});
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>;

// ── Campaign ─────────────────────────────────────────────────────────────────

export const CampaignStatusSchema = z.enum(['completed', 'failed', 'budget_exhausted']);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const CampaignEntrySchema = z.object({
  campaignId: z.string().uuid(),
  timestamp: z.string().datetime(),
  question: z.string(),
  metricKey: z.string(),
  maximize: z.boolean(),
  status: CampaignStatusSchema,
  trialCount: z.number().int().nonnegative(),
  bestTrialId: z.string().uuid().nullable(),
  bestMetrics: z.record(z.string(), z.number()).nullable(),
  summary: CampaignSummarySchema.nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type CampaignEntry = z.infer<typeof CampaignEntrySchema>;

// ── Options / Results (used by runTrial and runCampaign) ─────────────────────

export interface RunTrialOptions {
  projectDir: string;
  campaignId: string;
  trialHypothesis: string;
  validateCmd: string;
  metricKey: string;
  maximize?: boolean;
  maxIterations?: number;
  model?: string;
  onLog?: (_msg: string) => void;
}

export interface RunTrialResult {
  trialEntry: TrialEntry;
  traceDir: string;
}

export interface RunCampaignOptions {
  projectDir: string;
  question: string;
  validateCmd: string;
  metricKey: string;
  maximize?: boolean;
  maxTrials?: number;
  maxIterations?: number;
  model?: string;
  onLog?: (_msg: string) => void;
}

export interface RunCampaignResult {
  campaignEntry: CampaignEntry;
  ratchetImproved: boolean;
  historicalBest: number | null;
}
