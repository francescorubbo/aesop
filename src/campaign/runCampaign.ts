import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';

import { runWithValidation } from '../validateContract.js';
import { runTrial } from './runTrial.js';
import { CampaignLedger } from './campaignLedger.js';
import { checkCampaignRatchet } from './campaignRatchet.js';
import {
  buildCampaignSystemPrompt,
  buildCampaignIterationPrompt,
  createCampaignToolsExtension,
  type CompleteCampaignArgs,
} from './campaignAgent.js';
import {
  type RunCampaignOptions,
  type RunCampaignResult,
  type CampaignEntry,
  type CampaignSummary,
  type TrialEntry,
  type CampaignStatus,
} from './types.js';

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
    model,
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
  // STEP 1: Establish Baseline
  // =====================================================================
  log('Establishing baseline metrics...');
  const baselineResult = await runWithValidation(resolvedProjectDir, validateCmd, metricKey);
  if (!baselineResult.success) {
    throw new Error(
      `Baseline validation failed. The validation command "${validateCmd}" must succeed before a campaign can start. Error: ${baselineResult.error}`
    );
  }
  const baselineValue = baselineResult.metrics[metricKey];
  if (baselineValue === undefined) {
    throw new Error(`Baseline validation succeeded but metric ${metricKey} not found.`);
  }
  log(`Baseline established: ${metricKey} = ${baselineValue}`);

  // =====================================================================
  // STEP 2: Setup Campaign Agent Session
  // =====================================================================

  const authStorage = AuthStorage.create();
  if (process.env['GEMINI_API_KEY']) {
    authStorage.setRuntimeApiKey('google', process.env['GEMINI_API_KEY']!);
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    authStorage.setRuntimeApiKey('anthropic', process.env['ANTHROPIC_API_KEY']!);
  }
  const modelRegistry = ModelRegistry.create(authStorage);

  // Resolve model if provided
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolvedModel: any = undefined;
  if (model) {
    const parts = model.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const foundModel = getModel(parts[0] as any, parts[1]);
      if (foundModel) {
        log(`Using model: ${model} (${foundModel.id})`);
        resolvedModel = foundModel;
      }
    }
  }

  const campaignState = {
    done: false,
    status: 'completed' as CampaignStatus,
    summary: null as CampaignSummary | null,
    trialHistory: [] as TrialEntry[],
    bestTrialIdFromAgent: null as string | null,
  };

  const onComplete = (args: CompleteCampaignArgs) => {
    log(`Agent signaled completion. Best Trial: ${args.bestTrialId}`);
    campaignState.done = true;
    campaignState.summary = {
      bestConfiguration: args.bestConfiguration,
      bestMetrics: {},
      insight: args.insight,
      recommendation: args.recommendation,
      parameterEffect: args.parameterEffect
        ? {
            parameterName: args.parameterEffect.parameterName,
            observations: [],
            trend: args.parameterEffect.trend,
            peakValue: args.parameterEffect.peakValue,
          }
        : undefined,
    };
    campaignState.bestTrialIdFromAgent = args.bestTrialId;
  };

  const onRunTrial = async (hypothesis: string) => {
    log(`Running trial: ${hypothesis}`);
    try {
      const result = await runTrial({
        projectDir: resolvedProjectDir,
        campaignId,
        trialHypothesis: hypothesis,
        validateCmd,
        metricKey,
        maximize,
        onLog,
      });
      campaignState.trialHistory.push(result.trialEntry);
      return {
        trialId: result.trialEntry.trialId,
        metrics: result.trialEntry.metrics,
        status: result.trialEntry.status,
        error: result.trialEntry.error,
      } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    } catch (e) {
      log(`Trial execution failed: ${String(e)}`);
      return {
        trialId: randomUUID(),
        metrics: null,
        status: 'failed',
        error: String(e),
      } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  };

  const systemPrompt = buildCampaignSystemPrompt(question, metricKey, baselineValue, maximize);
  const resourceLoader = new DefaultResourceLoader({
    cwd: resolvedProjectDir,
    agentDir: getAgentDir(),
    extensionFactories: [createCampaignToolsExtension(onRunTrial, onComplete)],
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: resolvedProjectDir,
    sessionManager: SessionManager.inMemory(resolvedProjectDir),
    resourceLoader,
    authStorage,
    modelRegistry,
    model: resolvedModel,
    tools: ['read', 'bash', 'edit', 'write', 'run_trial', 'complete_campaign'],
  });

  // =====================================================================
  // STEP 3: Campaign Loop
  // =====================================================================

  for (let i = 0; i < maxTrials; i++) {
    const trialsRemaining = maxTrials - i;
    const history = campaignState.trialHistory.map((t) => ({
      trialId: t.trialId,
      hypothesis: t.trialHypothesis,
      metrics: t.metrics,
      status: t.status,
    }));

    log(`Agent iteration ${i + 1}/${maxTrials} (Remaining: ${trialsRemaining})`);
    await session.prompt(buildCampaignIterationPrompt(history, trialsRemaining));

    if (campaignState.done) {
      break;
    }
  }

  // Final nudge if budget exhausted
  if (!campaignState.done) {
    log('Budget exhausted. Requesting final synthesis from agent...');
    campaignState.status = 'budget_exhausted';
    await session.prompt(
      `You have used all ${maxTrials} trials. ` +
        `Call complete_campaign now with your best assessment based on the results so far, ` +
        `even if the search is incomplete.`
    );
  }

  // =====================================================================
  // STEP 4: Finalize Campaign Results
  // =====================================================================

  // Determine the actual best trial based on metricKey and maximize
  let bestTrial: TrialEntry | null = null;
  for (const trial of campaignState.trialHistory) {
    if (trial.status === 'completed') {
      const val = trial.metrics[metricKey];
      if (val === undefined) continue;
      if (!bestTrial) {
        bestTrial = trial;
      } else {
        const bestVal = bestTrial.metrics[metricKey];
        if (bestVal === undefined) continue;
        const isBetter = maximize ? val > bestVal : val < bestVal;
        if (isBetter) {
          bestTrial = trial;
        }
      }
    }
  }

  const bestMetrics = bestTrial ? bestTrial.metrics : null;
  const bestTrialId = bestTrial ? bestTrial.trialId : null;

  // If the agent provided a summary, update the metrics in it to be the actual best metrics
  if (campaignState.summary && bestMetrics) {
    campaignState.summary.bestMetrics = bestMetrics;
  }

  const campaignEntry: CampaignEntry = {
    campaignId,
    timestamp: new Date().toISOString(),
    question,
    metricKey,
    maximize,
    status: campaignState.status,
    trialCount: campaignState.trialHistory.length,
    bestTrialId,
    bestMetrics,
    summary: campaignState.summary,
    durationMs: Date.now() - startTime,
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

  session.dispose();

  return {
    campaignEntry,
    ratchetImproved,
    historicalBest,
  };
}
