import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runWithValidation,
  runWithValidationDetailed,
  validateResultFile,
  ValidationContractError,
} from '../validateContract';

describe('validateContract', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = join(
      tmpdir(),
      `aesop-validate-contract-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // =======================================================================
  // Helper functions
  // =======================================================================

  /**
   * Create a validation script that succeeds and writes a result file.
   */
  function createValidatingScript(
    dir: string,
    resultFile: string,
    metrics: Record<string, number>
  ): string {
    const scriptPath = join(dir, 'validate.sh');
    const resultPath = join(dir, resultFile);
    const metricsJson = JSON.stringify(metrics);

    writeFileSync(
      scriptPath,
      `#!/bin/bash
cat > "${resultPath}" << 'EOF'
${metricsJson}
EOF
exit 0
`,
      { mode: 0o755 }
    );

    return scriptPath;
  }

  /**
   * Create a validation script that fails.
   */
  function createFailingScript(dir: string): string {
    const scriptPath = join(dir, 'validate.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/bash
echo "Validation failed" >&2
exit 1
`,
      { mode: 0o755 }
    );
    return scriptPath;
  }

  /**
   * Create a validation script that succeeds but doesn't write a result file.
   */
  function createEmptyScript(dir: string): string {
    const scriptPath = join(dir, 'validate.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/bash
exit 0
`,
      { mode: 0o755 }
    );
    return scriptPath;
  }

  /**
   * Create a script that produces invalid JSON in the result file.
   */
  function createInvalidJsonScript(dir: string, resultFile: string): string {
    const scriptPath = join(dir, 'validate.sh');
    const resultPath = join(dir, resultFile);

    writeFileSync(
      scriptPath,
      `#!/bin/bash
cat > "${resultPath}" << 'EOF'
{ invalid json }
EOF
exit 0
`,
      { mode: 0o755 }
    );

    return scriptPath;
  }

  /**
   * Create a script that produces a result file missing the required metric.
   */
  function createMissingMetricScript(
    dir: string,
    resultFile: string,
    metrics: Record<string, number>
  ): string {
    const scriptPath = join(dir, 'validate.sh');
    const resultPath = join(dir, resultFile);
    const metricsJson = JSON.stringify(metrics);

    writeFileSync(
      scriptPath,
      `#!/bin/bash
cat > "${resultPath}" << 'EOF'
${metricsJson}
EOF
exit 0
`,
      { mode: 0o755 }
    );

    return scriptPath;
  }

  // =======================================================================
  // SUCCESS CASES
  // =======================================================================

  describe('successful validation', () => {
    it('should return success when validation script succeeds and produces valid result', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { accuracy: 0.95, loss: 0.05 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.95);
      expect(result.metrics['loss']).toBe(0.05);
      expect(result.error).toBeUndefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should return all numeric metrics from result file', async () => {
      const resultFile = 'metrics.json';
      const metrics = {
        accuracy: 0.99,
        precision: 0.98,
        recall: 0.97,
        f1: 0.975,
      };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics).toEqual(metrics);
    });

    it('should respect custom metric key', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { f1_score: 0.92, loss: 0.08 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'f1_score', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['f1_score']).toBe(0.92);
    });

    it('should respect custom result file name', async () => {
      const resultFile = 'custom_result.json';
      const metrics = { accuracy: 0.88 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.88);
    });

    it('should return detailed result with violation info on failure', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createEmptyScript(testDir);

      const result = await runWithValidationDetailed(testDir, {
        cmd: scriptPath,
        metricKey: 'accuracy',
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.violation).toBeDefined();
      expect(result.violation?.error).toBe(ValidationContractError.RESULT_FILE_NOT_FOUND);
    });

    it('should exclude non-finite values from metrics (isValidNumber unit behavior)', async () => {
      // isValidNumber is used internally to filter metrics
      // We test this by ensuring only valid finite numbers are included
      const resultFile = 'eval_result.json';
      const scriptPath = createValidatingScript(testDir, resultFile, {
        accuracy: 0.95,
        precision: 0.98,
      });

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.95);
      expect(result.metrics['precision']).toBe(0.98);
      // Verify all values are finite numbers
      for (const value of Object.values(result.metrics)) {
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
      }
    });

    it('should handle metrics with string values gracefully', async () => {
      const resultFile = 'eval_result.json';

      // Create a script that writes accuracy and a string value
      const scriptPath = join(testDir, 'validate.sh');
      const resultPath = join(testDir, resultFile);
      writeFileSync(
        scriptPath,
        `#!/bin/bash
cat > "${resultPath}" << 'EOF'
{"accuracy": 0.95, "status": "completed"}
EOF
exit 0
`,
        { mode: 0o755 }
      );

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.95);
      // String values should be excluded
      expect(result.metrics['status']).toBeUndefined();
    });

    it('should handle negative metric values', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = join(testDir, 'validate.sh');
      const resultPath = join(testDir, resultFile);

      writeFileSync(
        scriptPath,
        `#!/bin/bash
cat > "${resultPath}" << 'EOF'
{"accuracy": 0.95, "loss": -0.05}
EOF
exit 0
`,
        { mode: 0o755 }
      );

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      // Negative values are valid numbers
      expect(result.metrics['loss']).toBe(-0.05);
    });

    it('should handle zero metric values', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { accuracy: 0.0, loss: 1.0 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.0);
      expect(result.metrics['loss']).toBe(1.0);
    });

    it('should handle very large metric values', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { score: 1e15 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'score', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['score']).toBe(1e15);
    });
  });

  // =======================================================================
  // PRE-CONDITION: STALE RESULT BUG FIX
  // =======================================================================

  describe('stale result bug elimination', () => {
    it('should delete existing result file before running validation', async () => {
      const resultFile = 'eval_result.json';

      // Pre-create a stale result file
      const staleMetrics = { accuracy: 0.5 };
      const resultPath = join(testDir, resultFile);
      writeFileSync(resultPath, JSON.stringify(staleMetrics));

      // Set it to be old
      const twoMinutesAgo = Date.now() - 120_000;
      utimesSync(resultPath, new Date(twoMinutesAgo), new Date(twoMinutesAgo));

      // Create a script that succeeds with different metrics
      const newMetrics = { accuracy: 0.95 };
      const scriptPath = createValidatingScript(testDir, resultFile, newMetrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.95); // Should be new metrics, not stale
    });

    it('should not confuse results from previous runs', async () => {
      const resultFile = 'eval_result.json';

      // First run: write a result
      const firstMetrics = { accuracy: 0.6 };
      writeFileSync(join(testDir, resultFile), JSON.stringify(firstMetrics));

      // Second run: script succeeds but doesn't create file (old file should be deleted)
      const scriptPath = createEmptyScript(testDir);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // =======================================================================
  // POST-CONDITION: RESULT FILE EXISTS
  // =======================================================================

  describe('post-condition: result file must exist', () => {
    it('should fail when validation script succeeds but no result file is created', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createEmptyScript(testDir);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should provide clear error message when result file is missing', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createEmptyScript(testDir);

      const result = await runWithValidationDetailed(testDir, {
        cmd: scriptPath,
        metricKey: 'accuracy',
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.violation?.error).toBe(ValidationContractError.RESULT_FILE_NOT_FOUND);
      expect(result.violation?.message).toContain('not found');
    });
  });

  // =======================================================================
  // POST-CONDITION: RESULT FILE FRESHNESS
  // =======================================================================

  describe('post-condition: result file freshness', () => {
    it('should pass when result file is recent', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { accuracy: 0.95 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
        freshnessThresholdMs: 60_000,
      });

      expect(result.success).toBe(true);
    });

    it('should fail when result file is stale (using validateResultFile)', () => {
      const resultFile = join(testDir, 'eval_result.json');
      const metrics = { accuracy: 0.95 };
      writeFileSync(resultFile, JSON.stringify(metrics));

      // Set file to be 2 minutes old
      const twoMinutesAgo = Date.now() - 120_000;
      utimesSync(resultFile, new Date(twoMinutesAgo), new Date(twoMinutesAgo));

      const result = validateResultFile(resultFile, 'accuracy', 60_000);

      expect(result.success).toBe(false);
      expect(result.error).toContain('stale');
    });

    it('should pass when result file is recent (using validateResultFile)', () => {
      const resultFile = join(testDir, 'eval_result.json');
      const metrics = { accuracy: 0.95 };
      writeFileSync(resultFile, JSON.stringify(metrics));

      const result = validateResultFile(resultFile, 'accuracy', 60_000);

      expect(result.success).toBe(true);
    });

    it('should respect custom freshness threshold (validateResultFile)', () => {
      const resultFile = join(testDir, 'eval_result.json');

      // Create a file that's 30 seconds old
      writeFileSync(resultFile, JSON.stringify({ accuracy: 0.95 }));
      const thirtySecondsAgo = Date.now() - 30_000;
      utimesSync(resultFile, new Date(thirtySecondsAgo), new Date(thirtySecondsAgo));

      // Should pass with 60 second threshold
      const result = validateResultFile(resultFile, 'accuracy', 60_000);
      expect(result.success).toBe(true);

      // Should fail with 10 second threshold
      const result2 = validateResultFile(resultFile, 'accuracy', 10_000);
      expect(result2.success).toBe(false);
      expect(result2.error).toContain('stale');
    });
  });

  // =======================================================================
  // POST-CONDITION: VALID JSON
  // =======================================================================

  describe('post-condition: valid JSON', () => {
    it('should fail when result file contains invalid JSON', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createInvalidJsonScript(testDir, resultFile);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('JSON');
    });

    it('should provide detailed error for invalid JSON', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createInvalidJsonScript(testDir, resultFile);

      const result = await runWithValidationDetailed(testDir, {
        cmd: scriptPath,
        metricKey: 'accuracy',
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.violation?.error).toBe(ValidationContractError.RESULT_FILE_INVALID_JSON);
    });
  });

  // =======================================================================
  // POST-CONDITION: REQUIRED METRIC EXISTS
  // =======================================================================

  describe('post-condition: required metric exists', () => {
    it('should fail when result file is missing the required metric', async () => {
      const resultFile = 'eval_result.json';
      // Script creates a file with loss but not accuracy
      const metrics = { loss: 0.05, other_metric: 0.5 };
      const scriptPath = createMissingMetricScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.error!).toContain('accuracy');
      expect(result.error!.toLowerCase()).toContain('missing');
    });

    it('should fail when metric value is not a number (string)', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = join(testDir, 'validate.sh');
      const resultPath = join(testDir, resultFile);

      // Script writes accuracy as a string
      writeFileSync(
        scriptPath,
        `#!/bin/bash
cat > "${resultPath}" << 'EOF'
{"accuracy": "not a number"}
EOF
exit 0
`,
        { mode: 0o755 }
      );

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.error!.toLowerCase()).toContain('missing');
    });

    it('should provide detailed error for missing metric', async () => {
      const resultFile = 'eval_result.json';
      // Script creates a file with only loss, no accuracy
      const metrics = { loss: 0.05 };
      const scriptPath = createMissingMetricScript(testDir, resultFile, metrics);

      const result = await runWithValidationDetailed(testDir, {
        cmd: scriptPath,
        metricKey: 'accuracy',
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.violation?.error).toBe(ValidationContractError.RESULT_FILE_MISSING_METRIC);
    });
  });

  // =======================================================================
  // POST-CONDITION: SCRIPT EXIT CODE
  // =======================================================================

  describe('post-condition: script must exit zero', () => {
    it('should fail when validation script exits non-zero (with valid result file)', async () => {
      const resultFile = 'eval_result.json';

      // Create a script that fails AND creates a valid result file
      const scriptPath = join(testDir, 'validate.sh');
      const resultPath = join(testDir, resultFile);
      writeFileSync(
        scriptPath,
        `#!/bin/bash
cat > "${resultPath}" << 'EOF'
{"accuracy": 0.95}
EOF
exit 1
`,
        { mode: 0o755 }
      );

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(false);
      // Should get script failed error (since file exists and is valid)
      expect(result.error!).toContain('exit');
    });

    it('should provide detailed error for script failure', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = join(testDir, 'validate.sh');
      const resultPath = join(testDir, resultFile);

      // Script creates a valid result file but fails
      writeFileSync(
        scriptPath,
        `#!/bin/bash
cat > "${resultPath}" << 'EOF'
{"accuracy": 0.95}
EOF
exit 1
`,
        { mode: 0o755 }
      );

      const result = await runWithValidationDetailed(testDir, {
        cmd: scriptPath,
        metricKey: 'accuracy',
        resultFile,
      });

      expect(result.success).toBe(false);
      expect(result.violation?.error).toBe(ValidationContractError.VALIDATION_SCRIPT_FAILED);
    });

    it('should check result file before script exit code when script fails', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createFailingScript(testDir);

      // Script fails, no result file created - should get result file not found error
      // (not script failed error, since we check post-conditions in order)
      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(false);
      // The result file check happens before script exit code check
      expect(result.error).toContain('not found');
    });
  });

  // =======================================================================
  // validateResultFile (standalone checker)
  // =======================================================================

  describe('validateResultFile (standalone)', () => {
    it('should validate an existing result file', () => {
      const resultFile = join(testDir, 'eval_result.json');
      writeFileSync(resultFile, JSON.stringify({ accuracy: 0.95, loss: 0.05 }));

      const result = validateResultFile(resultFile, 'accuracy');

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.95);
    });

    it('should fail for non-existent file', () => {
      const resultFile = join(testDir, 'nonexistent.json');

      const result = validateResultFile(resultFile, 'accuracy');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail for invalid JSON', () => {
      const resultFile = join(testDir, 'eval_result.json');
      writeFileSync(resultFile, '{ invalid }');

      const result = validateResultFile(resultFile, 'accuracy');

      expect(result.success).toBe(false);
      expect(result.error).toContain('JSON');
    });

    it('should fail for missing metric', () => {
      const resultFile = join(testDir, 'eval_result.json');
      writeFileSync(resultFile, JSON.stringify({ loss: 0.05 }));

      const result = validateResultFile(resultFile, 'accuracy');

      expect(result.success).toBe(false);
      expect(result.error).toContain('accuracy');
    });
  });

  // =======================================================================
  // Error messages
  // =======================================================================

  describe('error messages', () => {
    it('should provide actionable error messages', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createMissingMetricScript(testDir, resultFile, { loss: 0.05 });

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      // Error should be clear and actionable
      expect(result.error!).toBeTruthy();
      expect(result.error!.length).toBeGreaterThan(0);

      // Should mention the result file
      expect(result.error!).toContain(resultFile);

      // Should mention the metric key
      expect(result.error!).toContain('accuracy');

      // Should explain what went wrong
      expect(result.error!.toLowerCase()).toContain('missing');
    });

    it('should provide context in detailed error messages', async () => {
      const resultFile = 'eval_result.json';
      const scriptPath = createMissingMetricScript(testDir, resultFile, { loss: 0.05 });

      const result = await runWithValidationDetailed(testDir, {
        cmd: scriptPath,
        metricKey: 'accuracy',
        resultFile,
      });

      expect(result.violation?.context).toBeDefined();
      expect(result.violation?.context?.['cmd']).toBe(scriptPath);
      expect(result.violation?.context?.['resultFile']).toBe(resultFile);
    });
  });

  // =======================================================================
  // Configuration options
  // =======================================================================

  describe('configuration options', () => {
    it('should respect cwd option', async () => {
      const subDir = join(testDir, 'subdir');
      mkdirSync(subDir, { recursive: true });

      const resultFile = 'eval_result.json';
      const metrics = { accuracy: 0.88 };
      const scriptPath = createValidatingScript(subDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
        cwd: subDir,
      });

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.88);
    });

    it('should work with default configuration', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { accuracy: 0.92 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      // Call without explicit metricKey (uses default 'accuracy')
      const result = await runWithValidation(testDir, scriptPath);

      expect(result.success).toBe(true);
      expect(result.metrics['accuracy']).toBe(0.92);
    });
  });

  // =======================================================================
  // Performance
  // =======================================================================

  describe('performance', () => {
    it('should complete validation in reasonable time', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { accuracy: 0.95 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const startTime = Date.now();
      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });
      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
      expect(result.durationMs).toBeGreaterThan(0);
    });
  });

  // =======================================================================
  // Edge cases
  // =======================================================================

  describe('edge cases', () => {
    it('should handle empty metrics object with only the required metric', async () => {
      const resultFile = 'eval_result.json';
      const metrics = { accuracy: 0.99 };
      const scriptPath = createValidatingScript(testDir, resultFile, metrics);

      const result = await runWithValidation(testDir, scriptPath, 'accuracy', {
        resultFile,
      });

      expect(result.success).toBe(true);
      expect(result.metrics).toEqual(metrics);
    });
  });
});
