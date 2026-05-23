#!/usr/bin/env node

/**
 * Aesop CLI - Distributed ML Experiment Orchestration
 *
 * Embeds the Pi coding agent for natural language-driven experiment management.
 * Supports ephemeral workspaces for complete experiment isolation.
 */

import { Command, Option } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  InteractiveMode,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SettingsManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { ExperimentManager } from './experimentManager.js';
import { getActiveAdapter } from './discoveryEngine.js';
import {
  startAesopDaemon,
  runEphemeralExperiment,
  type ControlPlaneOptions,
} from './controlPlane.js';

/**
 * Get the default workspace root in the user's home directory.
 * This ensures ephemeral workspaces are decoupled from the local project directory.
 */
function getDefaultWorkspaceRoot(): string {
  return join(homedir(), '.aesop', 'workspaces');
}

const program = new Command();

/**
 * Applies global CLI options (model, thinking) to a SettingsManager.
 */
function applyGlobalSettings(settings: SettingsManager): void {
  const globalOpts = program.opts();
  if (globalOpts['model']) settings.setDefaultModel(globalOpts['model']);
  if (globalOpts['thinking']) settings.setDefaultThinkingLevel(globalOpts['thinking']);
}

/**
 * Creates a new in-memory SettingsManager configured with global CLI options.
 */
function getConfiguredSettings(): SettingsManager {
  const settings = SettingsManager.inMemory();
  applyGlobalSettings(settings);
  return settings;
}

program
  .name('aesop')
  .description('Distributed ML experiment orchestration CLI powered by Pi')
  .version('0.2.0')
  .addOption(new Option('-m, --model <model>', 'Model to use (e.g., anthropic/claude-opus-4-5)'))
  .addOption(
    new Option('-t, --thinking <level>', 'Thinking level').choices([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  );

// Global auth state
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

/**
 * Initialize authentication and model registry.
 */
function initAuth(): void {
  authStorage = AuthStorage.create();
  modelRegistry = ModelRegistry.create(authStorage);
}

/**
 * Interactive mode - full TUI with embedded agent
 */
program
  .command('interactive')
  .description('Start interactive mode with embedded agent')
  .action(async () => {
    initAuth();

    const cwd = process.cwd();
    const sessionManager = SessionManager.create(cwd);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: sessionCwd,
      sessionManager: sm,
    }) => {
      const services = await createAgentSessionServices({ cwd: sessionCwd });
      applyGlobalSettings(services.settingsManager);

      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: sm,
          sessionStartEvent: { type: 'session_start', reason: 'startup' },
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });

    const mode = new InteractiveMode(runtime, {
      migratedProviders: [],
      modelFallbackMessage: '',
      initialMessage: 'Welcome to Aesop! How can I help you run your ML experiments?',
      initialImages: [],
      initialMessages: [],
    });

    await mode.run();
  });

/**
 * Start the Aesop daemon with an objective (ephemeral workspace mode)
 */
program
  .command('start')
  .description('Start the Aesop daemon with ephemeral workspace isolation')
  .requiredOption('-o, --objective <text>', 'The experiment objective to pursue')
  .requiredOption('-r, --target-repo <path>', 'Path to the target repository to sandbox')
  .addOption(
    new Option('-w, --workspace-root <path>', 'Root directory for workspaces').default(
      getDefaultWorkspaceRoot()
    )
  )
  .addOption(
    new Option('-c, --validate-cmd <command>', 'Validation command to run').default(
      './aesop_validate.sh'
    )
  )
  .action(
    async (options: {
      objective: string;
      targetRepo: string;
      workspaceRoot: string;
      validateCmd: string;
    }) => {
      initAuth();

      const controlPlaneOptions: ControlPlaneOptions = {
        targetRepoPath: options.targetRepo,
        workspaceRoot: options.workspaceRoot,
        useEphemeralWorkspaces: true,
        sessionManager: SessionManager.create(process.cwd()),
        authStorage,
        modelRegistry,
        settingsManager: getConfiguredSettings(),
        validateCmd: options.validateCmd,
      };

      console.log('[CLI] Starting Aesop with ephemeral workspace isolation');
      console.log(`[CLI] Target repo: ${options.targetRepo}`);
      console.log(`[CLI] Workspace root: ${options.workspaceRoot}`);
      console.log('');

      const { session, stop } = await startAesopDaemon(options.objective, controlPlaneOptions);

      // Keep the session alive and log events
      session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
        if (event.type === 'tool_execution_start') {
          console.log(`\n[Tool] ${event.toolName}`);
        }
      });

      // Handle cleanup on exit
      process.on('SIGINT', () => {
        console.log('\n[CLI] Shutting down...');
        stop();
        process.exit(0);
      });
    }
  );

/**
 * Run an experiment from a natural language prompt
 */
program
  .command('run <prompt>')
  .description('Execute an experiment from a natural language prompt')
  .addOption(new Option('-b, --branch <name>', 'Branch name for the experiment'))
  .addOption(
    new Option('-t, --target-repo <path>', 'Path to target repository (for ephemeral mode)')
  )
  .addOption(
    new Option('-w, --workspace-root <path>', 'Root directory for workspaces').default(
      getDefaultWorkspaceRoot()
    )
  )
  .addOption(new Option('-e, --ephemeral', 'Use ephemeral workspace isolation').default(false))
  .action(
    async (
      prompt: string,
      options: {
        branch?: string;
        targetRepo?: string;
        workspaceRoot?: string;
        ephemeral?: boolean;
      }
    ) => {
      initAuth();

      if (options.ephemeral) {
        const target = options.targetRepo ?? process.cwd();
        // Run in ephemeral mode
        console.log('[CLI] Running in ephemeral workspace mode');

        const runOptions: ControlPlaneOptions & { branchName?: string } = {};
        if (options.workspaceRoot) runOptions.workspaceRoot = options.workspaceRoot;
        if (options.branch) runOptions.branchName = options.branch;

        const result = await runEphemeralExperiment(prompt, target, runOptions);

        if (!result.success) {
          console.error(`[CLI] Error: ${result.error}`);
          process.exit(1);
        }

        console.log(`[CLI] Session ID: ${result.sessionId}`);
        console.log(`[CLI] Workspace path: ${result.workspacePath}`);
        console.log(`[CLI] Base path: ${result.basePath}`);
        console.log('[CLI] Use the workspace path above to edit files');
      } else if (options.targetRepo) {
        console.error('[CLI] Error: --target-repo can only be used with --ephemeral');
        process.exit(1);
      } else {
        // Run in normal mode
        const manager = new ExperimentManager(process.cwd());
        await manager.createBranch('main', prompt, { literalName: options.branch });

        const settingsManager = getConfiguredSettings();

        const { session } = await createAgentSession({
          sessionManager: SessionManager.inMemory(),
          authStorage,
          modelRegistry,
          settingsManager,
        });

        console.log(`[Aesop] Running experiment: "${prompt}"`);

        session.subscribe((event: AgentSessionEvent) => {
          if (
            event.type === 'message_update' &&
            event.assistantMessageEvent.type === 'text_delta'
          ) {
            process.stdout.write(event.assistantMessageEvent.delta);
          }
          if (event.type === 'tool_execution_start') {
            console.log(`\n[Tool] ${event.toolName}`);
          }
        });

        await session.prompt(prompt);
        console.log('\n[Aesop] Experiment completed.');
      }
    }
  );

/**
 * Create an experiment branch
 */
program
  .command('branch <hypothesis>')
  .description('Create an experiment branch from a hypothesis')
  .addOption(new Option('-f, --from <branch>', 'Base branch (default: main)').default('main'))
  .addOption(
    new Option('-t, --target-repo <path>', 'Path to target repository (for ephemeral mode)')
  )
  .addOption(
    new Option('-w, --workspace-root <path>', 'Root directory for workspaces').default(
      getDefaultWorkspaceRoot()
    )
  )
  .addOption(new Option('-e, --ephemeral', 'Use ephemeral workspace isolation').default(false))
  .action(
    async (
      hypothesis: string,
      options: {
        from?: string;
        targetRepo?: string;
        workspaceRoot?: string;
        ephemeral?: boolean;
      }
    ) => {
      if (options.ephemeral) {
        const target = options.targetRepo ?? process.cwd();
        // Create ephemeral workspace
        console.log('[CLI] Creating ephemeral workspace for hypothesis');

        const manager = new ExperimentManager(target, {
          ephemeral: true,
          workspaceRoot: options.workspaceRoot,
        });
        await manager.initEphemeralWorkspace(
          target,
          options.workspaceRoot ?? getDefaultWorkspaceRoot()
        );
        const workspacePath = await manager.createBranch(options.from ?? 'main', hypothesis);

        console.log(`[Aesop] Created ephemeral workspace: ${workspacePath}`);
      } else if (options.targetRepo) {
        console.error('[CLI] Error: --target-repo can only be used with --ephemeral');
        process.exit(1);
      } else {
        // Create local branch
        const manager = new ExperimentManager(process.cwd());
        const branch = await manager.createBranch(options.from ?? 'main', hypothesis);
        console.log(`[Aesop] Created experiment branch: ${branch}`);
      }
    }
  );

/**
 * Dispatch an experiment to the available compute backend
 */
program
  .command('dispatch [branch]')
  .description('Dispatch experiment to available compute backend')
  .addOption(
    new Option('-c, --cwd <path>', 'Working directory for the experiment').default(process.cwd())
  )
  .addOption(new Option('-r, --run-cmd <command>', 'Command to run on the compute backend'))
  .addOption(
    new Option('--validate-cmd <command>', 'Validation command').default('./aesop_validate.sh')
  )
  .action(
    async (
      branch: string | undefined,
      options: { cwd?: string; runCmd?: string; validateCmd?: string }
    ) => {
      const currentBranch =
        branch ??
        (await new ExperimentManager(options.cwd ?? process.cwd()).getCurrentBranch()) ??
        'main';

      // Run local validation if requested
      if (options.validateCmd) {
        console.log(`[CLI] Validating branch ${currentBranch} locally...`);
        const { runStaticChecks } = await import('./backpressureGates.js');
        const checkResult = await runStaticChecks(
          options.cwd ?? process.cwd(),
          options.validateCmd
        );
        if (!checkResult.success) {
          console.error(`[CLI] Local validation failed:\n${checkResult.errorOutput}`);
          process.exit(1);
        }
        console.log(`[CLI] Local validation passed.`);
      }

      const adapter = await getActiveAdapter();
      const runCmd = options.runCmd ?? `python train.py --branch ${currentBranch}`;

      console.log(`[Aesop] Dispatching ${currentBranch} with command: "${runCmd}"...`);
      const jobId = await adapter.submitJob(currentBranch, runCmd, options.cwd);

      console.log(`[Aesop] Job submitted: ${jobId}`);
      const status = await adapter.checkStatus(jobId);
      console.log(`[Aesop] Status: ${status.status}`);
    }
  );

/**
 * Check experiment status
 */
program
  .command('status [branch]')
  .description('Show experiment status')
  .addOption(
    new Option('-w, --workspace-root <path>', 'Root directory for workspaces').default(
      getDefaultWorkspaceRoot()
    )
  )
  .addOption(new Option('-e, --ephemeral', 'Check ephemeral workspace status').default(false))
  .action(
    async (
      branch: string | undefined,
      options: { workspaceRoot?: string; ephemeral?: boolean }
    ) => {
      if (options.ephemeral) {
        // List ephemeral workspaces
        const { existsSync, readdirSync } = await import('node:fs');
        const { join } = await import('node:path');

        const workspaceRoot = options.workspaceRoot ?? getDefaultWorkspaceRoot();

        if (!existsSync(workspaceRoot)) {
          console.log(`[Aesop] No workspaces found at ${workspaceRoot}`);
          return;
        }

        const sessions = readdirSync(workspaceRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('session_'))
          .map((entry) => entry.name);

        if (sessions.length === 0) {
          console.log(`[Aesop] No active workspaces found`);
          return;
        }

        console.log(`[Aesop] Active workspaces:`);
        for (const session of sessions) {
          const sessionPath = join(workspaceRoot, session);
          const workspaces = readdirSync(sessionPath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('hyp_'))
            .map((entry) => entry.name);

          console.log(`  ${session}:`);
          for (const ws of workspaces) {
            console.log(`    - ${ws}`);
          }
        }
      } else {
        const manager = new ExperimentManager(process.cwd());
        const currentBranch = branch ?? (await manager.getCurrentBranch()) ?? 'main';
        const records = manager.getExperimentLog();

        const branchRecords = records.filter((r) => r.branch === currentBranch);

        if (branchRecords.length === 0) {
          console.log(`[Aesop] No experiments found for branch: ${currentBranch}`);
          return;
        }

        console.log(`[Aesop] Experiments for branch "${currentBranch}":`);
        for (const record of branchRecords) {
          console.log(
            `  ${record.timestamp} - ${record.status} - ${record.commitHash.slice(0, 7)}`
          );
        }
      }
    }
  );

/**
 * Merge experiment branch
 */
program
  .command('merge <source> <target>')
  .description('Merge experiment branch to target')
  .addOption(
    new Option('-w, --workspace-root <path>', 'Root directory for workspaces').default(
      getDefaultWorkspaceRoot()
    )
  )
  .addOption(new Option('-e, --ephemeral', 'Merge from ephemeral workspace to base').default(false))
  .addOption(new Option('-p, --push', 'Push merged changes to original repository').default(false))
  .action(
    async (
      source: string,
      target: string,
      options: {
        workspaceRoot?: string;
        ephemeral?: boolean;
        push?: boolean;
      }
    ) => {
      const manager = new ExperimentManager(process.cwd());

      if (options.ephemeral) {
        // Get workspace manager and merge into base
        const wm = manager.getWorkspaceManager();
        if (!wm) {
          console.error('[Aesop] Ephemeral workspace not initialized');
          process.exit(1);
        }

        console.log(`[Aesop] Merging ${source} into base workspace...`);
        const success = await wm.mergeIntoBase(source, target);

        if (success) {
          console.log(`[Aesop] Successfully merged ${source} into base`);
          if (options.push) {
            console.log('[Aesop] Note: Set up git remote in base to push changes');
          }
        } else {
          console.error('[Aesop] Merge failed - conflicts detected');
          process.exit(1);
        }
      } else {
        const success = await manager.mergeBranch(source, target);

        if (success) {
          console.log(`[Aesop] Successfully merged ${source} into ${target}`);
        } else {
          console.error('[Aesop] Merge failed - conflicts detected');
          process.exit(1);
        }
      }
    }
  );

/**
 * Clean up ephemeral workspaces
 */
program
  .command('cleanup')
  .description('Clean up ephemeral workspaces')
  .addOption(
    new Option('-w, --workspace-root <path>', 'Root directory for workspaces').default(
      getDefaultWorkspaceRoot()
    )
  )
  .addOption(new Option('--dry-run', 'Show what would be deleted without deleting').default(false))
  .action(async (options: { workspaceRoot?: string; dryRun?: boolean }) => {
    const { existsSync, readdirSync, rmSync } = await import('node:fs');

    const workspaceRoot = options.workspaceRoot ?? getDefaultWorkspaceRoot();

    if (!existsSync(workspaceRoot)) {
      console.log(`[Aesop] No workspaces found at ${workspaceRoot}`);
      return;
    }

    const sessions = readdirSync(workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('session_'))
      .map((entry) => entry.name);

    if (sessions.length === 0) {
      console.log(`[Aesop] No workspaces to clean up`);
      return;
    }

    console.log(`[Aesop] Found ${sessions.length} workspace(s) to clean up:`);
    for (const session of sessions) {
      console.log(`  - ${session}`);
    }

    if (options.dryRun) {
      console.log('\n[CLI] Dry run - no changes made');
      return;
    }

    console.log('\n[CLI] Cleaning up workspaces...');
    rmSync(workspaceRoot, { recursive: true, force: true });
    console.log('[Aesop] All workspaces cleaned up');
  });

program.parse();
