/**
 * Sandbox Extension
 *
 * Pi SDK extension that enforces workspace boundary restrictions on agent tool calls.
 * Uses the SDK's `tool_call` event to intercept and block path escapes.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isPathInWorkspace, checkBashCommandSafe } from './pathGuard.js';

/**
 * Path-like argument names per tool.
 * Only known built-in tools are checked; unknown/custom tools pass through.
 */
const TOOL_PATH_ARGS: Record<string, string> = {
  read: 'path',
  write: 'path',
  edit: 'path',
  grep: 'path',
  find: 'path',
  ls: 'path',
};

/**
 * Returns a Pi extension factory that blocks agent tool calls escaping
 * the given workspace path.
 *
 * @param workspacePath - Absolute path to the sandbox boundary
 * @returns Pi extension factory to pass to DefaultResourceLoader's extensionFactories
 *
 * @example
 * ```typescript
 * const resourceLoader = new DefaultResourceLoader({
 *   cwd: workspace.path,
 *   agentDir: getAgentDir(),
 *   extensionFactories: [createSandboxExtension(workspace.path)],
 *   systemPromptOverride: () => systemPrompt,
 *   appendSystemPromptOverride: () => [],
 * });
 * await resourceLoader.reload();
 *
 * const { session } = await createAgentSession({
 *   cwd: workspace.path,
 *   sessionManager: SessionManager.inMemory(workspace.path),
 *   resourceLoader,
 *   // ...
 * });
 * ```
 */
export function createSandboxExtension(workspacePath: string): (_pi: ExtensionAPI) => void {
  return function sandboxExtension(_pi: ExtensionAPI): void {
    _pi.on('tool_call', async (event, _ctx) => {
      // Guard bash commands: block redirections, cd, and absolute paths
      if (event.toolName === 'bash') {
        const input = event.input as { command?: string; timeout?: number };
        const command = input.command ?? '';
        const check = checkBashCommandSafe(command, workspacePath);
        if (!check.allowed) {
          return {
            block: true,
            reason: `Sandbox violation (bash): ${check.error ?? 'Path escape detected'}`,
          };
        }
        return undefined;
      }

      // Guard file tools: block paths outside the workspace
      const pathArg = TOOL_PATH_ARGS[event.toolName];
      if (!pathArg) {
        return undefined;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input = event.input as any;
      const pathValue = input[pathArg];

      if (typeof pathValue !== 'string' || pathValue.length === 0) {
        return undefined;
      }

      if (!isPathInWorkspace(pathValue, workspacePath)) {
        return {
          block: true,
          reason: `Sandbox violation (${event.toolName}): path "${pathValue}" is outside workspace`,
        };
      }

      return undefined;
    });
  };
}
