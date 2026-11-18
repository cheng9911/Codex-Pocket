import assert from 'node:assert/strict';
import test from 'node:test';
import { api, ApiError } from '../apps/web/src/api.ts';

test('network errors and non-JSON gateway errors retain distinct HTTP status', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(api('/host'), (error) => error instanceof ApiError && error.status === 0);
  request.mock.mockImplementation(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
  await assert.rejects(api('/host'), (error) => error instanceof ApiError && error.status === 502);
});

test('a timed out password submission is never repeated by the API client', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      assert.ok(options?.signal);
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  );
  const login = api('/login', { password: 'fixture password' }, 1000);
  const outcome = assert.rejects(login, (error) =>
    error instanceof ApiError && error.status === 0 && error.message.includes('超时'),
  );
  t.mock.timers.tick(1000);
  await outcome;
  assert.equal(request.mock.callCount(), 1);
});
