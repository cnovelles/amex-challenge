import React from 'react';
import { renderToString } from 'react-dom/server';
import { Bench } from 'tinybench';
import { afterAll, beforeAll, expect, it } from '@jest/globals';
import App from '../../application/App';
import {
  initializeCache,
  serializeCache,
  wipeCache,
} from '../../caching-fetch-library/cachingFetch';
import { server } from '../helpers/mswServer';

// Report-only benchmark (npm run bench). Not part of npm test. Useful for
// comparing changes, e.g. how much the ~151 validateData calls per render cost.
let serialized = '';

beforeAll(async () => {
  server.listen();
  wipeCache();
  await App.preLoadServerData?.();
  serialized = serializeCache();
});
afterAll(() => server.close());

it('server work per request', async () => {
  const bench = new Bench({ time: 500 });
  bench
    .add('renderToString of the full directory', () => {
      renderToString(<App />);
    })
    .add('serializeCache', () => {
      serializeCache();
    })
    .add('initializeCache', () => {
      initializeCache(serialized);
    });

  await bench.run();
  console.table(bench.table());

  for (const task of bench.tasks) expect(task.result).toBeDefined();
}, 30_000);
