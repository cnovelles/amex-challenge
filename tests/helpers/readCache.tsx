import React from 'react';
import { runInNewContext } from 'node:vm';
import { renderToString } from 'react-dom/server';
import { useCachingFetch } from '../../caching-fetch-library/cachingFetch';

/**
 * The library doesn't expose its cache, so read it the way the app does:
 * server-render a component that calls the hook and dumps what it returns.
 * Server rendering runs no effects, so this never triggers a fetch.
 */
export const readCache = (
  url: string,
): { isLoading: boolean; data: unknown; error: string | null } => {
  let result: ReturnType<typeof readCache> | undefined;
  const Probe = () => {
    const { isLoading, data, error } = useCachingFetch(url);
    result = { isLoading, data, error: error ? error.message : null };
    return null;
  };
  renderToString(<Probe />);
  if (!result) throw new Error('Probe did not render');
  return result;
};

/** Runs the inline script exactly as the framework writes it and returns window.__INITIAL_DATA__. */
export const extractInitialData = (html: string): string | undefined => {
  // Grab the first inline script, the same way the HTML parser would: it ends
  // at the first "</script>", which is why serialization has to be safe.
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) return undefined;
  // Run it in an isolated VM context with a fake window, like a browser would.
  const sandbox: { window: { __INITIAL_DATA__?: string } } = { window: {} };
  runInNewContext(match[1], sandbox);
  return sandbox.window.__INITIAL_DATA__;
};
