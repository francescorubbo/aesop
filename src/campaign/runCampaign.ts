import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CampaignLedger } from './campaignLedger.js';
import { checkCampaignRatchet } from './campaignRatchet.js';
import { WorkspaceManager, type Workspace } from '../workspaceManager.js';
import { baselinePhaseExecutor as baselineExecutor } from './phases/baselinePhase.js';
import { searchPhaseExecutor as searchExecutor } from './phases/searchPhase.js';
import {
  type RunCampaignOptions,
  type RunCampaignResult,
  type CampaignEntry,
  type CampaignSummary,
  type CampaignPlan,
  type PhaseResult,
} from './types.js';
import type { PhaseContext } from './phases/types.js';

/**
 * Run a complete campaign of experiments.
 *
 * The campaign sequence:
 * 1. Establish baseline metrics in the current project directory
 * 2. Create a campaign agent Pi session
 * 3. Iteratively run trials based on agent hypotheses
 * 4. Collect results and synthesis from the agent
 * 5. Record campaign outcome to ledger and check for monotonic improvement
 *
 * @param options - Campaign configuration
 * @returns Promise resolving to campaign result
 */
export async function runCampaign(options: RunCampaignOptions): Promise<RunCampaignResult> {
  const {
    projectDir,
    question,
    validateCmd,
    metricKey,
    maximize = true,
    maxTrials = 5,
    onLog = () => {
      /* noop */
    },
  } = options;

  const startTime = Date.now();
  const resolvedProjectDir = resolve(projectDir);
  const campaignId = randomUUID();
  const campaignLedgerPath = join(resolvedProjectDir, 'campaigns.jsonl');
  const ledger = new CampaignLedger({ ledgerPath: campaignLedgerPath });

  const log = (msg: string): void => {
    onLog(`[runCampaign] ${msg}`);
  };

  log(`Starting campaign: ${question}`);

  // =====================================================================
  // STEP 1: Planning
  // =====================================================================
  log('Planning campaign phases...');
  // Fallback plan as per instructions until PR 9 lands
  const plan: CampaignPlan = {
    phases: [
      { kind: 'baseline', config: {} },
      {
        kind: 'search',
        strategy: 'agent_guided',
        searchSpace: {}, // Agent will determine this
        maxTrials,
      },
    ],
  };

  // =====================================================================
  // STEP 2: Workspace Setup
  // =====================================================================
  const workspaceManager = new WorkspaceManager(resolvedProjectDir);
  let campaignWorkspace: Workspace | null = null;

  try {
    log('Creating campaign workspace...');
    campaignWorkspace = await workspaceManager.createEphemeralWorkspace(`campaign/${campaignId}`);
    const workspacePath = campaignWorkspace.path;

    const ctx: PhaseContext = {
      workspacePath,
      validateCmd,
      metricKey,
      maximize,
    };

    const phaseResults: PhaseResult[] = [];

    // =====================================================================
    // STEP 3: Phase Execution Loop
    // =====================================================================
    for (const phasePlan of plan.phases) {
      log(`Executing phase: ${phasePlan.kind}...`);

      let result: PhaseResult;
      try {
        if (phasePlan.kind === 'baseline') {
          result = await baselineExecutor.execute(phasePlan, ctx);
        } else if (phasePlan.kind === 'search') {
          result = await searchExecutor.execute(phasePlan, ctx);
        } else {
          throw new Error(`Unsupported phase kind: ${phasePlan.kind}`);
        }
      } catch (e) {
        log(`Phase ${phasePlan.kind} failed: ${String(e)}`);
        result = {
          kind: phasePlan.kind as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          status: 'failed',
          error: String(e),
        } as PhaseResult;
      }

      phaseResults.push(result);

      // Halt campaign if baseline fails
      if (phasePlan.kind === 'baseline' && result.status === 'failed') {
        throw new Error(`Baseline phase failed: ${result.error}`);
      }
    }

    // =====================================================================
    // STEP 4: Finalize Campaign Results
    // =====================================================================

    // Determine the best metrics from search results
    let bestMetrics: Record<string, number> | null = null;
    let bestTrialId: string | null = null;
    let summary: CampaignSummary | null = null;

    for (const res of phaseResults) {
      if (res.kind === 'search' && res.status === 'completed') {
        bestMetrics = res.bestMetrics;
        bestTrialId = res.bestTrialId;
        // We don't have the full CampaignSummary object from searchPhaseExecutor
        // but we can populate the best configuration.
        summary = {
          bestConfiguration: res.bestConfiguration ?? 'unknown',
          bestMetrics: res.bestMetrics ?? {},
          insight: 'Search completed',
          recommendation: 'See ranked configs',
        };
      }
    }

    const campaignEntry: CampaignEntry = {
      campaignId,
      timestamp: new Date().toISOString(),
      question,
      metricKey,
      maximize,
      status: 'completed',
      trialCount: phaseResults.reduce((acc, res) => {
        if (res.kind === 'search') return acc + (res.trialCount || 0);
        return acc;
      }, 0),
      bestTrialId,
      bestMetrics,
      summary,
      durationMs: Date.now() - startTime,
      plan,
      phaseResults,
    };

    await ledger.append(campaignEntry);

    // =====================================================================
    // STEP 5: Ratchet Check
    // =====================================================================

    let ratchetImproved = false;
    let historicalBest: number | null = null;

    if (bestMetrics && bestMetrics[metricKey] !== undefined) {
      const currentBest = bestMetrics[metricKey]!;
      const ratchetResult = checkCampaignRatchet(campaignLedgerPath, metricKey, currentBest, {
        maximize,
      });
      ratchetImproved = ratchetResult.improved;
      historicalBest = ratchetResult.historicalBest;
    }

    return {
      campaignEntry,
      ratchetImproved,
      historicalBest,
    };
  } finally {
    if (campaignWorkspace) {
      log('Disposing campaign workspace...');
      await campaignWorkspace.dispose();
    }
  }
}
