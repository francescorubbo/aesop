#!/usr/bin/env node

/**
 * Aesop CLI - Distributed ML Experiment Orchestration
 *
 * Embeds the Pi coding agent for natural language-driven experiment management.
 */

import { Command, Option } from 'commander';
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

const program = new Command();

program
  .name('aesop')
  .description('Distributed ML experiment orchestration CLI powered by Pi')
  .version('0.2.0');

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
  )
  .action(async (_options: { model?: string; thinking?: string }) => {
    initAuth();

    const cwd = process.cwd();
    const sessionManager = SessionManager.create(cwd);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: sessionCwd,
      sessionManager: sm,
    }) => {
      const services = await createAgentSessionServices({ cwd: sessionCwd });
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
 * Run an experiment from a natural language prompt
 */
program
  .command('run <prompt>')
  .description('Execute an experiment from a natural language prompt')
  .addOption(new Option('-b, --branch <name>', 'Branch name for the experiment'))
  .action(async (prompt: string, _options: { branch?: string }) => {
    initAuth();

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      // Built-in tools (read, bash, edit, write) are enabled by default
      settingsManager: SettingsManager.inMemory(),
    });

    console.log(`[Aesop] Running experiment: "${prompt}"`);

    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.type === 'tool_execution_start') {
        console.log(`\n[Tool] ${event.toolName}`);
      }
    });

    await session.prompt(prompt);
    console.log('\n[Aesop] Experiment completed.');
  });

/**
 * Create an experiment branch
 */
program
  .command('branch <hypothesis>')
  .description('Create an experiment branch from a hypothesis')
  .addOption(new Option('-f, --from <branch>', 'Base branch (default: main)').default('main'))
  .action(async (hypothesis: string, options: { from?: string }) => {
    const manager = new ExperimentManager(process.cwd());
    const branch = await manager.createBranch(options.from ?? 'main', hypothesis);
    console.log(`[Aesop] Created experiment branch: ${branch}`);
  });

/**
 * Dispatch an experiment to the available compute backend
 */
program
  .command('dispatch [branch]')
  .description('Dispatch experiment to available compute backend')
  .action(async (branch?: string) => {
    const currentBranch =
      branch ?? (await new ExperimentManager(process.cwd()).getCurrentBranch()) ?? 'main';
    const adapter = await getActiveAdapter();

    console.log(`[Aesop] Dispatching ${currentBranch}...`);
    const jobId = await adapter.submitJob(
      currentBranch,
      `python train.py --branch ${currentBranch}`
    );

    console.log(`[Aesop] Job submitted: ${jobId}`);
    const status = await adapter.checkStatus(jobId);
    console.log(`[Aesop] Status: ${status.status}`);
  });

/**
 * Check experiment status
 */
program
  .command('status [branch]')
  .description('Show experiment status')
  .action(async (branch?: string) => {
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
      console.log(`  ${record.timestamp} - ${record.status} - ${record.commitHash.slice(0, 7)}`);
    }
  });

/**
 * Merge experiment branch
 */
program
  .command('merge <source> <target>')
  .description('Merge experiment branch to target')
  .action(async (source: string, target: string) => {
    const manager = new ExperimentManager(process.cwd());
    const success = await manager.mergeBranch(source, target);

    if (success) {
      console.log(`[Aesop] Successfully merged ${source} into ${target}`);
    } else {
      console.error(`[Aesop] Merge failed - conflicts detected`);
      process.exit(1);
    }
  });

program.parse();
