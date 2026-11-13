/**
 * @jest-environment jest-fixed-jsdom
 */
import React, { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { http, HttpResponse } from 'msw';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import App from '../../application/App';
import buildHtmlDoc from '../../framework/server/buildHtmlDoc';
import renderApp from '../../framework/server/renderApp';
import {
  initializeCache,
  serializeCache,
  wipeCache,
} from '../../caching-fetch-library/cachingFetch';
import { countPeopleRequests, PEOPLE_URL, server } from '../helpers/mswServer';
import { extractInitialData } from '../helpers/readCache';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => wipeCache());
afterEach(() => {
  cleanup();
  server.resetHandlers();
});

describe('client render (/appWithoutSSRData behaviour)', () => {
  it('shows Loading, then all 75 people from a single request', async () => {
    const requests = countPeopleRequests();

    render(<App />);
    expect(screen.getByText('Loading...')).toBeTruthy();

    const names = await screen.findAllByRole('heading', { level: 2 });
    expect(names).toHaveLength(75);
    expect(names[0].textContent).toBe('Arturo Harber');
    expect(screen.getByText('Arturo.Harber@gwendolyn.biz')).toBeTruthy();

    expect(requests.count).toBe(1);
    requests.stop();
  });

  it('still makes one request under StrictMode (effects run twice)', async () => {
    const requests = countPeopleRequests();

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findAllByRole('heading', { level: 2 })).toHaveLength(
      75,
    );

    expect(requests.count).toBe(1);
    requests.stop();
  });

  it('shows the error from the hook when the API fails', async () => {
    server.use(
      http.get(PEOPLE_URL, () => new HttpResponse(null, { status: 500 })),
    );

    render(<App />);

    expect(await screen.findByText(/failed with status 500/)).toBeTruthy();
  });

  it('serves a second mount from the cache without a new request', async () => {
    const requests = countPeopleRequests();
    const first = render(<App />);
    await screen.findAllByRole('heading', { level: 2 });
    first.unmount();

    render(<App />);
    // data is already there, so no Loading state at all
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(75);
    expect(requests.count).toBe(1);
    requests.stop();
  });
});

describe('server render', () => {
  it('renders Loading without fetching when nothing was preloaded', async () => {
    const requests = countPeopleRequests();

    const [html, initialData] = await renderApp(false);

    expect(html).toBe('<div>Loading...</div>');
    expect(initialData).toBeUndefined();
    expect(requests.count).toBe(0);
    requests.stop();
  });

  it('renders the full list after preLoadServerData', async () => {
    const [html, initialData] = await renderApp(true);

    expect(html.match(/<h2>/g)).toHaveLength(75);
    expect(html).toContain('Arturo');
    expect(initialData).toBeTruthy();
  });

  it('renders the app error state instead of throwing when preload fails', async () => {
    server.use(http.get(PEOPLE_URL, () => HttpResponse.error()));

    const [html, initialData] = await renderApp(true);

    expect(html).toContain('Error:');
    // nothing successful to hand to the browser
    expect(JSON.parse(decodeURIComponent(initialData!))).toEqual({});
  });
});

describe('SSR -> hydration (/appWithSSRData behaviour)', () => {
  it('hydrates from the serialized cache with zero requests and no mismatch', async () => {
    // server side
    const [serverHtml, initialData] = await renderApp(true);
    const page = buildHtmlDoc([serverHtml, initialData]);

    // now pretend to be a fresh browser
    wipeCache();
    const requests = countPeopleRequests();
    const consoleError = jest.spyOn(console, 'error');
    const recoverableErrors: unknown[] = [];

    const fromPage = extractInitialData(page);
    expect(fromPage).toBe(initialData);
    initializeCache(fromPage!);

    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, <App />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(recoverableErrors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(container.querySelectorAll('h2')).toHaveLength(75);
    expect(requests.count).toBe(0);
    requests.stop();
    container.remove();
  });

  it('hydrates the Loading state cleanly when there was no SSR data, then fetches once', async () => {
    const [serverHtml] = await renderApp(false);
    const requests = countPeopleRequests();
    const recoverableErrors: unknown[] = [];

    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    await act(async () => {
      hydrateRoot(container, <App />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });
    await waitFor(() =>
      expect(container.querySelectorAll('h2')).toHaveLength(75),
    );

    expect(recoverableErrors).toEqual([]);
    expect(requests.count).toBe(1);
    requests.stop();
    container.remove();
  });

  it('serializeCache matches what renderApp injected', async () => {
    const [, initialData] = await renderApp(true);
    expect(serializeCache()).toBe(initialData);
    expect(renderToString(<App />).match(/<h2>/g)).toHaveLength(75);
  });
});

describe('concurrent server requests', () => {
  // Mirrors framework/server/index.ts: each request runs in its own async
  // context, calls wipeCache() first, then awaits renderApp().
  const handleRequest = (withData: boolean) =>
    new Promise<[string, string?]>((resolve) => {
      setTimeout(() => {
        wipeCache();
        resolve(renderApp(withData));
      });
    });

  it("keeps each request's cache separate when requests overlap", async () => {
    // Mix in pages without server data: they wipe the cache but never
    // preload, which is what dropped an SSR page's pending result before.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => handleRequest(i % 2 === 0)),
    );
    const ssrResults = results.filter((_, i) => i % 2 === 0);

    for (const [html, initialData] of ssrResults) {
      expect(html.match(/<h2>/g)).toHaveLength(75);
      const cache = JSON.parse(decodeURIComponent(initialData!)) as Record<
        string,
        unknown[]
      >;
      expect(Object.values(cache)[0]).toHaveLength(75);
    }
  });
});
