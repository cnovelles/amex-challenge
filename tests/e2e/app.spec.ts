import { expect, peopleResourceEntries, test } from './fixtures';

const PEOPLE = 75;

test.describe('landing page', () => {
  test('links to both versions of the app', async ({ page }) => {
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'Welcome to the People Directory' }),
    ).toBeVisible();
    await page.getByRole('link', { name: '/appWithoutSSRData' }).click();
    await expect(page).toHaveURL(/\/appWithoutSSRData$/);

    await page.goBack();
    await page.getByRole('link', { name: '/appWithSSRData' }).click();
    await expect(page).toHaveURL(/\/appWithSSRData$/);
  });
});

test.describe('/appWithoutSSRData', () => {
  test('renders the list with exactly one request to the people API', async ({
    page,
    peopleRequests,
    pageErrors,
  }) => {
    await page.goto('/appWithoutSSRData');

    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(PEOPLE);
    await expect(
      page.getByRole('heading', { name: 'Arturo Harber' }),
    ).toBeVisible();
    await expect(page.getByText('Arturo.Harber@gwendolyn.biz')).toBeVisible();
    await expect(page.getByText('Loading...')).toHaveCount(0);

    // give any stray late requests a chance to show up
    await page.waitForLoadState('networkidle');
    expect(peopleRequests).toHaveLength(1);
    expect(await peopleResourceEntries(page)).toBe(1);
    expect(pageErrors).toEqual([]);
  });

  test('server HTML is the loading state (no data on the server)', async ({
    request,
  }) => {
    const html = await (await request.get('/appWithoutSSRData')).text();

    expect(html).toContain('<div id="app"><div>Loading...</div></div>');
    expect(html).not.toContain('__INITIAL_DATA__');
  });
});

test.describe('/appWithSSRData', () => {
  test('renders the list with JavaScript disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/appWithSSRData');

    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(PEOPLE);
    await expect(
      page.getByRole('heading', { name: 'Kara Schulist' }),
    ).toBeVisible();
    await context.close();
  });

  test('hydrates with zero requests to the people API and no errors', async ({
    page,
    peopleRequests,
    pageErrors,
  }) => {
    await page.goto('/appWithSSRData');
    // the client bundle deletes __INITIAL_DATA__ right before hydrating
    await page.waitForFunction(() => !('__INITIAL_DATA__' in window));
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(PEOPLE);
    expect(peopleRequests).toEqual([]);
    expect(await peopleResourceEntries(page)).toBe(0);
    // React reports hydration mismatches through console.error
    expect(pageErrors).toEqual([]);
  });

  test('injects a cache that decodes to the 75 people', async ({ request }) => {
    const response = await request.get('/appWithSSRData');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');

    const html = await response.text();
    const match = html.match(/window\.__INITIAL_DATA__ = '([^']*)'/);
    expect(match).not.toBeNull();

    const cache = JSON.parse(decodeURIComponent(match![1])) as Record<
      string,
      unknown[]
    >;
    const [people] = Object.values(cache);
    expect(people).toHaveLength(PEOPLE);
  });

  test('concurrent requests each get a complete render and cache', async ({
    request,
  }) => {
    // Regression test: with one shared server cache, one request's wipeCache()
    // emptied another request's cache mid-render.
    const pages = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request.get(i % 2 ? '/appWithSSRData' : '/appWithoutSSRData'),
      ),
    );
    for (const [i, res] of pages.entries()) {
      const html = await res.text();
      if (i % 2) {
        expect(html.match(/<h2>/g)).toHaveLength(PEOPLE);
        const data = html.match(/window\.__INITIAL_DATA__ = '([^']*)'/)![1];
        expect(Object.keys(JSON.parse(decodeURIComponent(data)))).toHaveLength(
          1,
        );
      } else {
        expect(html).toContain('<div>Loading...</div>');
      }
    }
  });
});

test.describe('static assets', () => {
  test('serves the client bundle and service worker as JavaScript', async ({
    request,
  }) => {
    for (const path of ['/client.js', '/mockServiceWorker.js']) {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/javascript');
    }
  });
});
