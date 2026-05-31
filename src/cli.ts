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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
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
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runExperiment, type RunExperimentResult } from './runExperiment.js';
import { LedgerManager, type LedgerEntry } from './ledger.js';
import { readTrace, summariseTrace, type TraceEvent, TRACE_ROOT } from './traceLogger.js';

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
  agent?: {
    model?: string;
  };
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
  .version(version)
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
  .addOption(new Option('--force', 'Force recreate the ephemeral workspace if it exists'))
  .action(
    async (
      hypothesis: string,
      options: {
        validateCmd?: string;
        metric?: string;
        maxIterations?: string;
        model?: string;
        force?: boolean;
      }
    ) => {
      const projectDir = process.cwd();
      const config = loadConfig(projectDir);

      // Support both flat config (model at root) and nested config (model under agent)
      const model =
        options.model ?? config.model ?? (config as { agent?: { model?: string } }).agent?.model;

      const validateCmd = options.validateCmd ?? config.validateCmd ?? DEFAULT_VALIDATE_CMD;
      const metric = options.metric ?? config.metric ?? DEFAULT_METRIC;
      const maxIterations =
        parseInt(options.maxIterations ?? '', 10) || config.maxIterations || DEFAULT_MAX_ITERATIONS;

      console.log('[Aesop] Running experiment...');
      console.log(`[Aesop] Hypothesis: "${hypothesis}"`);
      console.log(`[Aesop] Metric: ${metric}`);
      console.log(`[Aesop] Max iterations: ${maxIterations}`);
      console.log(`[Aesop] Validate command: ${validateCmd}`);
      console.log(`[Aesop] Model: ${model ?? 'default'}`);
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
          force: !!options.force,
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

// ============================================================================
// TRACE COMMAND GROUP
// ============================================================================

const trace = program.command('trace').description('Inspect experiment traces');

/**
 * Normalize a branch name for matching against directory names.
 * Directory names use `__` for `/` (since branch names with `/` get encoded).
 * This converts user input (with `/`) to directory format (with `__`).
 */
function toDirName(branchName: string): string {
  // Replace slashes with the encoding used by createExperimentTracer
  return branchName.replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-');
}

/**
 * Find a trace directory by branch name (supports prefix and suffix matching).
 *
 * Examples:
 *   - "hypothesis/test-lr" matches "hypothesis__test-lr" (exact, normalized)
 *   - "test-lr" matches "hypothesis__test-lr" (suffix after /)
 *   - "hypothesis" matches "hypothesis__test" (prefix with /)
 *   - "test" matches "test-branch" (direct prefix)
 */
function findTraceDir(projectDir: string, branchName: string): string | null {
  const traceRoot = resolve(projectDir, TRACE_ROOT);
  if (!existsSync(traceRoot)) return null;

  const dirs = readdirSync(traceRoot).filter((d) => statSync(join(traceRoot, d)).isDirectory());

  // Normalize user input to directory format (hypothesis/test -> hypothesis__test)
  const normalizedInput = toDirName(branchName);

  // Direct match first (normalized)
  if (dirs.includes(normalizedInput)) {
    return join(traceRoot, normalizedInput);
  }

  // Flexible matching: prefix, suffix, or contains (all on normalized names)
  const matches = dirs.filter((d) => {
    if (d === normalizedInput) return true;
    if (d.startsWith(normalizedInput + '/')) return true; // "hypothesis" matches "hypothesis/test"
    if (d.endsWith('/' + normalizedInput)) return true; // "test-lr" matches "hypothesis/test-lr"
    if (d.startsWith(normalizedInput)) return true; // "test" matches "test-branch"
    return false;
  });

  if (matches.length === 1 && matches[0]) {
    return join(traceRoot, matches[0]);
  }

  if (matches.length > 1) {
    console.error(`Ambiguous branch "${branchName}". Matches: ${matches.join(', ')}`);
    process.exit(1);
  }

  return null;
}

/**
 * Trace entry for `aesop trace list` output.
 */
interface TraceListEntry {
  branch: string;
  iterationCount: number;
  toolCallCount: number;
  finalMetric: string;
  hasFinalDiff: boolean;
}

/**
 * Format a metric value for display.
 */
function formatMetric(metrics: Record<string, number> | null): string {
  if (!metrics || Object.keys(metrics).length === 0) return '—';
  const first = Object.values(metrics)[0];
  return first?.toFixed(4) ?? '—';
}

/**
 * Pad a value to at least minWidth, useful for right-aligned numbers.
 */
function padRight(val: string, minWidth: number): string {
  return val.length >= minWidth ? val : val.padEnd(minWidth);
}

trace
  .command('list')
  .description('List all experiments with trace directories')
  .addOption(new Option('-p, --project-dir <path>', 'Project directory').default(process.cwd()))
  .action(async (options: { projectDir?: string }) => {
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const traceRoot = resolve(projectDir, TRACE_ROOT);

    if (!existsSync(traceRoot)) {
      console.log('No traces found. Run `aesop run "<hypothesis>"` first.');
      return;
    }

    const entries: TraceListEntry[] = [];

    for (const dir of readdirSync(traceRoot).filter((d) =>
      statSync(join(traceRoot, d)).isDirectory()
    )) {
      const traceFile = join(traceRoot, dir, 'trace.jsonl');
      if (!existsSync(traceFile)) continue;

      const events = readTrace(traceFile);
      const summary = summariseTrace(events);

      entries.push({
        branch: dir.replace(/__/g, '/'), // Restore slashes from __ encoding
        iterationCount: summary.iterationCount,
        toolCallCount: summary.toolCallCount,
        finalMetric: formatMetric(summary.finalMetrics),
        hasFinalDiff: existsSync(join(traceRoot, dir, 'final.diff')),
      });
    }

    if (entries.length === 0) {
      console.log('No traces found.');
      return;
    }

    // Determine column widths based on content
    const maxBranchLen = Math.max(...entries.map((e) => e.branch.length), 6); // min "Branch"
    const COL_BRANCH = maxBranchLen;
    const COL_ITER = 12;
    const COL_TOOLS = 12;
    const COL_METRIC = 10;
    const SEP = '  ';

    const header =
      'Branch'.padEnd(COL_BRANCH) +
      SEP +
      'Iterations'.padEnd(COL_ITER) +
      SEP +
      'Tool Calls'.padEnd(COL_TOOLS) +
      SEP +
      'Metric'.padEnd(COL_METRIC) +
      SEP +
      'Final Diff';
    console.log('');
    console.log(header);
    console.log('-'.repeat(header.length));

    for (const entry of entries) {
      const branch = entry.branch.padEnd(COL_BRANCH);
      const iterations = padRight(entry.iterationCount.toString(), COL_ITER);
      const toolCalls = padRight(entry.toolCallCount.toString(), COL_TOOLS);
      const metric = entry.finalMetric.padEnd(COL_METRIC);
      const hasDiff = entry.hasFinalDiff ? '✓' : '';
      console.log(`${branch}${SEP}${iterations}${SEP}${toolCalls}${SEP}${metric}${SEP}${hasDiff}`);
    }

    console.log('');
  });

/**
 * Pretty-print a trace event.
 */
function printEvent(event: TraceEvent, verbose: boolean): void {
  const ts = new Date(event.t).toISOString().replace('T', ' ').replace('Z', '');

  switch (event.kind) {
    case 'tool_call': {
      const input = JSON.stringify(event.input, null, 2);
      if (verbose) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`[${ts}] TOOL CALL: ${event.tool}`);
        console.log(input.slice(0, 500) + (input.length > 500 ? '\n...' : ''));
      } else {
        console.log(`[${ts}] ${event.tool}`);
      }
      break;
    }
    case 'tool_result': {
      if (verbose) {
        const output = event.truncated ? event.output + ' [TRUNCATED]' : event.output;
        console.log(
          `  → ${output.slice(0, 300).replace(/\n/g, '\n  ')}${output.length > 300 ? '\n  ...' : ''}`
        );
      }
      break;
    }
    case 'message': {
      if (verbose) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`[${ts}] ASSISTANT MESSAGE:`);
        console.log(event.text.slice(0, 800) + (event.text.length > 800 ? '\n...' : ''));
      }
      break;
    }
    case 'iteration': {
      const metrics = event.metrics ? JSON.stringify(event.metrics) : 'no metrics';
      console.log(`\n${'='.repeat(60)}`);
      console.log(`ITERATION ${event.n} — ${metrics}`);
      break;
    }
    case 'diff': {
      const label = event.iteration === 'final' ? 'FINAL' : `iter-${event.iteration}`;
      console.log(`  diff: ${label} (${event.linesAdded}+, ${event.linesRemoved}−)`);
      break;
    }
  }
}

trace
  .command('show <branch>')
  .description('Pretty-print the trace for a given experiment branch')
  .addOption(new Option('-v, --verbose', 'Show full tool inputs/outputs').default(false))
  .addOption(new Option('-p, --project-dir <path>', 'Project directory').default(process.cwd()))
  .action(async (branch: string, options: { verbose?: boolean; projectDir?: string }) => {
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const traceDir = findTraceDir(projectDir, branch);

    if (!traceDir) {
      console.error(`Trace not found for branch: ${branch}`);
      process.exit(1);
    }

    const traceFile = join(traceDir, 'trace.jsonl');
    const events = readTrace(traceFile);
    const summary = summariseTrace(events);

    // Print header
    const branchName = traceDir.split('/').pop()!.replace(/__/g, '/');
    console.log('');
    console.log(`Trace: ${branchName}`);
    console.log(`Iterations: ${summary.iterationCount}`);
    console.log(`Tool calls: ${summary.toolCallCount}`);
    console.log(`Tools used: ${summary.toolsUsed.join(', ')}`);
    if (summary.finalMetrics) {
      console.log(`Final metrics: ${JSON.stringify(summary.finalMetrics)}`);
    }

    // Group events by iteration and print
    const iterations: { n: number; events: TraceEvent[] }[] = [];
    let current: { n: number; events: TraceEvent[] } | null = null;

    for (const event of events) {
      if (event.kind === 'iteration') {
        if (current) iterations.push(current);
        current = { n: event.n, events: [] };
      }
      if (current) current.events.push(event);
    }
    if (current) iterations.push(current);

    console.log('\n' + '='.repeat(80));
    console.log('TRACE');
    console.log('='.repeat(80));

    for (const iter of iterations) {
      // Find iteration metrics
      const iterEvent = events.find(
        (e) => e.kind === 'iteration' && (e as { n: number }).n === iter.n
      ) as { n: number; metrics: Record<string, number> | null } | undefined;
      const metrics = iterEvent?.metrics
        ? Object.entries(iterEvent.metrics)
            .map(([k, v]) => `${k}=${v.toFixed(4)}`)
            .join(', ')
        : '';

      console.log(`\n${'█'.repeat(80)}`);
      console.log(`ITERATION ${iter.n}${metrics ? ` | ${metrics}` : ''}`);
      console.log('█'.repeat(80));

      for (const event of iter.events) {
        printEvent(event, options.verbose ?? false);
      }
    }

    // Check for diffs
    const diffsDir = traceDir;
    const diffFiles = readdirSync(diffsDir).filter((f) => f.endsWith('.diff'));
    if (diffFiles.length > 0) {
      console.log('\n' + '='.repeat(80));
      console.log('DIFF FILES');
      console.log('='.repeat(80));
      for (const df of diffFiles.sort()) {
        const stats = statSync(join(diffsDir, df));
        console.log(`  ${df} (${stats.size} bytes)`);
      }
    }
  });

trace
  .command('diff <branch>')
  .description(
    'Print the diff file for an experiment (use --iteration for specific iteration, or final by default)'
  )
  .addOption(new Option('-i, --iteration <n>', 'Specific iteration number (omit for final.diff)'))
  .addOption(new Option('-p, --project-dir <path>', 'Project directory').default(process.cwd()))
  .addOption(new Option('-r, --raw', 'Output raw diff without any formatting').default(false))
  .action(
    async (
      branch: string,
      options: {
        iteration?: string;
        projectDir?: string;
        raw?: boolean;
      }
    ) => {
      const projectDir = resolve(options.projectDir ?? process.cwd());
      const traceDir = findTraceDir(projectDir, branch);

      if (!traceDir) {
        console.error(`Trace not found for branch: ${branch}`);
        process.exit(1);
      }

      let diffFile: string;
      if (options.iteration) {
        diffFile = join(traceDir, `iter-${options.iteration}.diff`);
      } else {
        diffFile = join(traceDir, 'final.diff');
      }

      if (!existsSync(diffFile)) {
        console.error(`Diff file not found: ${diffFile}`);
        process.exit(1);
      }

      // Pipe-friendly: just cat the file to stdout
      const content = readFileSync(diffFile, 'utf-8');
      process.stdout.write(content);
    }
  );

program.parse();
