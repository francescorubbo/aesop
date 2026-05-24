import eslintConfigPrettier from 'eslint-config-prettier';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const eslintConfig = [
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', '*.config.mjs'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-console': 'warn',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // CLI application files - console output IS the user interface
  {
    files: ['src/cli.ts', 'src/backpressureGates.ts', 'src/discoveryEngine.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // validateContract.ts exports an enum for public API use - enum values are consumed by tests
  {
    files: ['src/validateContract.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },
  // Prettier must be last to disable conflicting rules
  eslintConfigPrettier,
];

export default eslintConfig;
