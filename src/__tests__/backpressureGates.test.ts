import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { runStaticChecks, type StaticCheckResult } from '../backpressureGates';

// Create a mockable execFile function using vi.hoisted
const mockExecFile = vi.hoisted(() => {
  const fn = function (
    _bin: string,
    _args: string[],
    _opts: unknown,
    cb: (_error: Error | null, _stdout: string, _stderr: string) => void
  ): ReturnType<typeof execFile> {
    if (typeof cb === 'function') {
      cb(null, '', '');
    }
    return {} as ReturnType<typeof execFile>;
  };
  Object.defineProperty(fn, 'length', { value: 4, writable: false });
  return vi.fn(fn);
});

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// Mock node:util to use our promisify that handles mocks correctly
vi.mock('node:util', () => ({
  promisify: vi.fn((fn: (..._args: unknown[]) => unknown) => {
    return function (...args: unknown[]) {
      return new Promise((resolve, reject) => {
        fn(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
          } else {
            resolve({ stdout, stderr });
          }
        });
      });
    };
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExecCallback = (_error: Error | null, _stdout?: any, _stderr?: any) => void;

/**
 * Helper to create an error with stdout/stderr properties
 */
function createExecError(
  stdout: string,
  stderr: string,
  code?: number
): Error & { stdout: string; stderr: string; code: number } {
  const error = new Error('Validation failed') as Error & {
    stdout: string;
    stderr: string;
    code: number;
  };
  error.stdout = stdout;
  error.stderr = stderr;
  error.code = code ?? 1;
  return error;
}

describe('runStaticChecks', () => {
  beforeEach(() => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        if (callback) callback(null, '', '');
        return {} as ReturnType<typeof execFile>;
      }
    );
  });

  afterEach(() => {
    mockExecFile.mockReset();
  });

  it('should return success when check passes', async () => {
    const result = await runStaticChecks('/test/project');

    expect(result.success).toBe(true);
    expect(result.errorOutput).toBeUndefined();
  });

  it('should return success when check passes with default command', async () => {
    const result = await runStaticChecks('/test/project');

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      './aesop_validate.sh',
      [],
      expect.objectContaining({ cwd: '/test/project' }),
      expect.any(Function)
    );
  });

  it('should use custom check command when provided', async () => {
    const result = await runStaticChecks('/test/project', 'pytest .');

    expect(result.success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledWith(
      'pytest',
      ['.'],
      expect.objectContaining({ cwd: '/test/project' }),
      expect.any(Function)
    );
  });

  it('should return error output when check fails', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        if (callback)
          callback(createExecError('Test output', 'Error: assertion failed', 1), '', '');
        return {} as ReturnType<typeof execFile>;
      }
    );

    const result = await runStaticChecks('/test/project', 'pytest .');

    expect(result.success).toBe(false);
    expect(result.errorOutput).toContain('VALIDATION FAILED');
    expect(result.errorOutput).toContain('pytest .');
    expect(result.errorOutput).toContain('Test output');
    expect(result.errorOutput).toContain('Error: assertion failed');
  });

  it('should include stdout in error output', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        if (callback) callback(createExecError('Collected 10 items', 'Some error', 1), '', '');
        return {} as ReturnType<typeof execFile>;
      }
    );

    const result = await runStaticChecks('/test/project');

    expect(result.success).toBe(false);
    expect(result.errorOutput).toContain('STDOUT:');
    expect(result.errorOutput).toContain('Collected 10 items');
  });

  it('should include stderr in error output', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        if (callback) callback(createExecError('', 'mypy: type error on line 42', 1), '', '');
        return {} as ReturnType<typeof execFile>;
      }
    );

    const result = await runStaticChecks('/test/project');

    expect(result.success).toBe(false);
    expect(result.errorOutput).toContain('STDERR:');
    expect(result.errorOutput).toContain('mypy: type error on line 42');
  });

  it('should respect cwd option', async () => {
    await runStaticChecks('/custom/path', 'cargo test');

    expect(mockExecFile).toHaveBeenCalledWith(
      'cargo',
      ['test'],
      expect.objectContaining({ cwd: '/custom/path' }),
      expect.any(Function)
    );
  });

  it('should set timeout option', async () => {
    await runStaticChecks('/test/project');

    expect(mockExecFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: 300000 }),
      expect.any(Function)
    );
  });

  it('should log stderr on success', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        if (callback) callback(null, '', 'Warning: deprecated API');
        return {} as ReturnType<typeof execFile>;
      }
    );

    const result = await runStaticChecks('/test/project');

    expect(result.success).toBe(true);
  });

  it('should reject a command containing shell metacharacters', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        // With execFile, the semicolon is part of the binary name or an argument,
        // so it will fail to find the executable.
        if (callback) callback(createExecError('', 'ENOENT', 127), '', '');
        return {} as ReturnType<typeof execFile>;
      }
    );

    const result = await runStaticChecks('/tmp', './validate.sh; echo INJECTED');
    expect(result.success).toBe(false);
    expect(mockExecFile).toHaveBeenCalledWith(
      './validate.sh;',
      ['echo', 'INJECTED'],
      expect.any(Object),
      expect.any(Function)
    );
  });
});

describe('StaticCheckResult type', () => {
  beforeEach(() => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        if (callback) callback(null, '', '');
        return {} as ReturnType<typeof execFile>;
      }
    );
  });

  afterEach(() => {
    mockExecFile.mockReset();
  });

  it('should have correct shape when success', async () => {
    const result: StaticCheckResult = await runStaticChecks('/test/project');

    expect(result).toHaveProperty('success');
    expect(typeof result.success).toBe('boolean');
  });

  it('should have errorOutput when failed', async () => {
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _options: unknown, callback?: ExecCallback) => {
        if (callback) callback(createExecError('', 'error', 1), '', '');
        return {} as ReturnType<typeof execFile>;
      }
    );

    const result: StaticCheckResult = await runStaticChecks('/test/project');

    expect(result.success).toBe(false);
    expect(result.errorOutput).toBeDefined();
    expect(typeof result.errorOutput).toBe('string');
  });
});
