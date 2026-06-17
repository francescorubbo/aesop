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

// ── Phase ──────────────────────────────────────────────────────────────────

export const PhaseStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

export const PhaseKindSchema = z.enum(['scaffold', 'baseline', 'search', 'long_run']);
export type PhaseKind = z.infer<typeof PhaseKindSchema>;

export const ScaffoldResultSchema = z.object({
  kind: z.literal('scaffold'),
  status: PhaseStatusSchema,
  output: z.string().optional(),
  error: z.string().optional(),
});

export const BaselineResultSchema = z.object({
  kind: z.literal('baseline'),
  status: PhaseStatusSchema,
  metrics: z.record(z.string(), z.number()).optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type BaselineResult = z.infer<typeof BaselineResultSchema>;

export const SearchResultSchema = z.object({
  kind: z.literal('search'),
  status: PhaseStatusSchema,
  bestMetrics: z.record(z.string(), z.number()).optional(),
  bestConfig: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

export const LongRunResultSchema = z.object({
  kind: z.literal('long_run'),
  status: PhaseStatusSchema,
  metrics: z.record(z.string(), z.number()).optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type LongRunResult = z.infer<typeof LongRunResultSchema>;

export const PhaseResultSchema = z.discriminatedUnion('kind', [
  ScaffoldResultSchema,
  BaselineResultSchema,
  SearchResultSchema,
  LongRunResultSchema,
]);
export type PhaseResult = z.infer<typeof PhaseResultSchema>;

export const ScaffoldPlanSchema = z.object({
  kind: z.literal('scaffold'),
  instructions: z.string(),
});

export const BaselinePlanSchema = z.object({
  kind: z.literal('baseline'),
  config: z.record(z.string(), z.any()),
});
export type BaselinePlan = z.infer<typeof BaselinePlanSchema>;

export const SearchPlanSchema = z.object({
  kind: z.literal('search'),
  space: z.record(z.string(), z.any()),
  iterations: z.number().int().positive(),
});

export const LongRunPlanSchema = z.object({
  kind: z.literal('long_run'),
  bestArgs: z.record(z.string(), z.string()),
  epochs: z.number().int().positive(),
});
export type LongRunPlan = z.infer<typeof LongRunPlanSchema>;

export const PhasePlanSchema = z.discriminatedUnion('kind', [
  ScaffoldPlanSchema,
  BaselinePlanSchema,
  SearchPlanSchema,
  LongRunPlanSchema,
]);
export type PhasePlan = z.infer<typeof PhasePlanSchema>;

export const CampaignPlanSchema = z.object({
  phases: z.array(PhasePlanSchema),
});
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

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
  plan: CampaignPlanSchema.optional(),
  phaseResults: z.array(PhaseResultSchema).optional(),
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
