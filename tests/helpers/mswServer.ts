import { setupServer } from 'msw/node';
import { handler } from '../../framework/mock-server/handler';

export const PEOPLE_URL =
  'https://randomapi.com/api/6de6abfedb24f889e0b5f675edc50deb?fmt=raw&sole&seed=123';

/** Same MSW handler the app uses at runtime, so tests see the real 75 people. */
export const server = setupServer(handler);

/** Counts requests that hit the people API (MSW sees every fetch the code makes). */
export const countPeopleRequests = () => {
  let count = 0;
  const onStart = ({ request }: { request: Request }) => {
    if (request.url.startsWith('https://randomapi.com/')) count += 1;
  };
  server.events.on('request:start', onStart);
  return {
    get count() {
      return count;
    },
    stop: () => server.events.removeListener('request:start', onStart),
  };
};
