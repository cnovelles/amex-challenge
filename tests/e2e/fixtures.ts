import { test as base, expect, type Page } from '@playwright/test';

const PEOPLE_API = 'https://randomapi.com/';

type Fixtures = {
  /** Every request the page makes to the people API (MSW answers them in the service worker). */
  peopleRequests: string[];
  /** console.error output and uncaught page errors. */
  pageErrors: string[];
};

export const test = base.extend<Fixtures>({
  peopleRequests: async ({ page }, use) => {
    const urls: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(PEOPLE_API)) urls.push(request.url());
    });
    await use(urls);
  },
  pageErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    await use(errors);
  },
});

/** Resource Timing entries for the people API, as the browser's own network tab would list them. */
export const peopleResourceEntries = (page: Page) =>
  page.evaluate(
    (prefix) =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.startsWith(prefix)).length,
    PEOPLE_API,
  );

export { expect };
