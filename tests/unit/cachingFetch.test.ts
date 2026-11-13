/**
 * @jest-environment jest-fixed-jsdom
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  initializeCache,
  preloadCachingFetch,
  serializeCache,
  wipeCache,
} from '../../caching-fetch-library/cachingFetch';
import buildHtmlDoc from '../../framework/server/buildHtmlDoc';
import {
  extractInitialData,
  readCache,
  readClientCache,
} from '../helpers/readCache';

const URL_A = 'https://example.test/a';
const URL_B = 'https://example.test/b';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock<
  (url: string, init?: RequestInit) => Promise<Response>
>;

beforeEach(() => {
  wipeCache();
  fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
    jsonResponse([{ name: 'Ada' }]),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('preloadCachingFetch', () => {
  it('fetches the URL and makes the data available to the hook', async () => {
    await preloadCachingFetch(URL_A);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(URL_A, expect.anything());
    expect(readCache(URL_A)).toEqual({
      isLoading: false,
      data: [{ name: 'Ada' }],
      error: null,
    });
  });

  it('dedupes concurrent calls for the same URL into one request', async () => {
    await Promise.all(
      Array.from({ length: 150 }, () => preloadCachingFetch(URL_A)),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refetch a URL that is already cached', async () => {
    await preloadCachingFetch(URL_A);
    await preloadCachingFetch(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps different URLs separate', async () => {
    fetchMock.mockImplementation(async (url: string) => jsonResponse({ url }));
    await Promise.all([preloadCachingFetch(URL_A), preloadCachingFetch(URL_B)]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readCache(URL_A).data).toEqual({ url: URL_A });
    expect(readCache(URL_B).data).toEqual({ url: URL_B });
  });

  it('reports a pending request as loading', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    void preloadCachingFetch(URL_A);
    expect(readCache(URL_A)).toEqual({
      isLoading: true,
      data: null,
      error: null,
    });
  });

  it('stores a non-2xx response as an error instead of throwing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'nope' }, 500));

    await expect(preloadCachingFetch(URL_A)).resolves.toBeUndefined();
    expect(readClientCache(URL_A)).toEqual({
      isLoading: false,
      data: null,
      error: `Request to ${URL_A} failed with status 500`,
    });
  });

  it('stores a network failure as an error instead of throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(preloadCachingFetch(URL_A)).resolves.toBeUndefined();
    expect(readClientCache(URL_A).error).toBe('fetch failed');
  });

  it('stores invalid JSON as an error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>not json</html>'));

    await preloadCachingFetch(URL_A);
    expect(readClientCache(URL_A).error).toMatch(/JSON/);
  });

  it('wraps non-Error rejections in an Error', async () => {
    fetchMock.mockRejectedValue('boom');

    await preloadCachingFetch(URL_A);
    expect(readClientCache(URL_A).error).toBe('boom');
  });
});

describe('request timeout', () => {
  /** A fetch that never answers, but stops when its signal aborts (like real fetch). */
  const hangingFetch = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('This operation was aborted', 'AbortError')),
      );
    });

  beforeEach(() => {
    // Only the timers: faking microtasks or nextTick would stall promises.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores a timeout error when the API does not answer within 3 seconds', async () => {
    fetchMock.mockImplementation(hangingFetch);
    const preload = preloadCachingFetch(URL_A);

    await jest.advanceTimersByTimeAsync(2999);
    expect(readCache(URL_A).isLoading).toBe(true);

    await jest.advanceTimersByTimeAsync(1);
    await expect(preload).resolves.toBeUndefined();
    expect(readClientCache(URL_A)).toEqual({
      isLoading: false,
      data: null,
      error: `Request to ${URL_A} timed out after 3000ms`,
    });
  });

  it('clears the timer when the request finishes in time', async () => {
    await preloadCachingFetch(URL_A);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timer when the request fails in time', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await preloadCachingFetch(URL_A);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('after a failed request', () => {
  it('fetches again on the next call instead of keeping the error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('down', 503));
    await preloadCachingFetch(URL_A);
    expect(readClientCache(URL_A).error).toBe(
      `Request to ${URL_A} failed with status 503`,
    );

    await preloadCachingFetch(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readCache(URL_A)).toEqual({
      isLoading: false,
      data: [{ name: 'Ada' }],
      error: null,
    });
  });

  it('shares one new request between concurrent callers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('down', 503));
    await preloadCachingFetch(URL_A);

    await Promise.all(
      Array.from({ length: 10 }, () => preloadCachingFetch(URL_A)),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stores a synchronous fetch throw as an error, not a stuck pending entry', async () => {
    fetchMock.mockImplementationOnce(() => {
      throw new TypeError('fetch is not a function');
    });

    await expect(preloadCachingFetch(URL_A)).resolves.toBeUndefined();
    expect(readClientCache(URL_A)).toEqual({
      isLoading: false,
      data: null,
      error: 'fetch is not a function',
    });

    await preloadCachingFetch(URL_A);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readCache(URL_A).data).toEqual([{ name: 'Ada' }]);
  });
});

describe('server render after a failed request', () => {
  it('shows loading instead of the error, so the browser can try again', async () => {
    fetchMock.mockResolvedValue(jsonResponse('bad', 503));
    await preloadCachingFetch(URL_A);

    expect(readCache(URL_A)).toEqual({
      isLoading: true,
      data: null,
      error: null,
    });
    expect(readClientCache(URL_A).error).toBe(
      `Request to ${URL_A} failed with status 503`,
    );
  });
});

describe('the hook before anything is cached', () => {
  it('reports loading and does not fetch during render', () => {
    expect(readCache(URL_A)).toEqual({
      isLoading: true,
      data: null,
      error: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('serializeCache / initializeCache', () => {
  it('serializes an empty cache to something initializeCache accepts', () => {
    const serialized = serializeCache();
    wipeCache();
    expect(() => initializeCache(serialized)).not.toThrow();
  });

  it('round-trips successful entries', async () => {
    await preloadCachingFetch(URL_A);
    const serialized = serializeCache();

    wipeCache();
    expect(readCache(URL_A).isLoading).toBe(true);

    initializeCache(serialized);
    expect(readCache(URL_A)).toEqual({
      isLoading: false,
      data: [{ name: 'Ada' }],
      error: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves out failed and in-flight requests so the browser can retry', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === URL_A ? jsonResponse('ok') : jsonResponse('bad', 503),
    );
    await preloadCachingFetch(URL_A);
    await preloadCachingFetch(URL_B);
    fetchMock.mockReturnValue(new Promise(() => {}));
    void preloadCachingFetch('https://example.test/pending');

    const decoded = JSON.parse(decodeURIComponent(serializeCache()));
    expect(Object.keys(decoded)).toEqual([URL_A]);
  });

  it('only outputs characters that are safe inside a single-quoted script string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ nasty: `O'Brien \\ "quoted" </script><script>alert(1)` }),
    );
    await preloadCachingFetch(URL_A);

    expect(serializeCache()).toMatch(/^[A-Za-z0-9\-_.!~*()%]*$/);
  });

  it('survives being injected into the page by buildHtmlDoc', async () => {
    const nasty = {
      apostrophe: "O'Brien",
      backslash: 'C:\\temp\\new',
      closeTag: '</script><script>window.pwned = true</script>',
      unicode: 'José 🎉 \u2028 line\nbreak',
      html: '<!-- comment --> & &amp;',
    };
    fetchMock.mockResolvedValue(jsonResponse(nasty));
    await preloadCachingFetch(URL_A);

    const html = buildHtmlDoc(['<p>app</p>', serializeCache()]);
    const fromPage = extractInitialData(html);
    expect(fromPage).toBeDefined();

    wipeCache();
    initializeCache(fromPage!);
    expect(readCache(URL_A).data).toEqual(nasty);
  });

  it('ignores garbage input without throwing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => initializeCache('%E0%A4%A')).not.toThrow(); // bad URI escape
    expect(() => initializeCache('not json')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);

    expect(() => initializeCache(encodeURIComponent('[1,2]'))).not.toThrow();
    expect(() => initializeCache(encodeURIComponent('null'))).not.toThrow();
    expect(readCache(URL_A).isLoading).toBe(true);
  });
});

describe('wipeCache', () => {
  it('removes all cached entries', async () => {
    await preloadCachingFetch(URL_A);
    wipeCache();

    expect(readCache(URL_A).isLoading).toBe(true);
    expect(JSON.parse(decodeURIComponent(serializeCache()))).toEqual({});
  });

  it('drops a response that lands after the cache was wiped', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const pending = preloadCachingFetch(URL_A);

    wipeCache();
    resolve(jsonResponse('stale'));
    await pending;

    expect(readCache(URL_A).isLoading).toBe(true);
  });
});
