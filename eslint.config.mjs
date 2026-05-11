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
  eslintConfigPrettier,
];

export default eslintConfig;
