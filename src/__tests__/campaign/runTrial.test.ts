import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import simpleGit from 'simple-git';
import { runTrial } from '../../campaign/runTrial';

/**
 * Create a test project with git initialized.
 */
async function createTestProject(
  projectPath: string,
  files: Record<string, string> = {}
): Promise<void> {
  mkdirSync(projectPath, { recursive: true });

  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeFileSync(join(projectPath, 'src', 'train.py'), files['train.py'] ?? 'print("train")');

  const validateScript = `#!/bin/bash
cat > eval_result.json << 'EOF'
{
  "accuracy": ${files['initial_accuracy'] ?? 0.5},
  "loss": 0.5
}
EOF
`;
  writeFileSync(join(projectPath, 'validate.sh'), validateScript);
  chmodSync(join(projectPath, 'validate.sh'), 0o755);

  const git = simpleGit();
  await git.cwd(projectPath).init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test User');
  await git.add('.');
  await git.commit('Initial commit');
}

const { mockSession, loaderOptions } = vi.hoisted(() => {
  return {
    mockSession: {
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { messages: [] },
    },
    loaderOptions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      last: null as any,
    },
  };
});

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();

  class MockDefaultResourceLoader {
    reload = vi.fn().mockResolvedValue(undefined);
    constructor(options: unknown) {
      loaderOptions.last = options;
    }
  }

  return {
    ...original,
    createAgentSession: vi.fn().mockResolvedValue({
      session: mockSession,
      extensionsResult: { extensions: [], errors: [] },
    }),
    SessionManager: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inMemory: vi.fn(() => ({})) as any,
    },
    DefaultResourceLoader: MockDefaultResourceLoader,
  };
});

// We mock ratchet just to be sure it's not called, even though we removed the import
vi.mock('../../ratchet.js', () => ({
  checkRatchet: vi.fn(),
  isNewGlobalBest: vi.fn(),
}));

import * as ratchet from '../../ratchet.js';

describe('runTrial', () => {
  let testRoot: string;
  let projectPath: string;
  let logs: string[];

  beforeEach(async () => {
    testRoot = join(
      tmpdir(),
      `aesop-run-trial-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    projectPath = join(testRoot, 'project');
    logs = [];

    await createTestProject(projectPath);

    mockSession.subscribe.mockClear();
    mockSession.prompt.mockClear();
    mockSession.dispose.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should complete a trial and write "completed" status to TrialLedger', async () => {
    const result = await runTrial({
      projectDir: projectPath,
      campaignId: '00000000-0000-0000-0000-000000000001',
      trialHypothesis: 'test-hypothesis',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxIterations: 1,
      onLog: (msg) => logs.push(msg),
    });

    expect(result.trialEntry.status).toBe('completed');
    expect(result.trialEntry.campaignId).toBe('00000000-0000-0000-0000-000000000001');

    const ledgerPath = join(projectPath, 'trials.jsonl');
    expect(existsSync(ledgerPath)).toBe(true);

    const content = readFileSync(ledgerPath, 'utf-8');
    const entries = content.trim().split('\n').filter(Boolean);
    expect(entries.length).toBe(1);

    const entry = JSON.parse(entries[0] as string);
    expect(entry.status).toBe('completed');
    expect(entry.trialHypothesis).toBe('test-hypothesis');
  });

  it('should mark trial as "failed" when validation fails', async () => {
    const failingAfterOneScript = `#!/bin/bash
if [ ! -f .called ]; then
  touch .called
  cat > eval_result.json << 'EOF'
{
  "accuracy": 0.5
}
EOF
  exit 0
else
  exit 1
fi
`;
    writeFileSync(join(projectPath, 'validate.sh'), failingAfterOneScript);
    chmodSync(join(projectPath, 'validate.sh'), 0o755);

    const result = await runTrial({
      projectDir: projectPath,
      campaignId: '00000000-0000-0000-0000-000000000002',
      trialHypothesis: 'fail-hypothesis',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxIterations: 1,
    });

    expect(result.trialEntry.status).toBe('failed');
    expect(result.trialEntry.error).toBeDefined();

    const ledgerPath = join(projectPath, 'trials.jsonl');
    const content = readFileSync(ledgerPath, 'utf-8');
    const entry = JSON.parse(content.trim().split('\n')[0] as string);
    expect(entry.status).toBe('failed');
  });

  it('should never call checkRatchet', async () => {
    await runTrial({
      projectDir: projectPath,
      campaignId: '00000000-0000-0000-0000-000000000003',
      trialHypothesis: 'no-ratchet-test',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxIterations: 1,
    });

    expect(ratchet.checkRatchet).not.toHaveBeenCalled();
  });

  it('should include trialHypothesis in the system prompt', async () => {
    const hypothesis = 'Very specific hypothesis 123';
    await runTrial({
      projectDir: projectPath,
      campaignId: '00000000-0000-0000-0000-000000000004',
      trialHypothesis: hypothesis,
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxIterations: 1,
    });

    const systemPrompt = await loaderOptions.last.systemPromptOverride();

    expect(systemPrompt).toContain(`You are an ML experiment trial agent`);
    expect(systemPrompt).toContain(`<hypothesis>${hypothesis}</hypothesis>`);
  });

  it('should provide rich iteration feedback including history and all metrics', async () => {
    await runTrial({
      projectDir: projectPath,
      campaignId: '00000000-0000-0000-0000-000000000005',
      trialHypothesis: 'feedback-test',
      validateCmd: './validate.sh',
      metricKey: 'accuracy',
      maxIterations: 3,
    });

    const prompts = mockSession.prompt.mock.calls.map((call) => call[0]);

    // Call 0: Iteration 1 request
    expect(prompts[0]).toContain('Iteration 1');

    // Call 1: Iteration 1 feedback
    const iter1Feedback = prompts[1];
    expect(iter1Feedback).toContain('Iteration 1 result:');
    expect(iter1Feedback).toContain('"accuracy":0.5');
    expect(iter1Feedback).toContain('"loss":0.5');
    expect(iter1Feedback).toContain('History: iter1=0.5');
    expect(iter1Feedback).toContain('Baseline: accuracy=0.5');

    // Call 2: Iteration 2 request
    expect(prompts[2]).toContain('Iteration 2');

    // Call 3: Iteration 2 feedback
    const iter2Feedback = prompts[3];
    expect(iter2Feedback).toContain('Iteration 2 result:');
    expect(iter2Feedback).toContain('History: iter1=0.5, iter2=0.5');
  });
});
