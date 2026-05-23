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

// Cache for ExperimentManager instances to maintain state across tool calls
const managerCache = new Map<string, ExperimentManager>();

function getExperimentManager(cwd: string): ExperimentManager {
  let manager = managerCache.get(cwd);
  if (!manager) {
    manager = new ExperimentManager(cwd);
    managerCache.set(cwd, manager);
  }
  return manager;
}
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
  /** Use ephemeral workspace (default: false) */
  ephemeral?: boolean;
}

export interface ProposeHypothesisOutput {
  success: boolean;
  branchName?: string;
  /** Workspace path for the agent to use (only in ephemeral mode) */
  workspacePath?: string;
  error?: string;
}

export interface DispatchExperimentInput {
  /** Branch name or workspace path */
  branchName: string;
  command?: string;
  runChecks?: boolean;
  /** Path to execute command in (defaults to branchName if it's a path) */
  workingDirectory?: string;
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

export interface InitializeWorkspaceInput {
  /** Path to the target repository to sandbox */
  targetRepoPath: string;
  /** Root directory for workspaces (default: .aesop_workspaces) */
  workspaceRoot?: string;
}

export interface InitializeWorkspaceOutput {
  success: boolean;
  sessionId?: string;
  workspaceRoot?: string;
  basePath?: string;
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
  /** Target repository path for ephemeral workspaces */
  targetRepoPath?: string;
  /** Workspace root for ephemeral mode */
  workspaceRoot?: string;
  /** Whether to use ephemeral workspaces by default */
  useEphemeralWorkspaces?: boolean;
  /** Custom validation command (default: './aesop_validate.sh') */
  validateCmd?: string;
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
 * Initialize an ephemeral workspace for hypothesis experiments.
 *
 * This clones the target repository into an isolated workspace directory,
 * enabling safe parallel experimentation.
 *
 * @param input - Initialization parameters
 * @param options - Control plane options
 * @returns Result with workspace info or error
 */
export async function initializeEphemeralWorkspace(
  input: InitializeWorkspaceInput,
  options: ControlPlaneOptions = {}
): Promise<InitializeWorkspaceOutput> {
  try {
    const manager = getExperimentManager(options.cwd ?? process.cwd());
    const workspaceInfo = await manager.initEphemeralWorkspace(
      input.targetRepoPath,
      input.workspaceRoot ?? '.aesop_workspaces'
    );

    return {
      success: true,
      sessionId: workspaceInfo.sessionId,
      workspaceRoot: workspaceInfo.workspaceRoot,
      basePath: workspaceInfo.basePath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Propose a new hypothesis by creating a branch or workspace.
 *
 * In ephemeral mode, this creates a complete isolated workspace.
 * In normal mode, this creates a new Git branch.
 *
 * @param input - Branch parameters
 * @param options - Control plane options
 * @returns Result with branch/workspace info or error
 */
export async function proposeHypothesis(
  input: ProposeHypothesisInput,
  options: ControlPlaneOptions = {}
): Promise<ProposeHypothesisOutput> {
  try {
    const manager = getExperimentManager(options.cwd ?? process.cwd());

    // Check if ephemeral mode is requested
    const useEphemeral = input.ephemeral ?? options.useEphemeralWorkspaces ?? false;

    if (useEphemeral) {
      // Create ephemeral workspace
      const workspacePath = await manager.createHypothesisWorkspace(
        input.hypothesisName,
        input.baseBranch
      );

      return {
        success: true,
        branchName: input.hypothesisName,
        workspacePath,
      };
    }

    // Create local branch
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
      workingDirectory,
    } = input;

    // Determine working directory: use provided one, or if branchName looks like a path, use it
    const cwd = workingDirectory ?? _options.cwd ?? process.cwd();

    // Run backpressure gates if enabled
    if (runChecks) {
      const checkResult: StaticCheckResult = await runStaticChecks(cwd, _options.validateCmd);
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
    const jobId = await adapter.submitJob(branchName, command, cwd);

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
    const manager = getExperimentManager(_options.cwd ?? process.cwd());

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

  if (options.targetRepoPath) {
    onLog(`[ControlPlane] Target repo: ${options.targetRepoPath}`);
  }

  if (options.useEphemeralWorkspaces) {
    onLog('[ControlPlane] Using ephemeral workspaces for isolation');
  }

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
 * 1. Create branch or workspace
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
  workspacePath?: string;
  jobId?: string;
  success: boolean;
  error?: string;
}> {
  // Step 1: Create branch or workspace
  const useEphemeral = options.useEphemeralWorkspaces ?? false;

  const branchResult = await proposeHypothesis(
    { baseBranch: 'main', hypothesisName: hypothesis, ephemeral: useEphemeral },
    options
  );

  if (!branchResult.success) {
    return { success: false, error: branchResult.error ?? 'Failed to create branch' };
  }

  const workingDir = branchResult.workspacePath ?? options.cwd ?? process.cwd();

  // Step 2: Run backpressure checks
  const checkResult = await runStaticChecks(workingDir);
  if (!checkResult.success) {
    const result: { success: false; branchName?: string; workspacePath?: string; error: string } = {
      success: false,
      error: `Backpressure checks failed:\n${checkResult.errorOutput}`,
    };
    if (branchResult.branchName !== undefined) result.branchName = branchResult.branchName;
    if (branchResult.workspacePath !== undefined) result.workspacePath = branchResult.workspacePath;
    return result;
  }

  // Step 3: Dispatch job
  const dispatchResult = await dispatchExperiment(
    {
      branchName: branchResult.branchName ?? hypothesis,
      runChecks: false,
      workingDirectory: workingDir,
    },
    options
  );

  if (!dispatchResult.success || !dispatchResult.jobId) {
    const result: { success: false; branchName?: string; workspacePath?: string; error: string } = {
      success: false,
      error: dispatchResult.error ?? dispatchResult.errorOutput ?? 'Failed to dispatch',
    };
    if (branchResult.branchName !== undefined) result.branchName = branchResult.branchName;
    if (branchResult.workspacePath !== undefined) result.workspacePath = branchResult.workspacePath;
    return result;
  }

  const successResult: {
    success: true;
    branchName?: string;
    workspacePath?: string;
    jobId: string;
  } = {
    success: true,
    jobId: dispatchResult.jobId,
  };
  if (branchResult.branchName !== undefined) successResult.branchName = branchResult.branchName;
  if (branchResult.workspacePath !== undefined)
    successResult.workspacePath = branchResult.workspacePath;
  return successResult;
}

/**
 * Run a complete ephemeral experiment workflow.
 *
 * This helper specifically creates an ephemeral workspace, runs the experiment,
 * and returns the workspace path for the agent to work in.
 *
 * @param hypothesis - The hypothesis to test
 * @param targetRepoPath - Path to the target repository
 * @param options - Control plane options
 * @returns Workflow result with workspace path
 */
export async function runEphemeralExperiment(
  hypothesis: string,
  targetRepoPath: string,
  options: ControlPlaneOptions & { branchName?: string } = {}
): Promise<{
  sessionId?: string;
  workspacePath?: string;
  basePath?: string;
  success: boolean;
  error?: string;
}> {
  try {
    const workspaceRoot = options.workspaceRoot ?? '.aesop_workspaces';

    // Initialize ephemeral workspace
    const initResult = await initializeEphemeralWorkspace(
      { targetRepoPath, workspaceRoot },
      options
    );

    if (!initResult.success || !initResult.basePath) {
      return { success: false, error: initResult.error ?? 'Failed to initialize workspace' };
    }

    // Create hypothesis workspace
    const manager = getExperimentManager(options.cwd ?? process.cwd());
    await manager.initEphemeralWorkspace(targetRepoPath, workspaceRoot);

    const workspacePath = await manager.createHypothesisWorkspace(hypothesis, 'main', {
      branchName: options.branchName,
    });

    const result: { success: true; sessionId?: string; workspacePath: string; basePath: string } = {
      success: true,
      workspacePath,
      basePath: initResult.basePath,
    };
    if (initResult.sessionId !== undefined) {
      result.sessionId = initResult.sessionId;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export default startAesopDaemon;
