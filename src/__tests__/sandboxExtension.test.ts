/**
 * Sandbox Extension Tests
 *
 * Tests for the Pi SDK extension that wires pathGuard into the tool_call hook.
 *
 * Intentionally imports nothing from '@earendil-works/pi-coding-agent' to avoid
 * mock contamination from other test files that vi.mock() the SDK at module level.
 * The handler is exercised directly via a plain object literal mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSandboxExtension } from '../sandboxExtension';

/** Result type from the tool_call handler */
interface BlockResult {
  block: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let workspacePath: string;
let handler: (
  _event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
  _ctx: unknown
) => Promise<BlockResult | undefined> | BlockResult | undefined;

beforeEach(() => {
  // Real temp directory with unique suffix — consistent with how pathGuard.ts
  // behaves in production where resolve() operates on a real path.
  workspacePath = join(
    tmpdir(),
    `sandbox-ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(workspacePath, { recursive: true });

  // Capture the tool_call handler. Plain object literal — no SDK imports.
  const factory = createSandboxExtension(workspacePath);
  factory({
    on: (_event: string, h: (..._args: unknown[]) => unknown) => {
      if (_event === 'tool_call') handler = h as typeof handler;
    },
  } as unknown as ExtensionAPI);
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(workspacePath, { recursive: true, force: true });
});

function makeEvent(toolName: string, input: Record<string, unknown>) {
  return { toolName, toolCallId: 'test-id', input };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('createSandboxExtension', () => {
  it('registers a tool_call handler', () => {
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  // -------------------------------------------------------------------------
  // bash tool
  // -------------------------------------------------------------------------

  describe('bash tool', () => {
    it('blocks commands that write to paths outside workspace', async () => {
      const result = await handler(
        makeEvent('bash', { command: 'echo "evil" > /tmp/payload.sh' }),
        {}
      );
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain('bash');
    });

    it('blocks commands that read from paths outside workspace', async () => {
      const result = await handler(makeEvent('bash', { command: 'cat /etc/passwd' }), {});
      expect(result).toMatchObject({ block: true });
    });

    it('blocks cd to paths outside workspace', async () => {
      const result = await handler(makeEvent('bash', { command: 'cd /tmp && ls' }), {});
      expect(result).toMatchObject({ block: true });
    });

    it('allows commands that stay within the workspace', async () => {
      const result = await handler(
        makeEvent('bash', { command: 'python train.py --epochs 10' }),
        {}
      );
      expect(result).toBeUndefined();
    });

    it('allows commands with no path arguments', async () => {
      const result = await handler(makeEvent('bash', { command: 'ls -la' }), {});
      expect(result).toBeUndefined();
    });

    it('allows redirection to paths within the workspace', async () => {
      const result = await handler(
        makeEvent('bash', { command: 'echo "result" > results.json' }),
        {}
      );
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // File tools
  // -------------------------------------------------------------------------

  describe('file tools', () => {
    it('blocks read tool with path outside workspace', async () => {
      const result = await handler(makeEvent('read', { path: '/etc/passwd' }), {});
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain('read');
    });

    it('allows read tool with relative path inside workspace', async () => {
      const result = await handler(makeEvent('read', { path: 'train.py' }), {});
      expect(result).toBeUndefined();
    });

    it('allows read tool with absolute path inside workspace', async () => {
      const result = await handler(
        makeEvent('read', { path: join(workspacePath, 'train.py') }),
        {}
      );
      expect(result).toBeUndefined();
    });

    it('blocks write tool with path outside workspace', async () => {
      const result = await handler(makeEvent('write', { path: '/tmp/evil.txt', content: 'x' }), {});
      expect(result).toMatchObject({ block: true });
    });

    it('blocks edit tool with path that escapes via ..', async () => {
      const result = await handler(makeEvent('edit', { path: '../other-project/config.py' }), {});
      expect(result).toMatchObject({ block: true });
    });

    it('blocks ls tool with path outside workspace', async () => {
      const result = await handler(makeEvent('ls', { path: '/tmp' }), {});
      expect(result).toMatchObject({ block: true });
    });
  });

  // -------------------------------------------------------------------------
  // Unknown tools
  // -------------------------------------------------------------------------

  describe('unknown tools', () => {
    it('passes through unknown tools without blocking', async () => {
      const result = await handler(makeEvent('some_custom_tool', { anything: 'value' }), {});
      expect(result).toBeUndefined();
    });

    it('passes through tools with no path arguments', async () => {
      const result = await handler(makeEvent('grep', {}), {});
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Workspace path scoping
  // -------------------------------------------------------------------------

  describe('workspace path scoping', () => {
    it('allows paths inside the workspace provided at construction', async () => {
      const result = await handler(
        makeEvent('read', { path: join(workspacePath, 'train.py') }),
        {}
      );
      expect(result).toBeUndefined();
    });

    it('blocks paths that share a prefix with the workspace but are outside it', async () => {
      // e.g. workspacePath is /tmp/abc, this is /tmp/abc-evil
      const result = await handler(
        makeEvent('read', { path: `${workspacePath}-evil/train.py` }),
        {}
      );
      expect(result).toMatchObject({ block: true });
    });
  });
});
