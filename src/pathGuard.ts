/**
 * Path Guard for Workspace Sandboxing
 *
 * Provides enforcement that the agent can only access files within the workspace.
 * This replaces comment-based conventions with technical enforcement.
 *
 * Integrated via `createSandboxExtension()` in sandboxExtension.ts,
 * which wires this module into the Pi SDK's tool_call extension hook.
 */

import { resolve, isAbsolute } from 'node:path';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';

/**
 * Result of a path check operation.
 */
export interface PathCheckResult {
  /** Whether the path is allowed */
  allowed: boolean;
  /** The checked path (resolved) */
  path: string;
  /** Error message if not allowed */
  error?: string;
}

/**
 * Check if a path is within the workspace boundary.
 * Resolves relative paths against the workspace and checks containment.
 */
export function isPathInWorkspace(filePath: string, workspacePath: string): PathCheckResult {
  const resolvedWorkspace = resolve(workspacePath);
  let resolvedPath: string;

  if (isAbsolute(filePath)) {
    resolvedPath = resolve(filePath);
  } else {
    resolvedPath = resolve(workspacePath, filePath);
  }

  // A path is outside the workspace if the resolved path does not start with
  // the workspace path. We normalize both to ensure the workspace path ends
  // with a separator for accurate prefix matching.
  const normalizedWorkspace = resolvedWorkspace.endsWith('/')
    ? resolvedWorkspace
    : `${resolvedWorkspace}/`;

  if (!resolvedPath.startsWith(normalizedWorkspace)) {
    return {
      allowed: false,
      path: resolvedPath,
      error: `Path "${filePath}" resolves to "${resolvedPath}" which is outside workspace "${resolvedWorkspace}"`,
    };
  }

  return {
    allowed: true,
    path: resolvedPath,
  };
}

/**
 * Check a bash command for path escape attempts.
 * Detects:
 * - Redirection to paths outside workspace (> path, >> path)
 * - cd to paths outside workspace
 * - Commands that reference absolute paths outside workspace
 */
export function checkBashCommandSafe(command: string, workspacePath: string): PathCheckResult {
  const resolvedWorkspace = resolve(workspacePath);

  // Pattern for redirection: > path, >> path, 2> path, &> path
  // Captures: >, >>, 2>, &>, 1>, 2>>, &>>
  const redirectionPattern = /(?:[12]?&?>+|&>)\s*(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = redirectionPattern.exec(command)) !== null) {
    const targetPath = match[1]!;
    if (targetPath.startsWith('-')) {
      // Flag, not a path (e.g., 2>&1)
      continue;
    }
    const result = isPathInWorkspace(targetPath, workspacePath);
    if (!result.allowed) {
      return result;
    }
  }

  // Pattern for cd command
  const cdPattern = /\bcd\s+(['"]?)(\S+)\1/g;
  while ((match = cdPattern.exec(command)) !== null) {
    const targetPath = match[2]!;
    // Skip special cd targets
    if (targetPath === '' || targetPath === '~' || targetPath === '-') {
      continue;
    }
    const result = isPathInWorkspace(targetPath, workspacePath);
    if (!result.allowed) {
      return result;
    }
  }

  // Pattern for absolute paths in various command contexts
  // This catches things like: cat /path/to/file, cp /path /other, etc.
  // Note: /etc is NOT safe - it can contain sensitive system config files
  const absolutePathPattern = /(?<![a-zA-Z0-9_.\-\/])(?:\/(?!\/)[^\s'"(]+)/g;
  while ((match = absolutePathPattern.exec(command)) !== null) {
    const absolutePath = match[0]!;
    // Skip common safe system directories (binaries, not user data files)
    // Note: /etc is NOT safe - it contains system configuration
    const safePrefixes = ['/usr/bin', '/usr/local/bin', '/bin', '/sbin', '/dev', '/proc', '/sys'];
    if (
      safePrefixes.some(
        (prefix) => absolutePath.startsWith(prefix + '/') || absolutePath === prefix
      )
    ) {
      continue;
    }
    // Check if it's an absolute path that could be a project file
    const result = isPathInWorkspace(absolutePath, workspacePath);
    if (!result.allowed) {
      return result;
    }
  }

  return {
    allowed: true,
    path: resolvedWorkspace,
  };
}

/**
 * Result of a bash command check with detailed escape indicators.
 */
export interface BashEscapeCheckResult {
  safe: boolean;
  /** Paths detected in the command that were outside workspace */
  escapedPaths: string[];
  /** Error message if not safe */
  error?: string;
}

/**
 * Analyze a bash command for path escape attempts.
 * Returns detailed information about any detected escapes.
 */
export function analyzeBashCommand(command: string, workspacePath: string): BashEscapeCheckResult {
  const escapedPaths: string[] = [];

  // Check redirections
  const redirectionPattern = /(?:[12]?&?>+|&>)\s*(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = redirectionPattern.exec(command)) !== null) {
    const targetPath = match[1]!;
    if (targetPath.startsWith('-')) continue;
    const result = isPathInWorkspace(targetPath, workspacePath);
    if (!result.allowed) {
      escapedPaths.push(targetPath);
    }
  }

  // Check cd commands
  const cdPattern = /\bcd\s+(['"]?)(\S+)\1/g;
  while ((match = cdPattern.exec(command)) !== null) {
    const targetPath = match[2]!;
    if (targetPath === '' || targetPath === '~' || targetPath === '-') continue;
    const result = isPathInWorkspace(targetPath, workspacePath);
    if (!result.allowed) {
      escapedPaths.push(targetPath);
    }
  }

  // Check absolute paths (excluding safe system directories)
  const safePrefixes = ['/usr/bin', '/usr/local/bin', '/bin', '/sbin', '/dev', '/proc', '/sys'];
  const absolutePathPattern = /(?<![a-zA-Z0-9_.\-\/])(?:\/(?!\/)[^\s'"(]+)/g;
  while ((match = absolutePathPattern.exec(command)) !== null) {
    const absolutePath = match[0]!;
    if (
      safePrefixes.some(
        (prefix) => absolutePath.startsWith(prefix + '/') || absolutePath === prefix
      )
    ) {
      continue;
    }
    const result = isPathInWorkspace(absolutePath, workspacePath);
    if (!result.allowed) {
      escapedPaths.push(absolutePath);
    }
  }

  if (escapedPaths.length > 0) {
    return {
      safe: false,
      escapedPaths,
      error: `Command attempts to access paths outside workspace: ${escapedPaths.join(', ')}`,
    };
  }

  return {
    safe: true,
    escapedPaths: [],
  };
}

/**
 * Path parameter names for each tool that may contain file paths.
 */
const TOOL_PATH_PARAMS: Record<string, string[]> = {
  read: ['path', 'file'],
  write: ['path', 'file'],
  edit: ['path', 'file'],
  grep: ['path', 'pattern'],
  find: ['path', 'directory'],
  ls: ['path', 'directory'],
};

/**
 * Error result returned when path guard blocks a tool execution.
 */
function pathGuardError<TDetails>(errorMessage: string): AgentToolResult<TDetails> {
  const content: TextContent[] = [{ type: 'text', text: errorMessage }];
  return {
    content,
    details: undefined as TDetails,
  };
}

/**
 * Callback type for when a path escape is blocked.
 */
type PathBlockedCallback = (_toolName: string, _params: unknown, _reason: string) => void;

/**
 * Wrap a tool with path guard enforcement.
 * The wrapped tool will reject any execution that attempts to access
 * paths outside the specified workspace.
 *
 * @param tool - The tool to wrap
 * @param workspacePath - The workspace boundary
 * @param onBlocked - Optional callback when a path escape is blocked
 * @returns Wrapped tool with path guard
 */
export function withPathGuard<TDetails = unknown>(
  tool: AgentTool,
  workspacePath: string,
  onBlocked?: PathBlockedCallback
): AgentTool {
  const toolName = tool.name ?? 'unknown';
  const pathParams = TOOL_PATH_PARAMS[toolName] ?? ['path', 'file'];

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined
    ): Promise<AgentToolResult<TDetails>> => {
      const paramsRecord = params as Record<string, unknown>;

      // Check path parameters
      for (const paramName of pathParams) {
        const pathValue = paramsRecord[paramName];
        if (typeof pathValue === 'string' && pathValue.length > 0) {
          const check = isPathInWorkspace(pathValue, workspacePath);
          if (!check.allowed) {
            onBlocked?.(toolName, params, check.error ?? 'Path outside workspace');
            return pathGuardError(check.error ?? `Path "${pathValue}" is outside workspace`);
          }
        }
      }

      // Special handling for bash tool
      if (toolName === 'bash') {
        const command = paramsRecord['command'] as string | undefined;
        if (command) {
          const check = checkBashCommandSafe(command, workspacePath);
          if (!check.allowed) {
            onBlocked?.(toolName, params, check.error ?? 'Bash command escapes workspace');
            return pathGuardError(check.error ?? 'Bash command accesses paths outside workspace');
          }
        }
      }

      // Execute the original tool
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Wrap multiple tools with path guards.
 *
 * @param tools - Array of tools to wrap
 * @param workspacePath - The workspace boundary
 * @param onBlocked - Optional callback when a path escape is blocked
 * @returns Array of wrapped tools
 */
export function withPathGuards(
  tools: AgentTool[],
  workspacePath: string,
  onBlocked?: PathBlockedCallback
): AgentTool[] {
  return tools.map((tool) => withPathGuard(tool, workspacePath, onBlocked));
}

/**
 * Create path-guarded versions of standard coding tools.
 *
 * NOTE: This is NOT the active enforcement mechanism in Aesop.
 * Sandbox enforcement is applied via the Pi SDK's tool_call extension hook
 * in sandboxExtension.ts, which calls isPathInWorkspace() and
 * checkBashCommandSafe() directly.
 *
 * This function is kept as a standalone utility for consumers who want to
 * apply path guards outside of the Pi extension system (e.g., in tests or
 * alternative integrations).
 *
 * @param tools - Standard coding tools (from createCodingTools)
 * @param workspacePath - The workspace boundary
 * @param onBlocked - Optional callback when a path escape is blocked
 * @returns Path-guarded tools
 */
export function createGuardedTools(
  tools: AgentTool[],
  workspacePath: string,
  onBlocked?: PathBlockedCallback
): AgentTool[] {
  return withPathGuards(tools, workspacePath, onBlocked);
}
