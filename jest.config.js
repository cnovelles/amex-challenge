// Jest, on top of American Express's own base preset (amex-jest-preset), the
// one One App modules use. We override a few of its defaults:
// - TypeScript/TSX through SWC, since the build is esbuild and there's no Babel.
// - Coverage only for the library, with thresholds a little under 100%
//   (the preset's default) because the browser-only fallback is covered by
//   the Playwright tests, not Jest.
// - Coverage goes to coverage/, because Playwright owns test-results/.
// Tests that need a DOM opt in per file with `@jest-environment jest-fixed-jsdom`
// (jsdom with Node's fetch, Response and streams, so MSW works). We don't use
// amex-jest-preset-react because its setup swaps fetch for the whatwg-fetch
// polyfill, which MSW and our fetch mocks don't need.

/** @type {import('jest').Config} */
const base = {
  preset: 'amex-jest-preset',
  transform: {
    '^.+\\.(t|j)sx?$|^.+\\.mjs$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          transform: { react: { runtime: 'classic' } },
        },
      },
    ],
  },
  // MSW 2 and tinybench ship ESM only; compile those to CommonJS too.
  transformIgnorePatterns: [
    '/node_modules/(?!(rettime|until-async|@open-draft/deferred-promise|tinybench)/)',
  ],
  restoreMocks: true,
  testResultsProcessor: undefined,
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',
};

module.exports = process.env.BENCH
  ? {
      ...base,
      // Report-only benchmarks, kept out of `npm test`. Run with `npm run bench`.
      testMatch: ['<rootDir>/tests/bench/**/*.bench.test.tsx'],
      collectCoverage: false,
    }
  : {
      ...base,
      testMatch: [
        '<rootDir>/tests/unit/**/*.test.{ts,tsx}',
        '<rootDir>/tests/integration/**/*.test.{ts,tsx}',
      ],
      collectCoverage: false,
      collectCoverageFrom: ['caching-fetch-library/**/*.ts'],
      coverageDirectory: '<rootDir>/coverage',
      coverageReporters: ['text', 'lcov'],
      coverageThreshold: {
        global: { lines: 95, functions: 95, branches: 85, statements: 95 },
      },
    };
