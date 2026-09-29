// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/release/**', '**/coverage/**', '**/node_modules/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // Node.js packages (gateway, cli, desktop main process) and config files
  {
    files: [
      'packages/gateway/**/*.{ts,mjs}',
      'packages/cli/**/*.ts',
      'packages/sdk/**/*.ts',
      'apps/desktop/**/*.{ts,mjs}',
      '*.js',
      'packages/*/*.ts',
      'apps/*/*.ts',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // The desktop preload runs in a renderer with contextIsolation, so it sees browser globals too.
  {
    files: ['apps/desktop/src/main/preload.ts', 'apps/desktop/src/shell/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // React dashboard
  {
    files: ['packages/dashboard/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Tests inspect untyped JSON payloads and mock internals; don't demand full type safety there.
  {
    files: ['packages/*/test/**/*.ts', 'packages/*/src/**/*.test.{ts,tsx}', 'apps/*/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  // Plain JS config files don't need type-aware rules
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Must be last: turns off stylistic rules that conflict with Prettier
  prettier,
);
