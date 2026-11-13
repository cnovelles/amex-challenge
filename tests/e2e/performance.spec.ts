import { expect, test } from './fixtures';

// Generous budgets: these catch regressions like "SSR now waits on something
// slow" or "the list takes forever to show up", not micro-benchmarks.
const SSR_RESPONSE_BUDGET_MS = 1_000;
const CLIENT_LIST_BUDGET_MS = 5_000;

test('SSR page responds within budget', async ({ request }) => {
  await request.get('/appWithSSRData'); // warm up
  const start = Date.now();
  const res = await request.get('/appWithSSRData');
  const elapsed = Date.now() - start;

  expect(res.ok()).toBe(true);
  expect(elapsed).toBeLessThan(SSR_RESPONSE_BUDGET_MS);
});

test('SSR page has the list in the first paint (before any JS)', async ({
  page,
}) => {
  // Block the client bundle: if people still show up, they came from HTML.
  await page.route('**/client.js', (route) => route.abort());
  await page.goto('/appWithSSRData', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(75);
});

test('client-rendered list shows up within budget', async ({ page }) => {
  const start = Date.now();
  await page.goto('/appWithoutSSRData');
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(75, {
    timeout: CLIENT_LIST_BUDGET_MS,
  });
  expect(Date.now() - start).toBeLessThan(CLIENT_LIST_BUDGET_MS);
});
