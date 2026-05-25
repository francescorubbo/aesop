/**
 * Path Guard Tests
 *
 * Tests for workspace sandbox enforcement via path guards.
 * These tests verify that path escape attempts are blocked.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  isPathInWorkspace,
  checkBashCommandSafe,
  analyzeBashCommand,
  withPathGuard,
  withPathGuards,
  createGuardedTools,
} from '../pathGuard';

/**
 * Create a temporary workspace directory for testing.
 */
function createTestWorkspace(name: string): string {
  const workspacePath = join(
    tmpdir(),
    `path-guard-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(workspacePath, { recursive: true });
  // Create a subdirectory for testing nested paths
  mkdirSync(join(workspacePath, 'src'), { recursive: true });
  mkdirSync(join(workspacePath, 'nested', 'deep'), { recursive: true });
  return workspacePath;
}

/**
 * Check if an AgentToolResult indicates an error.
 */
function isToolResultError(result: AgentToolResult<unknown>): boolean {
  return result.content.some((c) => c.type === 'text' && c.text.includes('outside workspace'));
}

/**
 * Get error text from a tool result.
 */
function getToolResultError(result: AgentToolResult<unknown>): string | undefined {
  const textContent = result.content.find((c) => c.type === 'text');
  return textContent?.type === 'text' ? textContent.text : undefined;
}

describe('isPathInWorkspace', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('isPathInWorkspace');
  });

  it('should allow paths within workspace', () => {
    expect(isPathInWorkspace('src/file.py', workspacePath).allowed).toBe(true);
    expect(isPathInWorkspace('./src/file.py', workspacePath).allowed).toBe(true);
  });

  it('should allow absolute paths within workspace', () => {
    const absPath = join(workspacePath, 'src', 'file.py');
    expect(isPathInWorkspace(absPath, workspacePath).allowed).toBe(true);
  });

  it('should block paths outside workspace', () => {
    expect(isPathInWorkspace('/etc/passwd', workspacePath).allowed).toBe(false);
    expect(isPathInWorkspace('../other', workspacePath).allowed).toBe(false);
    expect(isPathInWorkspace('/tmp/evil', workspacePath).allowed).toBe(false);
  });

  it('should block paths that escape via ..', () => {
    const evilPath = join(workspacePath, '..', 'other-project', 'file.py');
    expect(isPathInWorkspace(evilPath, workspacePath).allowed).toBe(false);
  });

  it('should handle nested paths correctly', () => {
    expect(isPathInWorkspace('nested/deep/file.txt', workspacePath).allowed).toBe(true);
    // nested/../etc is a sibling of nested, which is inside workspace
    expect(isPathInWorkspace('nested/../etc', workspacePath).allowed).toBe(true);
    // Only truly external paths should be blocked
    expect(isPathInWorkspace('../../etc/passwd', workspacePath).allowed).toBe(false);
  });

  it('should provide error message when blocked', () => {
    const result = isPathInWorkspace('/etc/passwd', workspacePath);
    expect(result.allowed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('/etc/passwd');
    expect(result.error).toContain('outside workspace');
  });
});

describe('checkBashCommandSafe', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('checkBashCommandSafe');
  });

  it('should allow safe bash commands', () => {
    expect(checkBashCommandSafe('ls', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cat src/file.py', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('python train.py', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cd src && ls', workspacePath).allowed).toBe(true);
  });

  it('should allow redirection to workspace paths', () => {
    expect(checkBashCommandSafe('echo "test" > output.txt', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cat file.py > results/output.json', workspacePath).allowed).toBe(
      true
    );
    expect(checkBashCommandSafe('cat file.py >> results/output.json', workspacePath).allowed).toBe(
      true
    );
  });

  it('should block redirection to paths outside workspace', () => {
    expect(checkBashCommandSafe('echo "test" > /tmp/evil.txt', workspacePath).allowed).toBe(false);
    expect(checkBashCommandSafe('echo "test" > ../other.txt', workspacePath).allowed).toBe(false);
    expect(checkBashCommandSafe('cat file.py > /etc/passwd', workspacePath).allowed).toBe(false);
  });

  it('should block cd to paths outside workspace', () => {
    expect(checkBashCommandSafe('cd /tmp', workspacePath).allowed).toBe(false);
    expect(checkBashCommandSafe('cd ..', workspacePath).allowed).toBe(false);
    expect(checkBashCommandSafe('cd /etc', workspacePath).allowed).toBe(false);
  });

  it('should allow safe cd commands', () => {
    expect(checkBashCommandSafe('cd src', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cd ./src', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cd nested/deep', workspacePath).allowed).toBe(true);
  });

  it('should allow cd to home and special targets', () => {
    expect(checkBashCommandSafe('cd ~', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cd -', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cd', workspacePath).allowed).toBe(true);
  });

  it('should handle absolute path commands outside workspace', () => {
    expect(checkBashCommandSafe('cat /etc/passwd', workspacePath).allowed).toBe(false);
    expect(checkBashCommandSafe('cp file.txt /tmp/evil.txt', workspacePath).allowed).toBe(false);
  });

  it('should allow commands with system binary paths', () => {
    // System binaries are allowed
    expect(checkBashCommandSafe('ls /usr/bin', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('cat /bin/bashrc', workspacePath).allowed).toBe(true);
    expect(checkBashCommandSafe('python /usr/local/bin/script.py', workspacePath).allowed).toBe(
      true
    );
  });

  it('should provide error messages for blocked commands', () => {
    const result = checkBashCommandSafe('echo "test" > /tmp/evil.txt', workspacePath);
    expect(result.allowed).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('analyzeBashCommand', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('analyzeBashCommand');
  });

  it('should report safe commands', () => {
    const result = analyzeBashCommand('ls -la', workspacePath);
    expect(result.safe).toBe(true);
    expect(result.escapedPaths).toHaveLength(0);
  });

  it('should report all escaped paths', () => {
    const result = analyzeBashCommand('cat /etc/passwd > /tmp/evil.txt', workspacePath);
    expect(result.safe).toBe(false);
    expect(result.escapedPaths).toContain('/etc/passwd');
    expect(result.escapedPaths).toContain('/tmp/evil.txt');
  });

  it('should handle multiple cd commands', () => {
    const result = analyzeBashCommand('cd /tmp && cd /etc', workspacePath);
    expect(result.safe).toBe(false);
    expect(result.escapedPaths).toContain('/tmp');
    expect(result.escapedPaths).toContain('/etc');
  });
});

describe('withPathGuard', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('withPathGuard');
  });

  it('should pass through allowed tool executions', async () => {
    // Create a mock tool with proper interface
    const mockTool: AgentTool = {
      name: 'read',
      label: 'Read File',
      description: 'Read a file',
      parameters: {} as any,
      execute: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: 'file contents' }],
        details: undefined,
      }),
    };

    const guardedTool = withPathGuard(mockTool, workspacePath);

    await guardedTool.execute('call-1', { path: 'src/file.py' });

    expect(mockTool.execute).toHaveBeenCalledTimes(1);
    expect(mockTool.execute).toHaveBeenCalledWith(
      'call-1',
      { path: 'src/file.py' },
      undefined,
      undefined
    );
  });

  it('should block tool execution with paths outside workspace', async () => {
    const mockTool: AgentTool = {
      name: 'read',
      label: 'Read File',
      description: 'Read a file',
      parameters: {} as any,
      execute: vi.fn().mockResolvedValue({
        content: [],
        details: undefined,
      }),
    };

    const guardedTool = withPathGuard(mockTool, workspacePath);

    const result = await guardedTool.execute('call-2', { path: '/etc/passwd' });

    expect(mockTool.execute).not.toHaveBeenCalled();
    expect(isToolResultError(result)).toBe(true);
    expect(getToolResultError(result)).toContain('outside workspace');
  });

  it('should block bash tool with dangerous commands', async () => {
    const mockBashTool: AgentTool = {
      name: 'bash',
      label: 'Bash',
      description: 'Execute bash command',
      parameters: {} as any,
      execute: vi.fn().mockResolvedValue({
        content: [{ type: 'text' as const, text: 'output' }],
        details: undefined,
      }),
    };

    const guardedTool = withPathGuard(mockBashTool, workspacePath);

    const result = await guardedTool.execute('call-3', { command: 'echo "evil" > /tmp/evil.txt' });

    expect(mockBashTool.execute).not.toHaveBeenCalled();
    expect(isToolResultError(result)).toBe(true);
    expect(getToolResultError(result)).toContain('outside workspace');
  });

  it('should call onBlocked callback when execution is blocked', async () => {
    const onBlocked = vi.fn();

    const mockTool: AgentTool = {
      name: 'read',
      label: 'Read File',
      description: 'Read a file',
      parameters: {} as any,
      execute: vi.fn(),
    };

    const guardedTool = withPathGuard(mockTool, workspacePath, onBlocked);

    await guardedTool.execute('call-4', { path: '/etc/passwd' });

    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith('read', { path: '/etc/passwd' }, expect.any(String));
  });

  it('should handle write tool', async () => {
    const mockWriteTool: AgentTool = {
      name: 'write',
      label: 'Write File',
      description: 'Write a file',
      parameters: {} as any,
      execute: vi.fn().mockResolvedValue({
        content: [],
        details: undefined,
      }),
    };

    const guardedTool = withPathGuard(mockWriteTool, workspacePath);

    // Block write outside workspace
    const blockedResult = await guardedTool.execute('call-5', {
      path: '/tmp/evil.txt',
      content: 'evil',
    });
    expect(mockWriteTool.execute).not.toHaveBeenCalled();
    expect(isToolResultError(blockedResult)).toBe(true);

    // Allow write within workspace
    mockWriteTool.execute = vi.fn().mockResolvedValue({
      content: [],
      details: undefined,
    });
    const allowedResult = await guardedTool.execute('call-6', {
      path: 'src/newfile.txt',
      content: 'content',
    });
    expect(mockWriteTool.execute).toHaveBeenCalledTimes(1);
    expect(isToolResultError(allowedResult)).toBe(false);
  });

  it('should handle edit tool', async () => {
    const mockEditTool: AgentTool = {
      name: 'edit',
      label: 'Edit File',
      description: 'Edit a file',
      parameters: {} as any,
      execute: vi.fn().mockResolvedValue({
        content: [],
        details: undefined,
      }),
    };

    const guardedTool = withPathGuard(mockEditTool, workspacePath);

    // Block edit outside workspace
    const blockedResult = await guardedTool.execute('call-7', { path: '../evil.txt' });
    expect(mockEditTool.execute).not.toHaveBeenCalled();
    expect(isToolResultError(blockedResult)).toBe(true);

    // Allow edit within workspace
    mockEditTool.execute = vi.fn().mockResolvedValue({
      content: [],
      details: undefined,
    });
    const allowedResult = await guardedTool.execute('call-8', { path: 'src/file.py' });
    expect(mockEditTool.execute).toHaveBeenCalledTimes(1);
    expect(isToolResultError(allowedResult)).toBe(false);
  });
});

describe('withPathGuards', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('withPathGuards');
  });

  it('should wrap multiple tools', () => {
    const tools: AgentTool[] = [
      {
        name: 'read',
        label: 'Read',
        description: '',
        parameters: {},
        execute: vi.fn(),
      } as AgentTool,
      {
        name: 'write',
        label: 'Write',
        description: '',
        parameters: {},
        execute: vi.fn(),
      } as AgentTool,
      {
        name: 'bash',
        label: 'Bash',
        description: '',
        parameters: {},
        execute: vi.fn(),
      } as AgentTool,
    ];

    const guardedTools = withPathGuards(tools, workspacePath);

    expect(guardedTools).toHaveLength(3);
    expect(guardedTools[0]!.name).toBe('read');
    expect(guardedTools[1]!.name).toBe('write');
    expect(guardedTools[2]!.name).toBe('bash');
  });

  it('should block path escapes on all wrapped tools', async () => {
    const execute = vi.fn();
    const tools: AgentTool[] = [
      { name: 'read', label: 'Read', description: '', parameters: {}, execute } as AgentTool,
      { name: 'write', label: 'Write', description: '', parameters: {}, execute } as AgentTool,
    ];

    const guardedTools = withPathGuards(tools, workspacePath);

    // Try to escape via read
    await guardedTools[0]!.execute('call-1', { path: '/etc/passwd' });
    expect(execute).not.toHaveBeenCalled();

    // Try to escape via write
    await guardedTools[1]!.execute('call-2', { path: '/tmp/evil.txt', content: 'test' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('createGuardedTools', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('createGuardedTools');
  });

  it('should wrap provided tools with guards', () => {
    const originalTools: AgentTool[] = [
      {
        name: 'read',
        label: 'Read',
        description: 'Read',
        parameters: {},
        execute: vi.fn(),
      } as AgentTool,
      {
        name: 'bash',
        label: 'Bash',
        description: 'Bash',
        parameters: {},
        execute: vi.fn(),
      } as AgentTool,
    ];

    const blockedCalls: string[] = [];
    const guardedTools = createGuardedTools(originalTools, workspacePath, (name) => {
      blockedCalls.push(name);
    });

    expect(guardedTools).toHaveLength(2);

    // Test path escape is blocked
    guardedTools[0]!.execute('call-1', { path: '/etc/passwd' });
    expect(blockedCalls).toContain('read');

    guardedTools[1]!.execute('call-2', { command: 'echo test > /tmp/evil' });
    expect(blockedCalls).toContain('bash');
  });

  it('should preserve original tool metadata', () => {
    const originalTools: AgentTool[] = [
      {
        name: 'edit',
        label: 'Edit Files',
        description: 'Edit files',
        parameters: {},
        execute: vi.fn(),
      } as AgentTool,
    ];

    const guardedTools = createGuardedTools(originalTools, workspacePath);

    expect(guardedTools[0]!.name).toBe('edit');
    expect(guardedTools[0]!.description).toBe('Edit files');
  });
});

describe('edge cases', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('edgeCases');
  });

  it('should handle empty path parameters', async () => {
    const mockTool: AgentTool = {
      name: 'read',
      label: 'Read',
      description: '',
      parameters: {},
      execute: vi.fn().mockResolvedValue({ content: [], details: undefined }),
    };

    const guardedTool = withPathGuard(mockTool, workspacePath);

    // Empty path should be allowed (tool may handle it)
    await guardedTool.execute('call-1', { path: '' });
    expect(mockTool.execute).toHaveBeenCalled();
  });

  it('should handle paths with special characters', () => {
    // These should be blocked if outside workspace
    expect(isPathInWorkspace('/tmp/with spaces.txt', workspacePath).allowed).toBe(false);
    expect(isPathInWorkspace('/tmp/with"quotes.txt', workspacePath).allowed).toBe(false);
    expect(isPathInWorkspace("/tmp/with'quotes.txt", workspacePath).allowed).toBe(false);

    // These should be allowed
    expect(isPathInWorkspace('src/with spaces.txt', workspacePath).allowed).toBe(true);
    expect(isPathInWorkspace("src/with'quotes.txt", workspacePath).allowed).toBe(true);
  });

  it('should handle very long paths', () => {
    const longPath = '/tmp/' + 'a'.repeat(1000);
    expect(isPathInWorkspace(longPath, workspacePath).allowed).toBe(false);

    const longWorkspacePath = join(workspacePath, 'src', 'nested'.repeat(100));
    expect(isPathInWorkspace(join(longWorkspacePath, 'file.txt'), workspacePath).allowed).toBe(
      true
    );
  });

  it('should handle symbolic links within workspace', () => {
    // Symbolic links within workspace are allowed (they resolve to the workspace)
    expect(isPathInWorkspace('src/../src/file.txt', workspacePath).allowed).toBe(true);
  });

  it('should handle complex bash command patterns', () => {
    // Multiple redirections
    expect(checkBashCommandSafe('cmd > /tmp/a.txt 2> /tmp/b.txt', workspacePath).allowed).toBe(
      false
    );

    // Piping with escapes
    expect(checkBashCommandSafe('cat file.txt | tee /tmp/output.txt', workspacePath).allowed).toBe(
      false
    );

    // Heredocs with external paths (would be dangerous)
    expect(
      checkBashCommandSafe('cat << EOF\ndata\nEOF > /tmp/out.txt', workspacePath).allowed
    ).toBe(false);
  });
});

describe('integration scenarios', () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = createTestWorkspace('integration');
  });

  it('should model a typical path escape attack', () => {
    // Simulate an agent attempting to write to /tmp
    const attackAttempts = [
      { command: 'echo "malicious" > /tmp/payload.sh' },
      { command: 'cat /etc/shadow' },
      { command: 'cd /root && ls' },
      { command: "python -c \"import os; open('/tmp/evil','w').write('x')\"" },
    ];

    for (const attempt of attackAttempts) {
      const result = checkBashCommandSafe(attempt.command, workspacePath);
      expect(result.allowed).toBe(false);
    }
  });

  it('should model valid agent operations', () => {
    // Simulate legitimate agent operations
    const validCommands = [
      'ls -la',
      'cat src/train.py',
      'python train.py --epochs 10',
      'echo "result: 0.85" > results.json',
      'cd src && python evaluate.py',
      './validate.sh',
    ];

    for (const cmd of validCommands) {
      const result = checkBashCommandSafe(cmd, workspacePath);
      expect(result.allowed).toBe(true);
    }
  });
});
