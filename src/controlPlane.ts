/**
 * Control Plane
 *
 * Orchestrates the autonomous experimentation loop by embedding the Pi
 * coding agent and connecting it to the deterministic modules (ExperimentManager,
 * DiscoveryEngine, BackpressureGates, TournamentRatchet).
 */

import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  type AgentSessionEvent,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { ExperimentManager } from './experimentManager.js';
import { getActiveAdapter } from './discoveryEngine.js';
import { runStaticChecks, type StaticCheckResult } from './backpressureGates.js';
import {
  evaluateResult,
  MergeQueue,
  processQueue,
  MergeConflictError,
  type StateManagerForMerge,
} from './tournamentRatchet.js';

// Tool input/output schemas
export interface ProposeHypothesisInput {
  baseBranch: string;
  hypothesisName: string;
}

export interface ProposeHypothesisOutput {
  success: boolean;
  branchName?: string;
  error?: string;
}

export interface DispatchExperimentInput {
  branchName: string;
  command?: string;
  runChecks?: boolean;
}

export interface DispatchExperimentOutput {
  success: boolean;
  jobId?: string;
  checksPassed?: boolean;
  errorOutput?: string;
  error?: string;
}

export interface CheckExperimentStatusInput {
  jobId: string;
  baselineMetric?: number;
  targetMetricKey?: string;
  maximize?: boolean;
}

export interface CheckExperimentStatusOutput {
  status: string;
  filePath?: string;
  evaluated?: boolean;
  improved?: boolean;
  error?: string;
}

export interface MergeExperimentsInput {
  branchName: string;
  targetBranch?: string;
}

export interface MergeExperimentsOutput {
  success: boolean;
  merged?: string[];
  conflictBranch?: string;
  error?: string;
}

// Re-export for convenience
export type { AgentSession as Session };

/**
 * Result of starting the Aesop daemon.
 */
export interface DaemonResult {
  session: AgentSession;
  stop: () => void;
}

/**
 * Configuration options for the control plane.
 */
export interface ControlPlaneOptions {
  /** Working directory for the experiment */
  cwd?: string;
  /** Session manager for persistence (defaults to in-memory) */
  sessionManager?: SessionManager;
  /** Auth storage for API keys */
  authStorage?: AuthStorage;
  /** Model registry */
  modelRegistry?: ModelRegistry;
  /** Settings manager */
  settingsManager?: SettingsManager;
  /** Callback for logging agent events */
  onLog?: (_message: string) => void;
}

/**
 * Create a control plane instance with the experiment-aware tools.
 *
 * This function creates a Pi agent session with custom tools that integrate
 * with the experiment management modules.
 *
 * @param options - Configuration options
 * @returns Object containing the session and a stop function
 */
export async function createAesopSession(options: ControlPlaneOptions = {}): Promise<DaemonResult> {
  const {
    sessionManager = SessionManager.inMemory(),
    authStorage = AuthStorage.create(),
    modelRegistry = ModelRegistry.create(authStorage),
    settingsManager = SettingsManager.inMemory(),
    onLog = console.log,
  } = options;

  // Create the agent session with built-in coding tools
  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
    settingsManager,
  });

  // Subscribe to events for logging
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === 'tool_execution_start') {
      onLog(`\n[Tool] ${event.toolName}`);
    }
  });

  return {
    session,
    stop: () => {
      onLog('[ControlPlane] Session stopped');
    },
  };
}

/**
 * Propose a new hypothesis by creating a branch.
 *
 * This tool wraps ExperimentManager.createBranch to create a new
 * experiment branch from a hypothesis.
 *
 * @param input - Branch parameters
 * @param options - Control plane options
 * @returns Result with branch name or error
 */
export async function proposeHypothesis(
  input: ProposeHypothesisInput,
  options: ControlPlaneOptions = {}
): Promise<ProposeHypothesisOutput> {
  try {
    const manager = new ExperimentManager(options.cwd ?? process.cwd());
    const branchName = await manager.createBranch(input.baseBranch, input.hypothesisName);
    return { success: true, branchName };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Dispatch an experiment to the available compute backend.
 *
 * This tool optionally runs backpressure gates, then submits the job
 * to the active execution adapter.
 *
 * @param input - Dispatch parameters
 * @param _options - Control plane options
 * @returns Result with job ID or error
 */
export async function dispatchExperiment(
  input: DispatchExperimentInput,
  _options: ControlPlaneOptions = {}
): Promise<DispatchExperimentOutput> {
  try {
    const {
      branchName,
      command = `python train.py --branch ${input.branchName}`,
      runChecks = true,
    } = input;
    const cwd = _options.cwd ?? process.cwd();

    // Run backpressure gates if enabled
    if (runChecks) {
      const checkResult: StaticCheckResult = await runStaticChecks(cwd);
      if (!checkResult.success) {
        return {
          success: false,
          checksPassed: false,
          errorOutput: checkResult.errorOutput ?? 'Validation failed',
        };
      }
    }

    // Submit job to active adapter
    const adapter = await getActiveAdapter();
    const jobId = await adapter.submitJob(branchName, command);

    return { success: true, jobId, checksPassed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Check the status of an experiment and optionally evaluate results.
 *
 * This tool wraps the execution adapter's checkStatus and optionally
 * evaluates results against a baseline.
 *
 * @param input - Status check parameters
 * @param _options - Control plane options
 * @returns Status result with optional evaluation
 */
export async function checkExperimentStatus(
  input: CheckExperimentStatusInput,
  _options: ControlPlaneOptions = {}
): Promise<CheckExperimentStatusOutput> {
  try {
    const adapter = await getActiveAdapter();
    const status = await adapter.checkStatus(input.jobId);

    // If completed and baseline provided, evaluate
    if (status.status === 'completed' && status.filePath && input.baselineMetric !== undefined) {
      const improved = await evaluateResult(
        status.filePath,
        input.baselineMetric,
        input.targetMetricKey ?? 'primaryMetric',
        input.maximize ?? true
      );
      return { ...status, evaluated: true, improved };
    }

    const result: CheckExperimentStatusOutput = { status: status.status };
    if (status.filePath) {
      result.filePath = status.filePath;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', error: message };
  }
}

/**
 * Merge experiment branches that have passed evaluation.
 *
 * This tool processes the merge queue and merges successful branches
 * into the target branch.
 *
 * @param input - Merge parameters
 * @param _options - Control plane options
 * @returns Merge result
 */
export async function mergeExperiments(
  input: MergeExperimentsInput,
  _options: ControlPlaneOptions = {}
): Promise<MergeExperimentsOutput> {
  try {
    const { branchName, targetBranch = 'main' } = input;
    const manager = new ExperimentManager(_options.cwd ?? process.cwd());

    // Create a queue with the single branch
    const queue = new MergeQueue();
    queue.add(branchName, 0, ''); // Metric value not used for single merge

    // Create a state manager wrapper
    const stateManager: StateManagerForMerge = {
      async mergeBranch(source: string, target: string): Promise<boolean> {
        return manager.mergeBranch(source, target);
      },
    };

    try {
      const result = await processQueue(queue, stateManager, targetBranch);
      return { success: true, merged: result.merged };
    } catch (error) {
      if (error instanceof MergeConflictError) {
        return { success: false, conflictBranch: error.branchName };
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Start the Aesop daemon with an objective.
 *
 * This function initializes the Pi session with experiment-aware tools
 * and sends the initial objective prompt to kick off the autonomous loop.
 *
 * @param objective - The experiment objective to pursue
 * @param options - Control plane options
 * @returns The daemon result with session and stop function
 */
export async function startAesopDaemon(
  objective: string,
  options: ControlPlaneOptions = {}
): Promise<DaemonResult> {
  const { onLog = console.log } = options;

  onLog('[ControlPlane] Starting Aesop daemon...');
  onLog(`[ControlPlane] Objective: ${objective}`);
  onLog('');

  // Create the session
  const result = await createAesopSession(options);
  const { session, stop } = result;

  // Send the initial objective
  onLog('[ControlPlane] Initializing experiment loop...');
  await session.prompt(objective);

  onLog('\n[ControlPlane] Experiment loop initiated.');
  onLog('[ControlPlane] Use session.subscribe() to monitor progress.');

  return {
    session,
    stop,
  };
}

/**
 * Run a complete experiment workflow.
 *
 * This is a simplified helper that runs a single hypothesis test:
 * 1. Create branch
 * 2. Run backpressure checks
 * 3. Submit job
 * 4. Return job ID for status checking
 *
 * @param hypothesis - The hypothesis to test
 * @param options - Control plane options
 * @returns Workflow result
 */
export async function runExperimentWorkflow(
  hypothesis: string,
  options: ControlPlaneOptions = {}
): Promise<{
  branchName?: string;
  jobId?: string;
  success: boolean;
  error?: string;
}> {
  // Step 1: Create branch
  const branchResult = await proposeHypothesis(
    { baseBranch: 'main', hypothesisName: hypothesis },
    options
  );

  if (!branchResult.success || !branchResult.branchName) {
    return { success: false, error: branchResult.error ?? 'Failed to create branch' };
  }

  // Step 2: Run backpressure checks
  const checkResult = await runStaticChecks(options.cwd ?? process.cwd());
  if (!checkResult.success) {
    return {
      success: false,
      branchName: branchResult.branchName,
      error: `Backpressure checks failed:\n${checkResult.errorOutput}`,
    };
  }

  // Step 3: Dispatch job
  const dispatchResult = await dispatchExperiment(
    { branchName: branchResult.branchName, runChecks: false },
    options
  );

  if (!dispatchResult.success || !dispatchResult.jobId) {
    return {
      success: false,
      branchName: branchResult.branchName,
      error: dispatchResult.error ?? dispatchResult.errorOutput ?? 'Failed to dispatch',
    };
  }

  return {
    success: true,
    branchName: branchResult.branchName,
    jobId: dispatchResult.jobId,
  };
}

export default startAesopDaemon;
