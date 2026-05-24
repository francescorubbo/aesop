#!/usr/bin/env node

/**
 * Aesop CLI - ML Experiment Orchestration
 *
 * Simplified CLI with three commands:
 * - run: Execute an experiment from a natural language prompt
 * - interactive: Open an agent session for exploration
 * - status: Show experiment history from the ledger
 */

import { Command, Option } from 'commander';
import {
  SessionManager,
  InteractiveMode,
  getAgentDir,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createAgentSessionRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runExperiment, type RunExperimentResult } from './runExperiment.js';
import { LedgerManager, type LedgerEntry } from './ledger.js';

/**
 * Default configuration values, optionally overridden by .aesop.json.
 */
const DEFAULT_VALIDATE_CMD = './aesop_validate.sh';
const DEFAULT_METRIC = 'accuracy';
const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Schema for .aesop.json configuration.
 */
interface AesopConfig {
  validateCmd?: string;
  metric?: string;
  maxIterations?: number;
  model?: string;
}

/**
 * Load configuration from .aesop.json if it exists.
 */
function loadConfig(projectDir: string): AesopConfig {
  const configPath = join(projectDir, '.aesop.json');
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Invalid JSON, ignore and use defaults
    }
  }
  return {};
}

/**
 * Format duration in milliseconds to human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Print experiment status table to console.
 */
function printStatusTable(entries: LedgerEntry[]): void {
  if (entries.length === 0) {
    console.log('No experiments found. Run `aesop run "<hypothesis>"` to start.');
    return;
  }

  // Group by branch, keeping only the latest entry for each
  const latestByBranch = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    const existing = latestByBranch.get(entry.branch);
    if (!existing || entry.timestamp > existing.timestamp) {
      latestByBranch.set(entry.branch, entry);
    }
  }

  // Sort by timestamp, newest first
  const sorted = Array.from(latestByBranch.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  console.log('');
  console.log('Branch'.padEnd(35) + 'Status'.padEnd(16) + 'Metric'.padEnd(12) + 'Time');
  console.log('-'.repeat(75));

  for (const entry of sorted) {
    const branch = entry.branch.padEnd(35);
    const status = entry.status.padEnd(16);
    const metricValue =
      entry.metrics && Object.keys(entry.metrics).length > 0
        ? (Object.values(entry.metrics)[0]?.toFixed(4) ?? '—')
        : '—';
    const duration = formatDuration(entry.durationMs);

    console.log(`${branch}${status}${metricValue.padEnd(12)}${duration}`);
  }

  console.log('');
}

/**
 * Print status as JSON for machine-readable output.
 */
function printStatusJson(entries: LedgerEntry[]): void {
  // Group by branch, keeping only the latest entry for each
  const latestByBranch = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    const existing = latestByBranch.get(entry.branch);
    if (!existing || entry.timestamp > existing.timestamp) {
      latestByBranch.set(entry.branch, entry);
    }
  }

  const output = Array.from(latestByBranch.values()).map((entry) => ({
    branch: entry.branch,
    status: entry.status,
    metrics: entry.metrics,
    durationMs: entry.durationMs,
    timestamp: entry.timestamp,
  }));

  console.log(JSON.stringify(output, null, 2));
}

const program = new Command();

program
  .name('aesop')
  .description('ML experiment orchestration CLI powered by Pi')
  .version('0.3.0')
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

/**
 * Apply global settings to a SettingsManager.
 */
function applyGlobalSettings(settings: SettingsManager): void {
  const globalOpts = program.opts();
  if (globalOpts['model']) settings.setDefaultModel(globalOpts['model']);
  if (globalOpts['thinking']) settings.setDefaultThinkingLevel(globalOpts['thinking']);
}

/**
 * Get configured SettingsManager from global options.
 */
function getConfiguredSettings(): SettingsManager {
  const settings = SettingsManager.inMemory();
  applyGlobalSettings(settings);
  return settings;
}

// ============================================================================
// RUN COMMAND
// ============================================================================

program
  .command('run <hypothesis>')
  .description('Run a single experiment end-to-end')
  .addOption(
    new Option('-c, --validate-cmd <command>', 'Validation command to run').default(
      DEFAULT_VALIDATE_CMD
    )
  )
  .addOption(new Option('-m, --metric <key>', 'Primary metric to optimize').default(DEFAULT_METRIC))
  .addOption(
    new Option('-i, --max-iterations <n>', 'Maximum agent iterations').default(
      DEFAULT_MAX_ITERATIONS.toString()
    )
  )
  .addOption(new Option('--model <model>', 'Model override for the agent'))
  .action(
    async (
      hypothesis: string,
      options: {
        validateCmd?: string;
        metric?: string;
        maxIterations?: string;
        model?: string;
      }
    ) => {
      const projectDir = process.cwd();
      const config = loadConfig(projectDir);

      const validateCmd = options.validateCmd ?? config.validateCmd ?? DEFAULT_VALIDATE_CMD;
      const metric = options.metric ?? config.metric ?? DEFAULT_METRIC;
      const maxIterations =
        parseInt(options.maxIterations ?? '', 10) || config.maxIterations || DEFAULT_MAX_ITERATIONS;
      const model = options.model ?? config.model;

      console.log('[Aesop] Running experiment...');
      console.log(`[Aesop] Hypothesis: "${hypothesis}"`);
      console.log(`[Aesop] Metric: ${metric}`);
      console.log(`[Aesop] Max iterations: ${maxIterations}`);
      console.log(`[Aesop] Validate command: ${validateCmd}`);
      console.log('');

      // Set up settings
      const settingsManager = getConfiguredSettings();
      if (model) {
        settingsManager.setDefaultModel(model);
      }

      let result: RunExperimentResult | null = null;

      try {
        result = await runExperiment({
          projectDir,
          hypothesis,
          validateCmd,
          metricKey: metric,
          maxIterations,
          ...(model ? { model } : {}),
          onLog: (msg) => {
            console.log(msg);
          },
        });

        console.log('');
        console.log(`[Aesop] Experiment completed: ${result.status}`);

        if (result.status === 'success') {
          console.log('[Aesop] New best result achieved!');
          if (result.metrics) {
            console.log(`[Aesop] Metrics: ${JSON.stringify(result.metrics)}`);
          }
          process.exit(0);
        } else if (result.status === 'no_improvement') {
          console.log('[Aesop] No improvement over previous best.');
          process.exit(0);
        } else {
          console.log('[Aesop] Experiment failed.');
          process.exit(1);
        }
      } catch (error) {
        console.error('[Aesop] Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    }
  );

// ============================================================================
// INTERACTIVE COMMAND
// ============================================================================

program
  .command('interactive')
  .description('Open an agent session for exploration and debugging')
  .action(async () => {
    const cwd = process.cwd();

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

    const sessionManager = SessionManager.inMemory(cwd);

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });

    const mode = new InteractiveMode(runtime, {
      migratedProviders: [],
      modelFallbackMessage: '',
      initialMessage: 'Welcome to Aesop! This is an interactive session in your current directory.',
      initialImages: [],
      initialMessages: [],
    });

    await mode.run();
  });

// ============================================================================
// STATUS COMMAND
// ============================================================================

program
  .command('status')
  .description('Show experiment history from the ledger')
  .addOption(
    new Option('-l, --ledger-path <path>', 'Path to experiments.jsonl').default('experiments.jsonl')
  )
  .addOption(new Option('--json', 'Output as JSON').default(false))
  .action(async (options: { ledgerPath?: string; json?: boolean }) => {
    const projectDir = process.cwd();
    const ledgerPath = options.ledgerPath
      ? resolve(projectDir, options.ledgerPath)
      : join(projectDir, 'experiments.jsonl');

    if (!existsSync(ledgerPath)) {
      console.log('No experiments found. Run `aesop run "<hypothesis>"` to start.');
      return;
    }

    const ledger = new LedgerManager({ ledgerPath });
    const entries = ledger.readAll();

    if (options.json) {
      printStatusJson(entries);
    } else {
      printStatusTable(entries);
    }
  });

program.parse();
