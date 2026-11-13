// You may edit this file, add new files to support this file,
// and/or add new dependencies to the project as you see fit.
// However, you must not change the surface API presented from this file,
// and you should not need to change any other files in the project to complete the challenge

import type { AsyncLocalStorage } from 'node:async_hooks';
import { useEffect, useSyncExternalStore } from 'react';

type UseCachingFetch = (url: string) => {
  isLoading: boolean;
  data: unknown;
  error: Error | null;
};

/**
 * One cache entry per URL.
 * - pending: a request is in flight, `promise` settles when it's done
 * - success: `data` holds the parsed JSON body
 * - error:   `error` holds what went wrong
 *
 * Entries are replaced (never mutated) when they change, so the entry object
 * itself can be used as a stable useSyncExternalStore snapshot.
 */
type CacheEntry =
  | { status: 'pending'; data: null; error: null; promise: Promise<void> }
  | { status: 'success'; data: unknown; error: null }
  | { status: 'error'; data: null; error: Error };

type Cache = Map<string, CacheEntry>;

/**
 * Per-request caches on the server.
 *
 * The server handles requests concurrently, and calls wipeCache() at the
 * start of each one. With a single module-level Map, request B's wipe would
 * empty the cache while request A is still preloading, so A would render and
 * serialize nothing. Instead, wipeCache() gives the current request its own
 * Map through AsyncLocalStorage, and everything that request does afterwards
 * (preload, render, serialize) sees only that Map.
 *
 * getBuiltinModule keeps esbuild from trying to bundle async_hooks into the
 * browser build. In the browser (or older Node) it's undefined and we fall
 * back to one shared Map, which is correct there: one page, one user.
 */
const requestCaches: AsyncLocalStorage<Cache> | null = (() => {
  const getBuiltin =
    typeof process === 'undefined' ? undefined : process.getBuiltinModule;
  if (typeof getBuiltin !== 'function') return null;
  const { AsyncLocalStorage } = getBuiltin('node:async_hooks');
  return new AsyncLocalStorage<Cache>();
})();

let sharedCache: Cache = new Map();

const getCache = (): Cache => requestCaches?.getStore() ?? sharedCache;
const listeners = new Map<string, Set<() => void>>();

const notify = (url: string) => {
  listeners.get(url)?.forEach((listener) => listener());
};

const subscribe = (url: string, listener: () => void) => {
  let set = listeners.get(url);
  if (!set) {
    set = new Set();
    listeners.set(url, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(url);
  };
};

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const setEntry = (cache: Cache, url: string, entry: CacheEntry) => {
  // Write into the cache the request was started from. If wipeCache() swapped
  // in a new one meanwhile, this lands in the old, orphaned Map and is dropped,
  // instead of leaking a stale result into the new cache.
  cache.set(url, entry);
  if (cache === getCache()) notify(url);
};

/**
 * Fetches a URL unless it's already pending or loaded. A pending entry is
 * shared, so concurrent callers make one network request. A failed entry is
 * not reused: the next caller fetches again, so a page can recover once the
 * API is back. The returned promise never rejects; failures are stored in
 * the cache so every component sees them.
 */
const fetchOnce = (url: string): Promise<void> => {
  const cache = getCache();
  const existing = cache.get(url);
  if (existing?.status === 'pending') return existing.promise;
  if (existing?.status === 'success') return Promise.resolve();

  // Start the work on the next microtask, not right away. If fetch throws
  // synchronously (no fetch in this runtime, a broken polyfill), the catch
  // below must run after the pending entry exists, or the error is lost and
  // the entry stays pending forever.
  const promise = Promise.resolve().then(async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Request to ${url} failed with status ${response.status}`,
        );
      }
      const data: unknown = await response.json();
      setEntry(cache, url, { status: 'success', data, error: null });
    } catch (err) {
      setEntry(cache, url, {
        status: 'error',
        data: null,
        error: toError(err),
      });
    }
  });

  // Store the pending entry synchronously, so a second caller in the same
  // tick sees it and doesn't fetch again.
  cache.set(url, { status: 'pending', data: null, error: null, promise });
  // Components that show an earlier error switch to loading for the new try.
  if (existing) notify(url);
  return promise;
};

/** Shared snapshot for "nothing in the cache yet", so the reference is stable. */
const NOT_STARTED = {
  isLoading: true,
  data: null,
  error: null,
} as const;

/**
 * 1. Implement a caching fetch hook. The hook should return an object with the following properties:
 * - isLoading: a boolean that is true when the fetch is in progress and false otherwise
 * - data: the data returned from the fetch, or null if the fetch has not completed
 * - error: an error object if the fetch fails, or null if the fetch is successful
 *
 * This hook is called three times on the client:
 *  - 1 in App.tsx
 *  - 2 in Person.tsx
 *  - 3 in Name.tsx
 *
 * Acceptance Criteria:
 * 1. The application at /appWithoutSSRData should properly render, with JavaScript enabled, you should see a list of people.
 * 2. You should only see 1 network request in the browser's network tab when visiting the /appWithoutSSRData route.
 * 3. You have not changed any code outside of this file to achieve this.
 * 4. This file passes a type-check.
 *
 */
export const useCachingFetch: UseCachingFetch = (url) => {
  // Reading the cache during render is what makes SSR work: on the server
  // there are no effects, so whatever is in the cache is what gets rendered.
  // The same function is used as the server snapshot, so the first client
  // render (hydration) sees exactly what the server saw.
  const getSnapshot = () => getCache().get(url);
  const entry = useSyncExternalStore(
    (listener) => subscribe(url, listener),
    getSnapshot,
    getSnapshot,
  );

  // Side effects only in an effect: never fetch during render, and never on
  // the server. Every component calls this: fetchOnce shares a pending
  // request, skips loaded data, and tries a failed request again.
  useEffect(() => {
    void fetchOnce(url);
  }, [url]);

  if (!entry) return NOT_STARTED;
  return {
    isLoading: entry.status === 'pending',
    data: entry.data,
    error: entry.error,
  };
};

/**
 * 2. Implement a preloading caching fetch function. The function should fetch the data.
 *
 * This function will be called once on the server before any rendering occurs.
 *
 * Any subsequent call to useCachingFetch should result in the returned data being available immediately.
 * Meaning that the page should be completely serverside rendered on /appWithSSRData
 *
 * Acceptance Criteria:
 * 1. The application at /appWithSSRData should properly render, with JavaScript disabled, you should see a list of people.
 * 2. You have not changed any code outside of this file to achieve this.
 * 3. This file passes a type-check.
 *
 */
export const preloadCachingFetch = async (url: string): Promise<void> => {
  // Never throws: a failed request is stored as an error entry and the app
  // renders its own error state instead of the server returning a 500.
  await fetchOnce(url);
};

/**
 * 3.1 Implement a serializeCache function that serializes the cache to a string.
 * 3.2 Implement an initializeCache function that initializes the cache from a serialized cache string.
 *
 * Together, these two functions will help the framework transfer your cache to the browser.
 *
 * The framework will call `serializeCache` on the server to serialize the cache to a string and inject it into the dom.
 * The framework will then call `initializeCache` on the browser with the serialized cache string to initialize the cache.
 *
 * Acceptance Criteria:
 * 1. The application at /appWithSSRData should properly render, with JavaScript enabled, you should see a list of people.
 * 2. You should not see any network calls to the people API when visiting the /appWithSSRData route.
 * 3. You have not changed any code outside of this file to achieve this.
 * 4. This file passes a type-check.
 *
 */
export const serializeCache = (): string => {
  // Only successful results go to the browser. Errors and in-flight requests
  // are left out so the browser can try again on its own.
  const successful: Record<string, unknown> = {};
  getCache().forEach((entry, url) => {
    if (entry.status === 'success') successful[url] = entry.data;
  });

  // The framework drops this string straight into
  //   <script>window.__INITIAL_DATA__ = '...'</script>
  // with no escaping. encodeURIComponent leaves only [A-Za-z0-9-_.!~*'()%],
  // and we also encode the apostrophe, so nothing can close the string or the
  // script tag (no ', \, <, newlines). It also round-trips without the browser.
  return encodeURIComponent(JSON.stringify(successful)).replace(/'/g, '%27');
};

export const initializeCache = (serializedCache: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(serializedCache));
  } catch (err) {
    // Bad initial data shouldn't break the page; the hook will just fetch.
    console.warn('cachingFetch: ignoring invalid serialized cache', err);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return;
  }
  const cache = getCache();
  Object.entries(parsed as Record<string, unknown>).forEach(([url, data]) => {
    cache.set(url, { status: 'success', data, error: null });
    notify(url);
  });
};

export const wipeCache = (): void => {
  // Swap in a new Map rather than clearing the old one, so a request that is
  // still running keeps its own data.
  const fresh: Cache = new Map();
  sharedCache = fresh;
  // enterWith scopes `fresh` to the current request: the framework calls
  // wipeCache() synchronously at the top of each request handler, so the
  // rest of that handler (preload, render, serialize) runs inside it.
  requestCaches?.enterWith(fresh);
};
