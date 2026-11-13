# People Directory + caching fetch library

A small SSR React app (Fastify + React 18 + MSW) and the caching fetch library it uses. The library lives in `caching-fetch-library/cachingFetch.ts` and lets the app fetch once, render on the server, and hand the data to the browser without fetching again.

## Getting started

Needs Node 20.16+ (22 is pinned in `.nvmrc`).

```bash
nvm use        # optional, picks up .nvmrc
npm ci
npm start      # builds and serves on http://localhost:3000
```

- http://localhost:3000/appWithoutSSRData fetches in the browser (1 request to the people API)
- http://localhost:3000/appWithSSRData renders on the server and hydrates from the cache (0 requests, works with JS off)

MSW mocks the people API in both Node and the browser, so no network is needed. Heads up: the MSW service worker stays registered for `localhost:3000` after you're done (DevTools → Application → Service Workers to remove it).

## Scripts

| Script                            | What it does                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| `npm start`                       | Build and run the server                                                  |
| `npm run build`                   | esbuild bundles for server and client into `dist/`                        |
| `npm run typecheck`               | `tsc --noEmit` (esbuild strips types, it doesn't check them)              |
| `npm run lint`                    | ESLint                                                                    |
| `npm run format` / `format:check` | Prettier                                                                  |
| `npm test`                        | Unit + integration tests (Jest)                                           |
| `npm run test:coverage`           | Same, with coverage thresholds on the library                             |
| `npm run test:e2e`                | Playwright end-to-end, HTTP and performance tests against the real server |
| `npm run test:visual`             | Playwright screenshot tests                                               |
| `npm run bench`                   | Report-only benchmark of the server render                                |
| `npm run ci`                      | Everything CI runs except Playwright                                      |

First time running Playwright: `npx playwright install chromium`.

## Task 1: what I set up and why

- **`.gitignore`, committed lockfile, `npm ci`**: reproducible installs, and no `node_modules`, `dist` or IDE folders in git. The repo came with someone's `.idea/` folder; I left that out.
- **Node pin** (`.nvmrc` + `engines`): the per-request cache needs `process.getBuiltinModule` (Node 20.16+), and CI and local should run the same version.
- **`package.json` cleanup**: `private: true` so it can't get published by accident, removed `main` (pointed at a file that doesn't exist), and the build no longer shells out to `rm`/`cp`, so it works on Windows too.
- **MSW worker fix**: `msw.workerDirectory` pointed at a `mockServer/` folder that didn't exist. Every install wrote a stray copy there while the app served an old 2.3.1 worker against msw 2.15. It now points at `framework/mock-server`, and I regenerated the worker so they match.
- **Type checking**: esbuild doesn't type-check, so `tsc --noEmit` is its own step. `no-explicit-any` is an error in lint.
- **ESLint 9 (flat config) + Prettier**: typescript-eslint and the React hooks rules. Prettier matches the existing style (single quotes, trailing commas), so formatting didn't churn the original files.
- **Testing stack**: Jest, on top of `amex-jest-preset`, the base preset American Express publishes for One App modules, so a One App developer finds the setup they expect. SWC compiles the TypeScript because the build uses esbuild, not Babel. Tests that need a DOM opt in per file with `jest-fixed-jsdom`, which is jsdom with Node's own `fetch` and `Response`, so MSW works. I left out `amex-jest-preset-react` because its setup replaces `fetch` with the `whatwg-fetch` polyfill, which MSW doesn't need. I started on Vitest and switched; the test code barely changed (`vi.` to `jest.`, plus Testing Library's `waitFor`). Testing Library because it tests what the user sees. Playwright because "1 request in the network tab" and "works with JS disabled" can only really be proven in a real browser. MSW reuses the app's own mock handler, so tests and the app see the same data.
- **CI** (GitHub Actions): lint, format check, typecheck, tests with coverage thresholds, build, `npm audit` on prod deps, and Playwright in a separate job that uploads the report on failure. Least-privilege `permissions` and cancel-in-progress for repeat pushes.
- **Dependabot**: weekly npm and Actions updates, with minor/patch dev deps grouped so it doesn't spam PRs.
- **Dependency upgrades** (done on purpose, not with `npm audit fix --force`):
  - esbuild 0.21 → 0.28: the old version had a dev server advisory.
  - Fastify 4 → 5: Fastify 4 had several high severity advisories. The server only uses basic APIs, so nothing in the framework had to change. Verified with the e2e suite.
  - `@types/node` 20 → 22 to match the pinned Node.
