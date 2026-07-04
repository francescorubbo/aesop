import { randomUUID } from 'node:crypto';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { PhaseExecutor } from './types.js';
import type { SearchPlan, SearchResult } from '../types.js';
import { runProgrammaticTrial } from './types.js';
import {
  buildCampaignSystemPrompt,
  buildCampaignIterationPrompt,
  createCampaignToolsExtension,
  type CompleteCampaignArgs,
} from '../campaignAgent.js';

/**
 * Utility to compute the Cartesian product of a search space.
 * @param space A record where keys are parameter names and values are arrays of possible values.
 * @returns An array of all possible combinations.
 */
function cartesian(space: Record<string, string[]>): Record<string, string>[] {
  const keys = Object.keys(space);
  const result: Record<string, string>[] = [];

  function backtrack(index: number, current: Record<string, string>) {
    if (index === keys.length) {
      result.push({ ...current });
      return;
    }

    const key = keys[index] as string;
    const values = space[key];
    if (values) {
      for (const value of values) {
        current[key] = value;
        backtrack(index + 1, current);
      }
    }
  }

  backtrack(0, {});
  return result;
}

/**
 * Utility to sample N random configurations from a list of possible configs.
 * @param configs The full list of configurations.
 * @param n The number of samples to take.
 * @returns A list of sampled configurations.
 */
function sample(configs: Record<string, string>[], n: number): Record<string, string>[] {
  const shuffled = [...configs].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

/**
 * Converts a configuration map to a human-readable string.
 * @param args Map of flag names to values.
 * @returns Formatted string.
 */
function argsToString(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

export const searchPhaseExecutor: PhaseExecutor<SearchPlan, SearchResult> = {
  async execute(plan, ctx): Promise<SearchResult> {
    const start = Date.now();

    if (plan.strategy === 'agent_guided') {
      // Agent-guided loop implementation
      const authStorage = AuthStorage.create();
      if (process.env['GEMINI_API_KEY']) {
        authStorage.setRuntimeApiKey('google', process.env['GEMINI_API_KEY']!);
      }
      if (process.env['ANTHROPIC_API_KEY']) {
        authStorage.setRuntimeApiKey('anthropic', process.env['ANTHROPIC_API_KEY']!);
      }
      const modelRegistry = ModelRegistry.create(authStorage);

      const campaignState = {
        done: false,
        summary: null as CompleteCampaignArgs | null,
        trialHistory: [] as Array<{
          trialId: string;
          args: Record<string, string>;
          metrics: Record<string, number> | null;
          status: string;
        }>,
      };

      const onComplete = (args: CompleteCampaignArgs) => {
        campaignState.done = true;
        campaignState.summary = args;
      };

      const onRunTrial = async (args: Record<string, string>) => {
        try {
          const result = await runProgrammaticTrial(ctx, args);
          const metrics = result.success ? result.metrics : null;
          const status = result.success ? 'completed' : 'failed';
          const trialId = randomUUID();

          campaignState.trialHistory.push({
            trialId,
            args,
            metrics,
            status,
          });

          return {
            trialId,
            metrics,
            status,
            ...(result.error ? { error: result.error } : {}),
          };
        } catch (e) {
          return {
            trialId: randomUUID(),
            metrics: null,
            status: 'failed',
            error: String(e),
          };
        }
      };

      // Use a generic question and baseline for the prompt since we are in a phase
      const systemPrompt = buildCampaignSystemPrompt(
        'Optimize parameters in the search space',
        ctx.metricKey ?? 'accuracy',
        0, // Baseline is handled by the baseline phase, here we just need a prompt
        ctx.maximize ?? true
      );

      const resourceLoader = new DefaultResourceLoader({
        cwd: ctx.workspacePath,
        agentDir: getAgentDir(),
        extensionFactories: [createCampaignToolsExtension(onRunTrial, onComplete)],
        systemPromptOverride: () => systemPrompt,
        appendSystemPromptOverride: () => [],
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: ctx.workspacePath,
        sessionManager: SessionManager.inMemory(ctx.workspacePath),
        resourceLoader,
        authStorage,
        modelRegistry,
        tools: ['read', 'bash', 'edit', 'write', 'run_trial', 'complete_campaign'],
      });

      const maxTrials = plan.maxTrials ?? 10;
      for (let i = 0; i < maxTrials; i++) {
        const trialsRemaining = maxTrials - i;
        const history = campaignState.trialHistory.map((t) => ({
          trialId: t.trialId,
          hypothesis: argsToString(t.args),
          metrics: t.metrics,
          status: t.status,
        }));

        await session.prompt(buildCampaignIterationPrompt(history, trialsRemaining));

        if (campaignState.done) {
          break;
        }
      }

      if (!campaignState.done) {
        await session.prompt(
          `You have used all ${maxTrials} trials. Call complete_campaign now with your best assessment.`
        );
      }

      session.dispose();

      // Transform agent trial history into SearchResult.rankedConfigs
      const results = campaignState.trialHistory
        .filter((t) => t.status === 'completed' && t.metrics)
        .map((t) => ({
          trialId: t.trialId,
          configuration: argsToString(t.args),
          metrics: t.metrics!,
        }));

      const metricKey = ctx.metricKey ?? 'accuracy';
      const maximize = ctx.maximize ?? true;

      results.sort((a, b) => {
        const valA = a.metrics[metricKey] ?? 0;
        const valB = b.metrics[metricKey] ?? 0;
        return maximize ? valB - valA : valA - valB;
      });

      const best = results[0] ?? null;

      return {
        kind: 'search',
        status: 'completed',
        trialCount: campaignState.trialHistory.length,
        bestTrialId: best?.trialId ?? null,
        bestMetrics: best?.metrics ?? null,
        bestConfiguration: best?.configuration ?? null,
        rankedConfigs: results,
        durationMs: Date.now() - start,
      };
    }

    const allConfigs = cartesian(plan.searchSpace);
    const configs =
      plan.strategy === 'random'
        ? sample(allConfigs, plan.maxTrials ?? allConfigs.length)
        : allConfigs;

    const results: Array<{
      trialId: string;
      configuration: string;
      metrics: Record<string, number>;
    }> = [];

    for (const args of configs) {
      const result = await runProgrammaticTrial(ctx, args);
      if (result.success) {
        results.push({
          trialId: randomUUID(),
          configuration: argsToString(args),
          metrics: result.metrics,
        });
      }
    }

    const metricKey = ctx.metricKey ?? 'accuracy';
    const maximize = ctx.maximize ?? true;

    results.sort((a, b) => {
      const valA = a.metrics[metricKey] ?? 0;
      const valB = b.metrics[metricKey] ?? 0;
      return maximize ? valB - valA : valA - valB;
    });

    const best = results[0] ?? null;

    return {
      kind: 'search',
      status: 'completed',
      trialCount: configs.length,
      bestTrialId: best?.trialId ?? null,
      bestMetrics: best?.metrics ?? null,
      bestConfiguration: best?.configuration ?? null,
      rankedConfigs: results,
      durationMs: Date.now() - start,
    };
  },
};
