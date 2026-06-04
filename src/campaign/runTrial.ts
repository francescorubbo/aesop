/**
 * Run Trial
 *
 * The inner loop for a campaign trial. A specialized version of the experiment harness
 * that focuses on implementing a specific configuration change without ratchet enforcement.
 */

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

import { WorkspaceManager } from '../workspaceManager.js';
import { runWithValidation, type ValidationResult } from '../validateContract.js';
import { TrialLedger } from './trialLedger.js';
import { createSandboxExtension } from '../sandboxExtension.js';
import { createExperimentTracer, summariseTrace, readTrace } from '../traceLogger.js';
import { type RunTrialOptions, type RunTrialResult, type TrialEntry } from './types.js';

/**
 * Slugify a string for use in paths and branch names.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Build the trial-aware system prompt for the Pi agent.
 */
function buildSystemPrompt(trialHypothesis: string, workspacePath: string): string {
  return `You are an ML experiment trial agent. Implement the following configuration change exactly as described:
<hypothesis>${trialHypothesis}</hypothesis>

Rules:
- Implement this specific change. Do not explore alternatives or make additional optimisations.
- You may only edit files within this workspace.
- The harness validates after each turn and reports metrics back to you.
- Do not modify the validate script or eval_result.json directly.

Workspace: ${workspacePath}`;
}

/**
 * Run a complete trial.
 *
 * The trial sequence:
 * 1. Sync current user code into managed repo
 * 2. Create isolated ephemeral workspace on a new branch
 * 3. Run the Pi SDK agent in the workspace with trial-aware prompt
 * 4. Validate the results after each iteration and provide rich feedback
 * 5. Log final result to trial ledger and clean up workspace
 *
 * @param options - Trial configuration
 * @returns Promise resolving to trial result
 */
export async function runTrial(options: RunTrialOptions): Promise<RunTrialResult> {
  const {
    projectDir,
    campaignId,
    trialHypothesis,
    validateCmd,
    metricKey,
    model,
    maxIterations = 10,
    onLog = () => {
      /* noop */
    },
  } = options;

  const startTime = Date.now();
  const resolvedProjectDir = resolve(projectDir);
  const trialId = randomUUID();
  const branchName = `trial/${campaignId}/${slugify(trialHypothesis)}`;
  const ledgerPath = join(resolvedProjectDir, 'trials.jsonl');

  const workspaceManager = new WorkspaceManager(resolvedProjectDir);
  const ledger = new TrialLedger({ ledgerPath });

  let workspace: Awaited<ReturnType<WorkspaceManager['createEphemeralWorkspace']>> | null = null;
  let agentSession: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  let agentResourceLoader: DefaultResourceLoader | null = null;

  const log = (msg: string): void => {
    onLog(`[runTrial] ${msg}`);
  };

  try {
    // =====================================================================
    // STEP 1: Sync user code into managed repo
    // =====================================================================
    log('Syncing user code to managed repository...');
    const syncResult = await workspaceManager.sync();
    log(`Synced to commit: ${syncResult.commitHash}`);

    // =====================================================================
    // STEP 2: Create ephemeral workspace
    // =====================================================================
    log(`Creating ephemeral workspace for branch: ${branchName}`);
    workspace = await workspaceManager.createEphemeralWorkspace(branchName, { force: true });
    log(`Workspace created at: ${workspace.path}`);

    // =====================================================================
    // STEP 2.5: Initialise experiment tracer
    // =====================================================================
    const tracer = createExperimentTracer({ branch: branchName, projectDir: resolvedProjectDir });
    log(`Trace directory: ${tracer.traceDir}`);

    // =====================================================================
    // STEP 3: Build agent system prompt
    // =====================================================================
    const systemPrompt = buildSystemPrompt(trialHypothesis, workspace.path);

    agentResourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir: getAgentDir(),
      extensionFactories: [createSandboxExtension(workspace.path), tracer.extension],
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await agentResourceLoader.reload();

    // =====================================================================
    // STEP 3.5: Establish baseline
    // =====================================================================
    log('Establishing baseline metrics...');
    const baselineResult = await runWithValidation(workspace.path, validateCmd, metricKey);
    if (!baselineResult.success) {
      throw new Error(
        `Baseline validation failed. The provided validation command "${validateCmd}" must succeed and produce a valid ${metricKey} metric before a trial can start. Error: ${baselineResult.error}`
      );
    }
    const baselineValue = baselineResult.metrics[metricKey];
    if (baselineValue === undefined) {
      throw new Error(
        `Baseline validation succeeded but metric ${metricKey} not found in results.`
      );
    }
    log(`Baseline established: ${metricKey} = ${baselineValue}`);

    // =====================================================================
    // STEP 4: Run Pi SDK agent with iteration budget
    // =====================================================================

    log(`Starting agent with maxIterations=${maxIterations}...`);

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

    const { session } = await createAgentSession({
      cwd: workspace.path,
      sessionManager: SessionManager.inMemory(workspace.path),
      resourceLoader: agentResourceLoader,
      authStorage,
      modelRegistry,
      model: resolvedModel,
      tools: ['read', 'bash', 'edit', 'write'],
    });

    agentSession = session;

    log('Agent session created, starting interaction loop...');

    let lastIteration = 0;
    let lastInterimResult: ValidationResult | null = null;
    const iterationHistory: Record<string, number>[] = [];

    for (let i = 0; i < maxIterations; i++) {
      lastIteration = i + 1;
      log(`Agent iteration ${i + 1}/${maxIterations}`);
      await session.prompt(
        `Iteration ${i + 1}. Implement the requested change, then run: ${validateCmd}.`
      );

      log('Running validation after agent iteration...');
      const interim = await runWithValidation(workspace.path, validateCmd, metricKey);
      lastInterimResult = interim;

      tracer.captureDiff(workspace.path, i + 1);
      tracer.recordIteration(i + 1, interim.success ? interim.metrics : null);

      if (interim.success) {
        const metrics = interim.metrics;
        log(`Validation succeeded. Metrics: ${JSON.stringify(metrics)}`);
        const value = metrics[metricKey];

        if (value === undefined) {
          log(`Warning: Metric ${metricKey} not found. Skipping history update.`);
          await session.prompt(
            `Validation succeeded but metric ${metricKey} not found. Fix the validate command output and try again.`
          );
          continue;
        }

        iterationHistory.push(metrics);

        const historyString = iterationHistory
          .map((h, n) => `iter${n + 1}=${h[metricKey]}`)
          .join(', ');

        await session.prompt(
          `Iteration ${i + 1} result: ${JSON.stringify(metrics)}.
History: ${historyString}.
Baseline: ${metricKey}=${baselineValue}.
Keep implementing the hypothesis. Do not change the objective — focus on making the specified change work.`
        );
      } else {
        await session.prompt(`Validation failed: ${interim.error}. Fix the issue and try again.`);
      }
    }

    log(`Agent finished after ${lastIteration} iterations...`);

    // =====================================================================
    // STEP 5: Final Validation
    // =====================================================================

    const validationResult = lastInterimResult?.success
      ? lastInterimResult
      : await (async () => {
          log('Running final validation...');
          return runWithValidation(workspace.path, validateCmd, metricKey);
        })();

    // =====================================================================
    // STEP 6: Determine status and record to ledger
    // =====================================================================

    let status: 'completed' | 'failed' = 'failed';
    let error: string | undefined;
    let finalMetrics: Record<string, number> = {};

    if (validationResult.success) {
      const value = validationResult.metrics[metricKey];
      if (value !== undefined) {
        status = 'completed';
        finalMetrics = validationResult.metrics;
        log(`Trial completed. Metrics: ${JSON.stringify(finalMetrics)}`);
      } else {
        error = `Validation succeeded but metric ${metricKey} not found.`;
        log(`Trial failed: ${error}`);
      }
    } else {
      error = validationResult.error ?? 'Validation failed';
      log(`Trial failed: ${error}`);
    }

    let hypothesisCommit = '';
    try {
      const hash = await workspaceManager
        .getGit()
        .revparse([branchName])
        .catch(() => null);
      if (hash) {
        hypothesisCommit = hash.trim();
      }
    } catch {
      // Ignore
    }

    const trialEntry: TrialEntry = {
      trialId,
      campaignId,
      timestamp: new Date().toISOString(),
      branch: branchName,
      baseCommit: syncResult.commitHash,
      hypothesisCommit,
      trialHypothesis,
      status,
      metrics: finalMetrics,
      error,
      durationMs: Date.now() - startTime,
    };

    await ledger.append(trialEntry);

    tracer.captureDiff(workspace.path, 'final', syncResult.commitHash);
    const traceSummary = summariseTrace(readTrace(tracer.traceFile));
    log(
      `Trial ${status}. Trace: ${traceSummary.toolCallCount} tool calls, ` +
        `${traceSummary.iterationCount} iterations — see ${tracer.traceDir}`
    );

    return {
      trialEntry,
      traceDir: tracer.traceDir,
    };
  } finally {
    if (workspace) {
      try {
        log(`Disposing workspace: ${workspace.path}`);
        await workspace.dispose();
      } catch (error) {
        log(`Warning: Failed to dispose workspace: ${String(error)}`);
      }
    }

    if (agentSession) {
      try {
        agentSession.dispose();
      } catch {
        // Ignore
      }
    }
  }
}
