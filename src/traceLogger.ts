/**
 * Trace Logger
 *
 * Pi SDK extension that captures a structured trace of every agent action
 * during an experiment run: tool calls, tool results, and agent messages.
 *
 * Each experiment gets its own trace directory under `.aesop/traces/<branch>/`:
 *
 *   .aesop/traces/<branch>/
 *   ├── trace.jsonl          # Newline-delimited JSON event stream
 *   ├── iter-1.diff          # Git diff produced after iteration 1
 *   ├── iter-2.diff          # Git diff produced after iteration 2
 *   └── final.diff           # Cumulative diff from base commit to experiment end
 *
 * trace.jsonl events:
 *   { "t": <iso>, "kind": "tool_call",   "tool": "bash", "input": {...} }
 *   { "t": <iso>, "kind": "tool_result", "tool": "bash", "output": "...", "truncated": false }
 *   { "t": <iso>, "kind": "message",     "role": "assistant", "text": "..." }
 *   { "t": <iso>, "kind": "iteration",   "n": 1, "metrics": {...} | null }
 *   { "t": <iso>, "kind": "diff",        "iteration": 1, "file": "iter-1.diff", "linesAdded": 4, "linesRemoved": 2 }
 *
 * Usage:
 * ```ts
 * const tracer = createExperimentTracer({ branch, projectDir });
 * // Pass tracer.extension to DefaultResourceLoader's extensionFactories.
 * // Call tracer.recordIteration / tracer.recordDiff / tracer.close
 * // at the right points in runExperiment.
 * ```
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Root directory for all trace output, relative to projectDir. */
export const TRACE_ROOT = '.aesop/traces';

/** Maximum bytes of tool output to capture before truncating. */
const MAX_OUTPUT_BYTES = 8_192;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated union of events written to trace.jsonl. */
export type TraceEvent =
  | { t: string; kind: 'tool_call';   tool: string; input: unknown }
  | { t: string; kind: 'tool_result'; tool: string; output: string; truncated: boolean }
  | { t: string; kind: 'message';     role: 'assistant'; text: string }
  | { t: string; kind: 'iteration';   n: number; metrics: Record<string, number> | null }
  | { t: string; kind: 'diff';        iteration: number | 'final'; file: string; linesAdded: number; linesRemoved: number };

/** Returned by {@link createExperimentTracer}. */
export interface ExperimentTracer {
  /**
   * Pi SDK extension factory — pass this to `DefaultResourceLoader`'s
   * `extensionFactories` array so tool calls/results are automatically captured.
   */
  extension: (_pi: ExtensionAPI) => void;

  /**
   * Record that an iteration completed with the given validation metrics
   * (or null if validation did not produce a metric value).
   */
  recordIteration(n: number, metrics: Record<string, number> | null): void;

  /**
   * Capture a git diff from the workspace and write it to a `.diff` file.
   *
   * @param workspacePath - Absolute path to the git worktree
   * @param label         - `1`, `2`, …, or `'final'`
   * @param baseRef       - Git ref to diff against (defaults to `HEAD~1`; for
   *                        the final diff pass the base commit hash so the
   *                        whole experiment delta is shown)
   */
  captureDiff(workspacePath: string, label: number | 'final', baseRef?: string): void;

  /**
   * Absolute path to this experiment's trace directory.
   * Useful for surfacing in logs / the CLI.
   */
  traceDir: string;

  /**
   * Absolute path to the trace.jsonl file.
   */
  traceFile: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a tracer bound to a single experiment run.
 *
 * @param opts.branch     - Branch name (used to derive the trace sub-directory)
 * @param opts.projectDir - Absolute path to the user's project directory
 */
export function createExperimentTracer(opts: {
  branch: string;
  projectDir: string;
}): ExperimentTracer {
  const { branch, projectDir } = opts;

  // Sanitise branch name for use as a directory component.
  const safeBranch = branch.replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-');
  const traceDir = resolve(join(projectDir, TRACE_ROOT, safeBranch));
  const traceFile = join(traceDir, 'trace.jsonl');

  mkdirSync(traceDir, { recursive: true });

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  function now(): string {
    return new Date().toISOString();
  }

  function writeEvent(event: TraceEvent): void {
    try {
      appendFileSync(traceFile, JSON.stringify(event) + '\n');
    } catch {
      // Swallow write errors — tracing must never crash the experiment.
    }
  }

  function truncate(text: string): { output: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf-8') <= MAX_OUTPUT_BYTES) {
      return { output: text, truncated: false };
    }
    const truncated = Buffer.from(text, 'utf-8')
      .slice(0, MAX_OUTPUT_BYTES)
      .toString('utf-8');
    return { output: truncated + '\n…[truncated]', truncated: true };
  }

  // ------------------------------------------------------------------
  // Pi SDK extension
  // ------------------------------------------------------------------

  /**
   * The extension hooks into two events:
   *
   * - `tool_call`   — fired before the tool executes; logs name + input.
   * - `tool_result` — fired after the tool executes; logs output (truncated).
   *
   * If the SDK later exposes a `message` event we can add it here without
   * changing any callers.
   */
  function extension(_pi: ExtensionAPI): void {
    // Track the most-recently-seen tool name so tool_result can reference it.
    let lastToolName = 'unknown';

    _pi.on('tool_call', async (event, _ctx) => {
      lastToolName = event.toolName;
      writeEvent({
        t: now(),
        kind: 'tool_call',
        tool: event.toolName,
        input: event.input,
      });
      // Never block — this extension only observes.
      return undefined;
    });

    // `tool_result` may not exist in older SDK versions; guard defensively.
    if (typeof (_pi as unknown as Record<string, unknown>)['on'] === 'function') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (_pi as any).on('tool_result', async (event: { output?: unknown }) => {
          const rawOutput = typeof event.output === 'string'
            ? event.output
            : JSON.stringify(event.output ?? '');
          const { output, truncated } = truncate(rawOutput);
          writeEvent({
            t: now(),
            kind: 'tool_result',
            tool: lastToolName,
            output,
            truncated,
          });
          return undefined;
        });
      } catch {
        // SDK version doesn't support tool_result — skip silently.
      }
    }
  }

  // ------------------------------------------------------------------
  // recordIteration
  // ------------------------------------------------------------------

  function recordIteration(n: number, metrics: Record<string, number> | null): void {
    writeEvent({ t: now(), kind: 'iteration', n, metrics });
  }

  // ------------------------------------------------------------------
  // captureDiff
  // ------------------------------------------------------------------

  function captureDiff(
    workspacePath: string,
    label: number | 'final',
    baseRef = 'HEAD~1',
  ): void {
    const filename = label === 'final' ? 'final.diff' : `iter-${label}.diff`;
    const diffPath = join(traceDir, filename);

    let diffContent = '';
    try {
      // `git diff <baseRef>` shows the working-tree delta from that ref.
      // If HEAD~1 doesn't exist (first commit) fall back to the empty-tree hash.
      const ref =
        baseRef === 'HEAD~1'
          ? safeHeadParent(workspacePath) ?? EMPTY_TREE_HASH
          : baseRef;

      diffContent = execSync(`git diff ${ref}`, {
        cwd: workspacePath,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        encoding: 'utf-8',
      });
    } catch (err) {
      diffContent = `# diff unavailable: ${String(err)}\n`;
    }

    try {
      writeFileSync(diffPath, diffContent, 'utf-8');
    } catch {
      // Swallow — tracing must never crash the experiment.
    }

    const { linesAdded, linesRemoved } = parseDiffStats(diffContent);
    writeEvent({
      t: now(),
      kind: 'diff',
      iteration: label,
      file: filename,
      linesAdded,
      linesRemoved,
    });
  }

  return { extension, recordIteration, captureDiff, traceDir, traceFile };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-1 of git's empty tree — safe base for first-commit diffs. */
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Return the hash of HEAD's parent, or null if HEAD has no parent
 * (i.e., this is the initial commit in the worktree).
 */
function safeHeadParent(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD~1', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Count `+` and `-` lines in a unified diff string.
 * Skips the `+++`/`---` file headers.
 */
function parseDiffStats(diff: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}

/**
 * Read all trace events from a trace.jsonl file.
 * Invalid lines are skipped silently.
 *
 * Useful for the CLI's `aesop trace show <experiment>` command.
 */
export function readTrace(traceFile: string): TraceEvent[] {
  if (!existsSync(traceFile)) return [];
  const lines = readFileSync(traceFile, 'utf-8').split('\n').filter(Boolean);
  const events: TraceEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Skip malformed lines.
    }
  }
  return events;
}

/**
 * Summarise a trace: total tool calls, unique tools used, iterations.
 */
export function summariseTrace(events: TraceEvent[]): {
  toolCallCount: number;
  toolsUsed: string[];
  iterationCount: number;
  finalMetrics: Record<string, number> | null;
} {
  const toolCalls = events.filter((e) => e.kind === 'tool_call');
  const toolsUsed = [...new Set(toolCalls.map((e) => (e as { tool: string }).tool))];
  const iterations = events.filter((e) => e.kind === 'iteration');
  const lastIteration = iterations[iterations.length - 1] as
    | { metrics: Record<string, number> | null }
    | undefined;

  return {
    toolCallCount: toolCalls.length,
    toolsUsed,
    iterationCount: iterations.length,
    finalMetrics: lastIteration?.metrics ?? null,
  };
}
