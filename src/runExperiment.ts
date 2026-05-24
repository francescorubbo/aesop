/**
 * Run Experiment
 *
 * Core experiment harness that composes:
 * - WorkspaceManager (snapshot + isolated worktree)
 * - Pi SDK agent (autonomous mutation)
 * - validateContract (strict result verification)
 * - Ratchet (monotonic improvement enforcement)
 *
 * This is the "inner loop" of Aesop's autonomous experimentation.
 */

import { resolve, join } from 'node:path';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';

import { WorkspaceManager } from './workspaceManager.js';
import { runWithValidation } from './validateContract.js';
import { checkRatchet, type RatchetResult } from './ratchet.js';
import { LedgerManager, type LedgerEntry } from './ledger.js';

/**
 * Options for running an experiment.
 */
export interface RunExperimentOptions {
  /** Absolute path to the project directory */
  projectDir: string;
  /** Natural language description of the hypothesis to test */
  hypothesis: string;
  /** Command to run for validation (e.g., './aesop_validate.sh') */
  validateCmd: string;
  /** Primary metric key to optimize (e.g., 'accuracy') */
  metricKey: string;
  /** Optional model override for the Pi agent */
  model?: string;
  /**
   * Maximum agent mutation attempts before giving up.
   * Each "attempt" is one agent turn (edit cycle).
   * Default: 20
   */
  maxIterations?: number;
  /** Optional ledger path override. Defaults to 'experiments.jsonl' in projectDir */
  ledgerPath?: string;
  /**
   * Optional callback for logging progress.
   * Called with status updates during experiment execution.
   */
  onLog?: (_message: string) => void;
}

/**
 * Result of running an experiment.
 */
export interface RunExperimentResult {
  /** Experiment outcome */
  status: 'success' | 'failure' | 'no_improvement';
  /** Metrics recorded during the experiment (only if validation passed) */
  metrics?: Record<string, number>;
  /** Branch name created for this experiment */
  branch: string;
  /** The ledger entry that was recorded */
  ledgerEntry: LedgerEntry;
}

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
 * Build the experiment-aware system prompt for the Pi agent.
 */
function buildSystemPrompt(
  hypothesis: string,
  validateCmd: string,
  metricKey: string,
  workspacePath: string
): string {
  return `You are an ML experiment agent. Your task is:
<hypothesis>${hypothesis}</hypothesis>

Rules:
- You may only edit files within this workspace. Do not read from or write to paths outside it.
- After each set of changes, run the validate command: ${validateCmd}
- The validate command writes eval_result.json. Your goal is to make the ${metricKey} value as high as possible.
- When you are satisfied with your result, stop. Do not keep iterating if the metric is not improving.
- Do not modify the validate script or eval_result.json directly.

Workspace path: ${workspacePath}`;
}

/**
 * Run a complete experiment with the given hypothesis.
 *
 * The experiment sequence:
 * 1. Sync current user code into managed repo
 * 2. Create isolated ephemeral workspace on a new branch
 * 3. Run the Pi SDK agent in the workspace with experiment-aware prompt
 * 4. Validate the results via runWithValidation
 * 5. Check ratchet for improvement
 * 6. Log result to ledger and clean up workspace
 *
 * @param options - Experiment configuration
 * @returns Promise resolving to experiment result
 *
 * @example
 * ```typescript
 * const result = await runExperiment({
 *   projectDir: '/path/to/project',
 *   hypothesis: 'Increase learning rate to 0.01 improves accuracy',
 *   validateCmd: './scripts/evaluate.sh',
 *   metricKey: 'accuracy',
 *   maxIterations: 30,
 * });
 *
 * if (result.status === 'success') {
 *   console.log(`New best ${result.metrics?.accuracy}`);
 * }
 * ```
 */
export async function runExperiment(options: RunExperimentOptions): Promise<RunExperimentResult> {
  const {
    projectDir,
    hypothesis,
    validateCmd,
    metricKey,
    model,
    maxIterations = 20,
    ledgerPath: ledgerPathOverride,
    onLog = () => {
      /* noop */
    },
  } = options;

  const startTime = Date.now();
  const resolvedProjectDir = resolve(projectDir);
  const branchName = `hypothesis/${slugify(hypothesis)}`;
  const ledgerPath = ledgerPathOverride ?? join(resolvedProjectDir, 'experiments.jsonl');

  const workspaceManager = new WorkspaceManager(resolvedProjectDir);
  const ledger = new LedgerManager({ ledgerPath });

  let workspace: Awaited<ReturnType<WorkspaceManager['createEphemeralWorkspace']>> | null = null;
  let agentSession: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  let agentResourceLoader: DefaultResourceLoader | null = null;

  const log = (msg: string): void => {
    onLog(`[runExperiment] ${msg}`);
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
    workspace = await workspaceManager.createEphemeralWorkspace(branchName);
    log(`Workspace created at: ${workspace.path}`);

    // =====================================================================
    // STEP 3: Build agent system prompt
    // =====================================================================
    const systemPrompt = buildSystemPrompt(hypothesis, validateCmd, metricKey, workspace.path);

    agentResourceLoader = new DefaultResourceLoader({
      cwd: workspace.path,
      agentDir: getAgentDir(),
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await agentResourceLoader.reload();

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

    log(`Model option from config: ${model ?? 'none'}`);

    // Resolve model if provided (format: "provider/model-id")
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
        } else {
          log(`Warning: Model ${model} not found, using default`);
        }
      } else {
        log(`Warning: Model string "${model}" not in "provider/model-id" format, using default`);
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

    // Run the agent with iteration budget by running prompt multiple times
    // until maxIterations is reached or the agent signals completion
    let iterationCount = 0;

    while (iterationCount < maxIterations) {
      iterationCount++;
      log(`Iteration ${iterationCount}/${maxIterations}`);

      // The agent runs until user prompt returns
      await session.prompt(
        `Iteration ${iterationCount}. Make changes to improve the ${metricKey} metric, ` +
          `then run: ${validateCmd}. ` +
          `Stop when you have achieved a good result.`
      );

      log(`Agent turn ${iterationCount} complete`);

      // For now, run all iterations - the agent decides when to stop
      // In a future enhancement, the agent could signal completion via a tool result
      if (iterationCount >= maxIterations) {
        log('Reached max iterations, stopping agent');
        break;
      }
    }

    log(`Agent finished after ${iterationCount} iterations, disposing session...`);

    // Dispose the session
    session.dispose();
    log('Session disposed');

    // =====================================================================
    // STEP 5: Validate results
    // =====================================================================
    log('Running validation...');
    const validationResult = await runWithValidation(workspace.path, validateCmd, metricKey);

    if (!validationResult.success) {
      const error = validationResult.error ?? 'Validation failed';

      log(`Validation failed: ${error}`);

      const entry = createLedgerEntry({
        branch: branchName,
        baseCommit: syncResult.commitHash,
        hypothesisCommit: '', // Agent didn't reach a commit we track
        status: 'failure',
        metrics: {},
        error,
        durationMs: Date.now() - startTime,
      });

      ledger.append(entry);

      return {
        status: 'failure',
        branch: branchName,
        ledgerEntry: entry,
      };
    }

    log(`Validation passed. Metrics: ${JSON.stringify(validationResult.metrics)}`);

    // =====================================================================
    // STEP 6: Check ratchet for improvement
    // =====================================================================
    const currentValue = validationResult.metrics[metricKey];
    if (currentValue === undefined) {
      throw new Error(`Metric ${metricKey} not found in validation results`);
    }

    const ratchetResult: RatchetResult = checkRatchet(ledgerPath, metricKey, currentValue);

    log(
      ratchetResult.improved
        ? `Improved! ${currentValue} > ${ratchetResult.best}`
        : `No improvement. Current: ${currentValue}, Best: ${ratchetResult.best}`
    );

    // =====================================================================
    // STEP 7: Get hypothesis commit hash for ledger
    // =====================================================================
    let hypothesisCommit = '';
    try {
      const git = workspaceManager.getGit();
      const branchStatus = await git.branchLocal();
      const currentBranch = branchStatus.current;
      if (currentBranch) {
        const logResult = await git
          .log({ maxCount: 1, from: branchName, to: branchName })
          .catch(() => null);
        if (logResult?.all?.[0]?.hash) {
          hypothesisCommit = logResult.all[0].hash;
        }
      }
    } catch {
      // Ignore commit hash errors - ledger entry will have empty commit
    }

    // =====================================================================
    // STEP 8: Determine final status and log
    // =====================================================================
    const finalStatus: 'success' | 'no_improvement' =
      ratchetResult.improved && ratchetResult.bestBranch !== branchName
        ? 'success'
        : 'no_improvement';

    const ledgerEntry = createLedgerEntry({
      branch: branchName,
      baseCommit: syncResult.commitHash,
      hypothesisCommit,
      status: finalStatus,
      metrics: validationResult.metrics,
      durationMs: Date.now() - startTime,
    });

    ledger.append(ledgerEntry);

    log(`Experiment ${finalStatus}. Branch: ${branchName}`);

    return {
      status: finalStatus,
      metrics: validationResult.metrics,
      branch: branchName,
      ledgerEntry,
    };
  } finally {
    // =====================================================================
    // CLEANUP: Dispose workspace regardless of outcome
    // =====================================================================
    if (workspace) {
      try {
        log(`Disposing workspace: ${workspace.path}`);
        await workspace.dispose();
      } catch (error) {
        log(`Warning: Failed to dispose workspace: ${String(error)}`);
      }
    }

    // Clean up agent resources
    if (agentSession) {
      try {
        agentSession.dispose();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Helper to create a properly typed ledger entry.
 */
function createLedgerEntry(data: Omit<LedgerEntry, 'timestamp'>): LedgerEntry {
  return {
    timestamp: new Date().toISOString(),
    ...data,
  };
}

export default runExperiment;
