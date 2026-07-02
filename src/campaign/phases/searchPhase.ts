import { randomUUID } from 'node:crypto';
import type { PhaseExecutor } from './types.js';
import type { SearchPlan, SearchResult } from '../types.js';
import { runProgrammaticTrial } from './types.js';

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
      throw new Error('not implemented');
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
