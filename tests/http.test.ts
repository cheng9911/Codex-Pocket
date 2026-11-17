import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createHttp } from '../apps/server/src/http.ts';
import { setup, waitFor } from './helpers.ts';
import { randomUUID } from 'node:crypto';

test('pairing is one-use; HTTP and WS enforce authentication and origin; revocation closes socket', async () => {
  const env = await setup(),
    server = createHttp(env.service);
  await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', r));
  const port = (server.http.address() as any).port,
    base = `http://127.0.0.1:${port}`;
  const request = (path: string, body?: unknown, cookie?: string, origin = base) =>
    fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'X-Pocket-Client': 'web' }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await request('/snapshot')).status, 401);
    const code = server.auth.pairCode();
    const paired = await request('/pair', { code, label: 'Test phone' });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await request('/pair', { code })).status, 401);
    assert.equal(
      (await request('/snapshot', undefined, cookie, 'https://evil.example')).status,
      403,
    );
    assert.equal((await request('/snapshot', undefined, cookie)).status, 200);
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/events', {
      headers: { Cookie: cookie, Origin: base },
    });
    const first = await once(ws, 'message');
    assert.equal(JSON.parse(first[0].toString()).type, 'snapshot');
    const session = (await (await request('/sessions', undefined, cookie)).json())[0];
    const closed = once(ws, 'close');
    assert.equal((await request(`/sessions/${session.id}/revoke`, {}, cookie)).status, 200);
    assert.equal((await closed)[0], 4001);
    assert.equal((await request('/snapshot', undefined, cookie)).status, 401);
  } finally {
    await server.close();
    await env.close();
  }
});
test('browser disconnect does not interrupt tasks; reconnect receives current state', async () => {
  const env = await setup(),
    server = createHttp(env.service);
  await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.http.address() as any).port}`;
  const token = server.auth.exchange(server.auth.pairCode(), 'Phone', 'test');
  const headers = { Cookie: server.auth.cookieName + '=' + token, Origin: base };
  try {
    const chat = await env.service.create('Keep running', env.root, null);
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/events', { headers });
    await once(ws, 'message');
    ws.close();
    await once(ws, 'close');
    await env.service.message(chat.id, 'hang', randomUUID());
    await waitFor(env.store, () => env.store.chat(chat.id).turnId ?? undefined);
    assert.equal(env.store.chat(chat.id).status, 'running');
    const ws2 = new WebSocket(base.replace('http', 'ws') + '/api/events?after=0', { headers });
    const data = JSON.parse((await once(ws2, 'message'))[0].toString());
    assert.equal(data.data.chats.find((c: any) => c.id === chat.id).status, 'running');
    ws2.close();
    await once(ws2, 'close');
    await env.service.stop(chat.id);
  } finally {
    await server.close();
    await env.close();
  }
});
test('canonical workspace roots reject traversal and symlink escapes', async () => {
  const env = await setup();
  try {
    await assert.rejects(() => env.service.directory('/etc'), /允许/);
    const { symlink } = await import('node:fs/promises');
    await symlink('/etc', env.root + '/escape');
    await assert.rejects(() => env.service.directory(env.root + '/escape'), /允许/);
  } finally {
    await env.close();
  }
});
