// You may edit this file, add new files to support this file,
// and/or add new dependencies to the project as you see fit.
// However, you must not change the surface API presented from this file,
// and you should not need to change any other files in the project to complete the challenge

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

const cache = new Map<string, CacheEntry>();
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

const setEntry = (url: string, entry: CacheEntry) => {
  // If wipeCache() ran while this request was in flight, the pending entry is
  // gone. Don't resurrect a result that belongs to an older cache generation.
  const current = cache.get(url);
  if (!current || current.status !== 'pending') return;
  cache.set(url, entry);
  notify(url);
};

/**
 * Fetches a URL unless it's already pending or loaded. A pending entry is
 * shared, so concurrent callers make one network request. A failed entry is
 * not reused: the next caller fetches again, so a page can recover once the
 * API is back. The returned promise never rejects; failures are stored in
 * the cache so every component sees them.
 */
const fetchOnce = (url: string): Promise<void> => {
  const existing = cache.get(url);
  if (existing?.status === 'pending') return existing.promise;
  if (existing?.status === 'success') return Promise.resolve();

  const promise = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Request to ${url} failed with status ${response.status}`,
        );
      }
      const data: unknown = await response.json();
      setEntry(url, { status: 'success', data, error: null });
    } catch (err) {
      setEntry(url, { status: 'error', data: null, error: toError(err) });
    }
  })();

  // Store the pending entry synchronously, before anything awaits,
  // so a second caller in the same tick sees it and doesn't fetch again.
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
  const getSnapshot = () => cache.get(url);
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
  cache.forEach((entry, url) => {
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
  Object.entries(parsed as Record<string, unknown>).forEach(([url, data]) => {
    cache.set(url, { status: 'success', data, error: null });
    notify(url);
  });
};

export const wipeCache = (): void => {
  cache.clear();
};
