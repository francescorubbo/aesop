/**
 * Tests for aesop trace CLI subcommands
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Simulates the findTraceDir matching logic for testing.
 */
function simulateFindTraceDir(dirs: string[], branchName: string): string[] {
  const matches = dirs.filter((d) => {
    if (d === branchName) return true;
    if (d.startsWith(branchName + '/')) return true; // "hypothesis" matches "hypothesis/test"
    if (d.endsWith('/' + branchName)) return true; // "test-lr" matches "hypothesis/test-lr"
    if (d.startsWith(branchName)) return true; // "test" matches "test-branch"
    return false;
  });
  return matches;
}

describe('findTraceDir matching logic', () => {
  const dirs = ['hypothesis/test-branch', 'hypothesis/other', 'main', 'test-lr-experiment'];

  it('should find exact match', () => {
    const matches = simulateFindTraceDir(dirs, 'hypothesis/test-branch');
    expect(matches).toEqual(['hypothesis/test-branch']);
  });

  it('should find suffix match (test-lr matches hypothesis/test-lr)', () => {
    const localDirs = ['hypothesis/test-lr', 'hypothesis/other', 'main'];
    const matches = simulateFindTraceDir(localDirs, 'test-lr');
    expect(matches).toContain('hypothesis/test-lr');
    expect(matches.length).toBe(1);
  });

  it('should find prefix match (hypothesis matches hypothesis/test)', () => {
    const matches = simulateFindTraceDir(dirs, 'hypothesis');
    expect(matches).toContain('hypothesis/test-branch');
    expect(matches).toContain('hypothesis/other');
    expect(matches.length).toBe(2);
  });

  it('should find direct prefix match (test-lr matches test-lr-experiment)', () => {
    // "test-lr" matches "test-lr-experiment" (starts with the branch name)
    const localDirs = ['hypothesis/test-branch', 'hypothesis/other', 'main', 'test-lr-experiment'];
    const matches = simulateFindTraceDir(localDirs, 'test-lr');
    expect(matches).toContain('test-lr-experiment');
    expect(matches.length).toBe(1);
  });

  it('should find suffix match in hypothesis branches', () => {
    // "my-test" matches "hypothesis__my-test" which is stored as "hypothesis/my-test"
    const localDirs = ['hypothesis/my-test', 'hypothesis/other', 'main'];
    const matches = simulateFindTraceDir(localDirs, 'my-test');
    expect(matches).toContain('hypothesis/my-test');
    expect(matches.length).toBe(1);
  });

  it('should return no matches when nothing matches', () => {
    const matches = simulateFindTraceDir(dirs, 'nonexistent');
    expect(matches.length).toBe(0);
  });
});

describe('trace file reading', () => {
  const testDir = join(tmpdir(), 'aesop-trace-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should read trace.jsonl and summarize', () => {
    const traceDir = join(testDir, 'hypothesis__test-branch');
    mkdirSync(traceDir, { recursive: true });

    const traceFile = join(traceDir, 'trace.jsonl');
    const lines = [
      JSON.stringify({
        t: '2024-01-01T00:00:00Z',
        kind: 'iteration',
        n: 1,
        metrics: { accuracy: 0.85 },
      }),
      JSON.stringify({
        t: '2024-01-01T00:00:01Z',
        kind: 'tool_call',
        tool: 'bash',
        input: { cmd: 'ls' },
      }),
      JSON.stringify({
        t: '2024-01-01T00:00:02Z',
        kind: 'tool_result',
        tool: 'bash',
        output: 'file.txt',
        truncated: false,
      }),
      JSON.stringify({
        t: '2024-01-01T00:00:03Z',
        kind: 'iteration',
        n: 2,
        metrics: { accuracy: 0.87 },
      }),
    ];
    writeFileSync(traceFile, lines.join('\n') + '\n');

    // Write a final diff
    writeFileSync(join(traceDir, 'final.diff'), '+ added line\n- removed line');

    // Read and summarize
    const content = readFileSync(traceFile, 'utf-8');
    const events = content
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const toolCalls = events.filter((e) => e.kind === 'tool_call');
    const iterations = events.filter((e) => e.kind === 'iteration');
    const lastIteration = iterations[iterations.length - 1];

    expect(toolCalls.length).toBe(1);
    expect(iterations.length).toBe(2);
    expect(lastIteration.metrics).toEqual({ accuracy: 0.87 });
    expect(existsSync(join(traceDir, 'final.diff'))).toBe(true);
  });
});

describe('metric formatting', () => {
  it('should format metrics for display', () => {
    const formatMetric = (metrics: Record<string, number> | null): string => {
      if (!metrics || Object.keys(metrics).length === 0) return '—';
      const first = Object.values(metrics)[0];
      return first?.toFixed(4) ?? '—';
    };

    expect(formatMetric({ accuracy: 0.85432 })).toBe('0.8543');
    expect(formatMetric({ loss: 0.00123 })).toBe('0.0012');
    expect(formatMetric({})).toBe('—');
    expect(formatMetric(null)).toBe('—');
  });
});
