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

## Task 2: how the caching fetch works

The surface API is unchanged. Under the hood:

**Cache.** A `Map` of URL to an entry that is `pending` (holds the in-flight promise), `success` (holds the data) or `error` (holds the error). Entries get replaced, never mutated, so each entry object is a stable snapshot for React.

**Dedupe.** The pending entry, promise included, goes into the map synchronously before anything awaits. Anyone else asking for that URL in the same tick gets the same promise. That's what keeps `/appWithoutSSRData` at 1 request even though App, every Person and every Name call the hook, and it also holds under StrictMode where effects run twice.

**The hook.** `useCachingFetch` reads the cache during render with `useSyncExternalStore` and only starts a fetch inside `useEffect`. That split matters:

- On the server there are no effects, so the server renders whatever is in the cache. If it was preloaded you get the full list; if not you get "Loading..." and nothing gets fetched.
- The server snapshot is the same cache read, with one difference: an `error` entry shows as "not started". So when the server preload fails, the server renders "Loading..." and the browser (which never gets errors, see below) hydrates the same "Loading...". No hydration mismatch, and the effect then tries the request again in the browser. React 18 does the same thing when a Suspense boundary fails on the server: it sends the fallback and retries on the client.
- When a request settles, subscribers for that URL get notified and re-render. They unsubscribe on unmount.

**Preload.** `preloadCachingFetch` awaits the shared fetch and never throws, so a failed API never turns into a 500. The server tries once and doesn't retry: a person is waiting on that response, and every server retry adds a full timeout before they see anything. It also adds load to an API that's already struggling, from every user at once. Failing fast and letting the browser try again is the better trade.

**Timeout.** Every request gets 3 seconds (`AbortController` + `setTimeout`, cleared when the request settles). Without it, a hung API hangs the SSR response with it. It's one constant because the surface API has no options. I used `setTimeout` instead of `AbortSignal.timeout` so fake timers can test it without waiting 3 real seconds.

**Tradeoff:** with JavaScript off and the API down, the page shows "Loading..." instead of an error. The acceptance criteria only need JS-off to work when the API works, and for everyone with JS on this gives a working page instead of an error.

**Serialize / initialize.** Only successful entries get sent to the browser, so errors and in-flight requests are retried there instead of being frozen in. The framework injects the string as `window.__INITIAL_DATA__ = '...'` with no escaping, so a `'`, a `\` or a `</script>` in the data would break the page or open an XSS hole. I run the JSON through `encodeURIComponent` and also encode `'`. The output only has characters that are safe inside a single-quoted JS string inside a script tag, and `initializeCache(serializeCache())` round-trips without the browser in the middle. Bad input to `initializeCache` is logged and ignored, and the hook just fetches.

**Per-request server cache.** This one came up from testing, not from the instructions. The server handles requests concurrently and calls `wipeCache()` at the top of each one. With a single module-level cache, request B's wipe emptied the cache while request A was still preloading, so A rendered "Loading..." with an empty `__INITIAL_DATA__`. The parallel Playwright tests caught it as an intermittent failure. Now `wipeCache()` creates a fresh `Map` and scopes it to the current request with `AsyncLocalStorage.enterWith`. That works because the framework calls `wipeCache()` synchronously at the start of the handler, so preload, render and serialize all run inside that request's context. `async_hooks` is loaded through `process.getBuiltinModule`, so esbuild never pulls it into the browser bundle, and the browser just uses one shared `Map` (one page, one user). I'd rather the framework did this explicitly (see known issues), but this fixes it without touching files outside the library.

## Testing

All tests live in `tests/`. I tried to cover each acceptance criterion at more than one level.

- **Unit** (`tests/unit`, Jest + jsdom, mocked `fetch`): 150 concurrent preloads make 1 fetch, error handling for non-2xx / network / bad JSON, the 3 second timeout (fake timers) and that the timer gets cleared, the server render showing Loading for a failed request, serialize leaves out errors and pending, round trip, a nasty payload (`O'Brien`, backslashes, `</script>`, emoji, U+2028) pushed through the real `buildHtmlDoc` and run in a `node:vm` sandbox like a browser would, garbage input, and wipe races.
- **Integration** (`tests/integration`, Jest + jsdom + Testing Library + MSW using the app's real handler): the real `App` makes 1 request on the client (also under StrictMode), the framework's `renderApp` renders Loading or the full list, SSR then `hydrateRoot` with 0 requests and no hydration errors, a failed server preload that hydrates with no errors and then loads the list in the browser, a hung API that still renders after 3 seconds, error states, and 10 overlapping simulated requests each keeping their own cache.
- **End-to-end** (`tests/e2e`, Playwright + Chromium against `npm start`): exactly 1 people API request on `/appWithoutSSRData`, 0 on `/appWithSSRData`, the list with JS disabled, no console or hydration errors, `__INITIAL_DATA__` cleaned up, raw HTML and injected cache shape, 20 concurrent requests to the real server, landing page links, asset content types.
- **Visual** (`tests/visual`): screenshot baselines for the landing page and the directory. The client-rendered page has to match the server HTML baseline pixel for pixel.
- **Performance** (`tests/e2e/performance.spec.ts` + `npm run bench`): loose budgets for SSR response time and time to list, a check that the list is in the server HTML even with `client.js` blocked, and a tinybench report (on my machine: full SSR render ~6.4ms, serialize/initialize ~0.12ms).

I also sanity-checked the tests by breaking the library on purpose (no escaping, no dedupe, no per-request cache) and making sure the right tests failed. Library coverage is ~99% statements and 100% lines. The one uncovered branch is the browser fallback, which the e2e tests hit in a real browser.

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

## Known issues

This repo stands in for a real One App feature, so I split the open issues by who would actually fix them. In real life the `framework/` folder is the One App platform, `application/` is a Holocron module owned by a feature team, and the people API belongs to another team. A feature team fixes what it owns and raises the rest with the owner; it doesn't rewrite the platform.

### Only because it's a take-home

Not real issues, just the stand-in setup. I wouldn't "fix" these, they go away in a real environment.

- MSW is the API, and it's always on and bundled into `client.js`. The browser also waits for the service worker before it hydrates. In a real setup, mocks come from the team's mocking standard and never ship. (AmEx's own Parrot mock tool was archived in 2025, so MSW is a fair pick here.)
- The API URL is a hardcoded randomapi.com link. Real config comes from the environment and points at a gateway.
- `framework/server` is a small Fastify server, not One App. So things like `listen({ port: 3000 })` binding to localhost only, `readFileSync('./dist/...')` relative to the working directory, and `runServer()` not handling startup failures are stand-in problems.
- CI is GitHub Actions with Dependabot because the repo is on GitHub. On a team I'd use the org's pipeline templates and security scanning.
- I picked the Node version (`.nvmrc`) and upgraded Fastify 4 to 5 myself, because Fastify 4 had high severity advisories. On a real team the platform decides both, and I'd raise the advisory with them instead of upgrading their server in a feature PR.

### Our team would change

Things a feature team owns, roughly in priority order.

- **Use fetchye instead of this cache.** AmEx already owns and maintains it, it has One App integration, and its per-request provider fixes the shared server cache issue below. So there's no build vs buy question here: a second cache would just be one more thing for a team to own. If a feature needed something fetchye doesn't do, I'd first check the need is real, then use fetchye's extension points in the app (a custom fetcher, which is where this repo's timeout would live, `mapKeyToCacheKey`/`mapOptionsToKey`, or a wrapper hook). I'd only propose a change to fetchye itself if several teams needed it, and leave that call to its owners.
- **Loading, error and empty states.** Right now they're plain text: `Loading...` and `Error: <message>`, and the message includes the API URL. I'd want a skeleton or spinner with `role="status"`, a friendly message in an `alert` region with a "Try again" button (detail goes to the logs), and an error boundary around the module.
- **Accessibility in the module.** People are plain `div`s. A `<ul>`/`<li>` list inside `<main>` lets screen readers announce the count and move through it.
- **Pagination on our side.** The API returns all 75 people and the app renders every one. That's an unbounded list: response size, SSR time, the serialized cache in the HTML and DOM size all grow with the data. Until the API supports it (see below), I'd render in pages in the module so the DOM stays small, and add list virtualization for very long pages. The library already handles real pagination, since each page URL (`?cursor=...&limit=25`) is its own cache entry with dedupe, preload and serialization.
- **Map and validate the data once.** `validateData` runs on every render in ~151 components. Validating once when data lands in the cache would be cheaper (the benchmark is there to measure it). The same mapping layer is where display formatting goes until the API sends raw values. `key={person.email}` assumes emails are unique, and `data[index]` assumes the index exists.
- **Browser retry.** A failed browser request stays an error until a reload. I'd add 1 or 2 retries with exponential backoff and full jitter, only for timeouts, network errors, 5xx and 429, never for other 4xx. Jitter matters because when the API goes down every client fails at the same moment, and without it they all retry at the same moment too. I didn't add it yet because dedupe already keeps it to one request per page, and the server-failure case already gets a browser retry.
- **Cache lifetime.** No TTL, invalidation or size limit, so the browser cache only grows. Fine for this app, not for a long-lived SPA. The cache key is just the URL (no options, headers or methods), it's JSON only, and `data` is `unknown`, so every component has to validate. fetchye covers most of this.
- **Lint config.** I'd use `eslint-config-amex`, AmEx's shared ESLint config, the same way the tests use `amex-jest-preset`. It needs ESLint 9 and TypeScript 5, and this repo is on ESLint 10 and TypeScript 6, so it's a downgrade I'd do in its own PR.
- **valibot 1.x.** 0.30 has a moderate advisory in `record()`, which the app doesn't use. 1.x renames `v.Output` to `v.InferOutput` in `application/validation.ts`. Its own PR.

### Raise with the owning team

Real production gaps, but not ours to change. I'd raise each one with its owner.

**Platform (One App)**

- `buildHtmlDoc` injects data into a single-quoted string with no escaping. The library works around it, but `<script type="application/json">` plus `JSON.parse` would be safer, and it's also what a strict CSP needs.
- Security headers: no Content-Security-Policy, HSTS, `X-Content-Type-Options` or `frame-ancestors`. In One App the CSP comes from the root module's config, so our part is making sure the module works under it.
- No error handler around render. If `validateData` throws, the server returns its default JSON 500. Same for 404s (the browser's `/favicon.ico` request already gets one). Error pages belong to the platform and root module.
- The per-request cache depends on the framework calling `wipeCache()` synchronously at the top of each request. If someone moves that call after an `await`, requests start sharing a cache again. The concurrency tests would catch it. One App with fetchye already gives each request its own cache.
- `client.js` is ~450kb minified (mostly MSW), served with no compression, no `Cache-Control` and no content hash in the file name. Bundling, compression and asset caching are platform concerns.
- Health checks, graceful shutdown, metrics, tracing and client error reporting. A module uses the platform's logger and metrics instead of adding its own.
- The viewport meta has `user-scalable=no` and `maximum-scale=1.0`, which blocks pinch zoom and fails WCAG 1.4.4. The page shell is the platform's.

**Edge and security**

- The pages render names, emails, addresses and balances, and the same data sits in `__INITIAL_DATA__` in the page source. There's no `Cache-Control` on HTML, so a CDN or shared proxy could cache one person's page and serve it to someone else. Pages with personal data need `Cache-Control: private, no-store`.
- No authentication or authorization; anyone can load everyone's balance.
- No rate limiting on the server-rendered routes. Every request does a full render and an API call.

**API owner**

- Cursor-based pagination (cursors, so new rows don't shift pages).
- Raw values instead of display strings: `balance` is `"$9,632.11"` and `created` is `"September 17, 2021"`. Money should be an amount in minor units plus a currency code, and dates ISO 8601, so the app can format them per locale. That matters for a product used in many markets. I'd ask for it as a new API version and map the old format in the module meanwhile.
- A stable ID per person, for list keys.

### Tests

- Visual baselines are macOS-only (screenshots depend on OS fonts), so CI skips them. Next step is generating Linux baselines in the Playwright Docker image.
- Fastify's request logging is noisy in the Playwright output.
- `npm audit` shows moderate advisories in Jest's own dependencies (old `glob`/`minimatch` and `deepmerge`). They're dev-only and never ship; the production audit in CI is clean. The fix is a Jest release that updates them, not `npm audit fix --force`.

## Next steps

In the order I'd do them on a real team:

1. Move the module to fetchye, with the 3 second timeout in a custom fetcher.
2. Loading, error and empty states, plus the accessibility fixes in the module.
3. Raise the API asks (cursor pagination, raw money and dates, stable IDs) with the API owner, and render in pages until then.
4. Raise the `Cache-Control` and auth gaps with edge and security. These matter most for a page with personal data.
5. Validate once per cache entry, then browser retry with backoff and jitter.
6. `eslint-config-amex` and valibot 1.x, each in its own PR.
7. Linux visual baselines so visual tests run in CI.

Ideas for later, not commitments: AI code review on pull requests as an extra reviewer on top of the CI gates (if the org has approved a tool), and at real scale a circuit breaker and stale-if-error caching, which are platform or gateway decisions.
