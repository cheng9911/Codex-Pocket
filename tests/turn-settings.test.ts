import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createHttp } from '../apps/server/src/http.ts';
import { setup, waitFor } from './helpers.ts';

test('validated settings stay with a queued message and steer keeps the active settings', async () => {
  const env = await setup();
  try {
    const chat = await env.service.create('Turn settings', env.root, 'fixture-model');
    await env.service.message(chat.id, 'hang', randomUUID());
    const turnId = await waitFor(env.store, () => env.store.chat(chat.id).turnId ?? undefined);
    await assert.rejects(
      env.service.message(chat.id, 'bad effort', randomUUID(), 'queue', undefined, {
        effort: 'high',
      }),
      /不支持此思考强度/,
    );
    await assert.rejects(
      env.service.message(chat.id, 'bad steer', randomUUID(), 'steer', turnId, {
        access: 'full-access',
      }),
      /沿用当前轮次设置/,
    );
    const queued = randomUUID();
    await env.service.message(chat.id, 'next', queued, 'queue', undefined, {
      model: 'fixture-alt-id',
      effort: 'high',
      access: 'full-access',
    });
    assert.equal(env.store.chat(chat.id).access, 'workspace-write');
    const initial = await env.service.transport!.request('test/stats');
    assert.equal(initial.starts.length, 1);
    assert.equal(initial.starts[0].sandboxPolicy, undefined);
    await env.service.message(chat.id, 'complete', randomUUID(), 'steer', turnId);
    await waitFor(
      env.store,
      () => env.store.entry(`user:${queued}`)?.status === 'sent' || undefined,
    );
    const starts = (await env.service.transport!.request('test/stats')).starts;
    assert.equal(starts[1].model, 'fixture-alt');
    assert.equal(starts[1].effort, 'high');
    assert.deepEqual(starts[1].sandboxPolicy, { type: 'dangerFullAccess' });
    assert.equal(env.store.chat(chat.id).model, 'fixture-alt');
    assert.equal(env.store.chat(chat.id).effort, 'high');
    assert.equal(env.store.chat(chat.id).access, 'full-access');
    await env.service.message(chat.id, 'next again', randomUUID(), 'queue', undefined, {
      access: 'read-only',
    });
    await waitFor(env.store, () => env.store.chat(chat.id).access === 'read-only' || undefined);
    assert.equal(env.store.chat(chat.id).model, 'fixture-alt');
  } finally {
    await env.close();
  }
});

test('message endpoint rejects a forged permission mode without starting a turn', async () => {
  const env = await setup();
  const http = createHttp(env.service);
  await new Promise<void>((ready) => http.http.listen(0, '127.0.0.1', ready));
  const address = http.http.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const token = http.auth.exchange(http.auth.pairCode(), 'Test phone', 'test');
  try {
    const chat = await env.service.create('Turn validation', env.root, null);
    const response = await fetch(`${url}/api/chats/${chat.id}/messages`, {
      method: 'POST',
      headers: {
        Cookie: `${http.auth.cookieName}=${token}`,
        'Content-Type': 'application/json',
        'X-Pocket-Client': 'web',
      },
      body: JSON.stringify({
        operationId: randomUUID(),
        text: 'hello',
        settings: { access: 'arbitrary' },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(env.store.chat(chat.id).status, 'idle');
  } finally {
    await http.close();
    await env.close();
  }
});
