import { describe, it, expect } from 'vitest';
import {
  TrialEntrySchema,
  CampaignEntrySchema,
  CampaignSummarySchema,
  PhaseResultSchema,
  PhasePlanSchema,
  CampaignPlanSchema,
} from '../../campaign/types';

describe('campaign/types.ts schemas', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';
  const validTimestamp = new Date().toISOString();

  describe('TrialEntrySchema', () => {
    const validTrial = {
      trialId: validUuid,
      campaignId: validUuid,
      timestamp: validTimestamp,
      branch: 'hypothesis/test',
      baseCommit: 'abc1234',
      hypothesisCommit: 'def5678',
      trialHypothesis: 'test hypothesis',
      status: 'completed',
      metrics: { accuracy: 0.95 },
      durationMs: 1000,
    };

    it('should parse a valid TrialEntry', () => {
      expect(TrialEntrySchema.parse(validTrial)).toEqual(validTrial);
    });

    it('should allow optional error field', () => {
      const withError = { ...validTrial, error: 'some error' };
      expect(TrialEntrySchema.parse(withError)).toEqual(withError);
    });

    it('should reject invalid UUIDs', () => {
      const invalid = { ...validTrial, trialId: 'not-a-uuid' };
      expect(() => TrialEntrySchema.parse(invalid)).toThrow();
    });

    it('should reject invalid timestamps', () => {
      const invalid = { ...validTrial, timestamp: 'not-a-date' };
      expect(() => TrialEntrySchema.parse(invalid)).toThrow();
    });

    it('should reject invalid status', () => {
      const invalid = { ...validTrial, status: 'unknown' };
      expect(() => TrialEntrySchema.parse(invalid)).toThrow();
    });

    it('should reject negative duration', () => {
      const invalid = { ...validTrial, durationMs: -1 };
      expect(() => TrialEntrySchema.parse(invalid)).toThrow();
    });
  });

  describe('CampaignSummarySchema', () => {
    const validSummary = {
      bestConfiguration: 'lr=0.01',
      bestMetrics: { accuracy: 0.96 },
      insight: 'Higher LR helps',
      recommendation: 'Stick with 0.01',
      parameterEffect: {
        parameterName: 'learning_rate',
        observations: [
          { value: '0.01', metrics: { accuracy: 0.96 } },
          { value: '0.001', metrics: { accuracy: 0.9 } },
        ],
        trend: 'monotone_increasing',
        peakValue: '0.01',
      },
    };

    it('should parse a valid CampaignSummary', () => {
      expect(CampaignSummarySchema.parse(validSummary)).toEqual(validSummary);
    });

    it('should allow optional parameterEffect', () => {
      const withoutEffect = {
        bestConfiguration: 'cfg',
        bestMetrics: { m: 1 },
        insight: 'insight',
        recommendation: 'rec',
      };
      expect(CampaignSummarySchema.parse(withoutEffect)).toEqual(withoutEffect);
    });

    it('should reject invalid trend', () => {
      const invalid = {
        ...validSummary,
        parameterEffect: { ...validSummary.parameterEffect!, trend: 'unknown' },
      };
      expect(() => CampaignSummarySchema.parse(invalid)).toThrow();
    });
  });

  describe('CampaignEntrySchema', () => {
    const validCampaign = {
      campaignId: validUuid,
      timestamp: validTimestamp,
      question: 'Which LR is best?',
      metricKey: 'accuracy',
      maximize: true,
      status: 'completed',
      trialCount: 5,
      bestTrialId: validUuid,
      bestMetrics: { accuracy: 0.96 },
      summary: {
        bestConfiguration: 'lr=0.01',
        bestMetrics: { accuracy: 0.96 },
        insight: 'Higher LR helps',
        recommendation: 'Stick with 0.01',
      },
      durationMs: 5000,
    };

    it('should parse a valid CampaignEntry', () => {
      expect(CampaignEntrySchema.parse(validCampaign)).toEqual(validCampaign);
    });

    it('should parse a CampaignEntry with plan and phaseResults', () => {
      const fullCampaign = {
        ...validCampaign,
        plan: {
          phases: [
            { kind: 'scaffold', instructions: 'Setup' },
            { kind: 'baseline', config: { lr: 0.01 } },
          ],
        },
        phaseResults: [
          { kind: 'scaffold', status: 'completed', output: 'OK' },
          { kind: 'baseline', status: 'completed', metrics: { acc: 0.8 } },
        ],
      };
      expect(CampaignEntrySchema.parse(fullCampaign)).toEqual(fullCampaign);
    });

    it('should allow nullable bestTrialId, bestMetrics, and summary', () => {
      const minimal = {
        ...validCampaign,
        bestTrialId: null,
        bestMetrics: null,
        summary: null,
      };
      expect(CampaignEntrySchema.parse(minimal)).toEqual(minimal);
    });

    it('should reject invalid status', () => {
      const invalid = { ...validCampaign, status: 'unknown' };
      expect(() => CampaignEntrySchema.parse(invalid)).toThrow();
    });
  });

  describe('PhaseResultSchema', () => {
    it('should parse ScaffoldResult', () => {
      const res = { kind: 'scaffold', status: 'completed', output: 'ok' };
      expect(PhaseResultSchema.parse(res)).toEqual(res);
    });

    it('should parse BaselineResult', () => {
      const res = { kind: 'baseline', status: 'completed', metrics: { acc: 0.1 } };
      expect(PhaseResultSchema.parse(res)).toEqual(res);
    });

    it('should parse SearchResult', () => {
      const res = {
        kind: 'search',
        status: 'completed',
        bestMetrics: { acc: 0.2 },
        bestConfig: 'cfg',
      };
      expect(PhaseResultSchema.parse(res)).toEqual(res);
    });

    it('should parse LongRunResult', () => {
      const res = { kind: 'long_run', status: 'completed', metrics: { acc: 0.3 } };
      expect(PhaseResultSchema.parse(res)).toEqual(res);
    });

    it('should reject invalid status', () => {
      const res = { kind: 'scaffold', status: 'invalid' };
      expect(() => PhaseResultSchema.parse(res)).toThrow();
    });
  });

  describe('PhasePlanSchema', () => {
    it('should parse ScaffoldPlan', () => {
      const plan = { kind: 'scaffold', instructions: 'do this' };
      expect(PhasePlanSchema.parse(plan)).toEqual(plan);
    });

    it('should parse BaselinePlan', () => {
      const plan = { kind: 'baseline', config: { a: 1 } };
      expect(PhasePlanSchema.parse(plan)).toEqual(plan);
    });

    it('should parse SearchPlan', () => {
      const plan = { kind: 'search', space: { a: [1, 2] }, iterations: 10 };
      expect(PhasePlanSchema.parse(plan)).toEqual(plan);
    });

    it('should parse LongRunPlan', () => {
      const plan = { kind: 'long_run', config: { a: 1 } };
      expect(PhasePlanSchema.parse(plan)).toEqual(plan);
    });

    it('should reject invalid iterations in SearchPlan', () => {
      const plan = { kind: 'search', space: {}, iterations: 0 };
      expect(() => PhasePlanSchema.parse(plan)).toThrow();
    });
  });

  describe('CampaignPlanSchema', () => {
    it('should parse a valid CampaignPlan', () => {
      const plan = {
        phases: [
          { kind: 'scaffold', instructions: '...' },
          { kind: 'baseline', config: {} },
        ],
      };
      expect(CampaignPlanSchema.parse(plan)).toEqual(plan);
    });
  });
});
