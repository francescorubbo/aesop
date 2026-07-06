import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { PhaseContext, PhaseExecutor } from './types.js';
import { ScaffoldPlan, ScaffoldResult } from './scaffoldTypes.js';
import { createSandboxExtension } from '../../sandboxExtension.js';
import { runWithValidation } from '../../validateContract.js';

/**
 * ScaffoldPhaseExecutor
 *
 * This phase uses a Pi coding agent to implement the initial scaffolding
 * of an experiment. It operates on the existing workspacePath provided in
 * the context.
 */
export class ScaffoldPhaseExecutor implements PhaseExecutor<ScaffoldPlan, ScaffoldResult> {
  async execute(plan: ScaffoldPlan, ctx: PhaseContext): Promise<ScaffoldResult> {
    const { hypothesis, model, maxIterations = 10 } = plan;
    const { workspacePath, validateCmd, metricKey } = ctx;

    const systemPrompt = this.buildSystemPrompt(hypothesis, workspacePath);

    // Register complete_scaffold tool
    let exposedParams: Record<string, string> = {};
    let scaffoldCompleted = false;

    const scaffoldExtension = {
      extension: defineTool({
        name: 'complete_scaffold',
        label: 'Complete Scaffold',
        description:
          'Call this tool to signal that the scaffolding is complete and the implementation is ready for validation.',
        parameters: {
          type: 'object',
          properties: {
            parametersExposed: {
              type: 'object',
              description:
                'A map of flag names to their default values that are now available in the implementation.',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['parametersExposed'],
        },
        execute: async (_toolCallId, params) => {
          const parametersExposed = params.parametersExposed as Record<string, string> | undefined;
          if (parametersExposed) {
            exposedParams = parametersExposed;
          }
          scaffoldCompleted = true;
          return {
            content: [
              {
                type: 'text',
                text: 'Scaffolding marked as complete. The harness will now perform a final validation run.',
              },
            ],
            details: 'Scaffold completed by agent.',
          };
        },
      }),
    };

    const resourceLoader = new DefaultResourceLoader({
      cwd: workspacePath,
      agentDir: getAgentDir(),
      extensionFactories: [
        createSandboxExtension(workspacePath),
        () => scaffoldExtension.extension,
      ],
      systemPromptOverride: () => systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();

    const authStorage = AuthStorage.create();
    if (process.env['GEMINI_API_KEY']) {
      authStorage.setRuntimeApiKey('google', process.env['GEMINI_API_KEY']!);
    }
    if (process.env['ANTHROPIC_API_KEY']) {
      authStorage.setRuntimeApiKey('anthropic', process.env['ANTHROPIC_API_KEY']!);
    }
    const modelRegistry = ModelRegistry.create(authStorage);

    // Resolve model if provided
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolvedModel: any = undefined;
    if (model) {
      const parts = model.split('/');
      if (parts.length === 2 && parts[0] && parts[1]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const foundModel = getModel(parts[0] as any, parts[1]);
        if (foundModel) {
          resolvedModel = foundModel;
        }
      }
    }

    const { session } = await createAgentSession({
      cwd: workspacePath,
      sessionManager: SessionManager.inMemory(workspacePath),
      resourceLoader,
      authStorage,
      modelRegistry,
      model: resolvedModel,
      tools: ['read', 'bash', 'edit', 'write'],
    });

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (scaffoldCompleted) break;

        await session.prompt(
          `Iteration ${i + 1}/${maxIterations}. Please implement the required scaffolding. ` +
            `Once you are satisfied, call 'complete_scaffold' with the parameters you've exposed. ` +
            `You can verify your progress by running: ${validateCmd}`
        );
      }

      if (!scaffoldCompleted) {
        return {
          status: 'failed',
          parametersExposed: {},
          error: `Agent failed to call complete_scaffold within ${maxIterations} iterations.`,
        };
      }

      // Final validation
      const validation = await runWithValidation(workspacePath, validateCmd, metricKey);
      if (validation.success) {
        return {
          status: 'completed',
          parametersExposed: exposedParams,
        };
      } else {
        return {
          status: 'failed',
          parametersExposed: {},
          error: `Scaffolding completed but final validation failed: ${validation.error}`,
        };
      }
    } finally {
      session.dispose();
    }
  }

  private buildSystemPrompt(hypothesis: string, workspacePath: string): string {
    return `You are an ML experiment scaffolding agent. Your goal is to implement the initial setup for the following hypothesis:
<hypothesis>${hypothesis}</hypothesis>

Rules:
- Implementation work is permitted and encouraged.
- Default values must reproduce current behaviour if they exist.
- The validate script (${this.validateScriptPath(workspacePath)}) is strictly off-limits; do not modify it.
- You may only edit files within the workspace.
- Use the 'complete_scaffold' tool when you have implemented the required changes and are ready for final validation.

Workspace: ${workspacePath}`;
  }

  private validateScriptPath(_workspacePath: string): string {
    return 'aesop_validate.sh'; // In the the context of the workspace, it's usually this
  }
}
