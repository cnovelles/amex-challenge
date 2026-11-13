import { expect, test } from '@playwright/test';

// Two tests share one baseline, so don't let them write it at the same time.
test.describe.configure({ mode: 'serial' });

// Baselines live next to this file (pages.spec.ts-snapshots/) and are
// per-platform. Regenerate with: npm run test:visual -- --update-snapshots

test('landing page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveScreenshot('landing.png', { fullPage: true });
});

test('people directory (server HTML only) matches the baseline', async ({
  page,
}) => {
  // Block the client bundle so this is exactly what the server sent. (Turning
  // JS off entirely would also stop Playwright measuring the full page height.)
  await page.route('**/client.js', (route) => route.abort());
  await page.goto('/appWithSSRData');
  await expect(page).toHaveScreenshot('directory-ssr.png', { fullPage: true });
});

test('client-rendered directory looks the same as the SSR one', async ({
  page,
}) => {
  await page.goto('/appWithoutSSRData');
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(75);
  // same baseline as the SSR test: both routes must end up pixel-identical
  await expect(page).toHaveScreenshot('directory-ssr.png', { fullPage: true });
});
