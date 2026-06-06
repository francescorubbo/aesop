import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa, ExecaError } from 'execa';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Aesop Campaign CLI Integration', () => {
  const testDir = join(tmpdir(), 'aesop-campaign-cli-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {}
  });

  async function runAesop(args: string[]) {
    return execa('node', ['--import', 'tsx', join(process.cwd(), 'src/cli.ts'), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    });
  }

  it('should render help for campaign command', async () => {
    const { stdout } = await runAesop(['campaign', '--help']);
    expect(stdout).toContain('Usage: aesop campaign [options] <question>');
    expect(stdout).toContain('--max-trials');
    expect(stdout).toContain('--max-iterations');
  });

  it('should fail if campaign question is missing', async () => {
    try {
      await runAesop(['campaign']);
      expect.fail('Should have thrown an error');
    } catch (error) {
      const execError = error as ExecaError;
      expect(execError.exitCode).toBe(1);
      expect(execError.stderr).toContain("error: missing required argument 'question'");
    }
  });
});
