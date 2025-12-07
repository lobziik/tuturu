// ESLint Flat Config for ESLint v9+
// Type-aware rules for TypeScript in Bun/browser environment

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

export default [
  // Ignore patterns (replaces .eslintignore)
  {
    ignores: ['**/node_modules/**', 'public/**', 'dist/**', '*.log', 'bun.lock'],
  },

  // Base TypeScript config for all TS files
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // Enable type-aware rules
        project: './tsconfig.json',
        tsconfigRootDir: process.cwd(),
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      // Compat with TS
      'no-undef': 'off',
      'no-console': 'off',

      // Prefer type-only imports for clarity and bundling
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      // Disallow explicit any per project guidelines
      '@typescript-eslint/no-explicit-any': 'error',

      // Unused imports/vars
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Type-aware suggestions
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },

  // Browser globals for client
  {
    files: ['src/client.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Node globals for server and config
  {
    files: ['src/server.ts', 'src/config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
