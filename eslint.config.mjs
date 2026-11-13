import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'mockServer/**',
      'framework/mock-server/mockServiceWorker.js',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Jest reads its config as CommonJS
    files: ['jest.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    // framework code was handed to us as-is; don't fail CI on its unused handler args
    files: ['framework/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-unused-vars': 'warn' },
  },
);
