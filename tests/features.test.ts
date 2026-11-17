import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, waitFor } from './helpers.ts';
import { createHttp } from '../apps/server/src/http.ts';

test('steer targets the active turn, preserves the queue and never falls back to a new turn', async () => {
  const e = await setup();
  try {
    const chat = await e.service.create('Steer', e.root, null);
    await e.service.message(chat.id, 'hang', randomUUID());
    const turnId = await waitFor(e.store, () => e.store.chat(chat.id).turnId ?? undefined);
    const later = randomUUID();
    await e.service.message(chat.id, 'normal', later, 'queue');
    await assert.rejects(
      () => e.service.message(chat.id, 'stale instructions', randomUUID(), 'steer', 'old-turn'),
      /执行轮次已经改变/,
    );
    await e.service.message(chat.id, 'extra instructions', randomUUID(), 'steer', turnId);
    assert.equal(e.store.chat(chat.id).turnId, turnId);
    assert.equal(e.service.queued().length, 1);
    assert.equal(e.store.entries(chat.id).filter((v) => v.status === 'steered').length, 1);
    await e.service.message(chat.id, 'complete', randomUUID(), 'steer');
    await waitFor(e.store, () =>
      e.store.entry(`user:${later}`)?.status === 'sent' &&
      e.store.chat(chat.id).status === 'completed'
        ? true
        : undefined,
    );
    assert.equal(e.service.queued().length, 0);
    const before = e.store.entries(chat.id).length;
    await assert.rejects(
      () => e.service.message(chat.id, 'too late', randomUUID(), 'steer'),
      /没有可追加/,
    );
    assert.equal(e.store.entries(chat.id).length, before);
    assert.equal(e.store.chat(chat.id).status, 'completed');
  } finally {
    await e.close();
  }
});

test('queued messages can be cancelled; failure cancels follow-ups instead of executing them', async () => {
  const e = await setup();
  try {
    const chat = await e.service.create('Queue', e.root, null);
    await e.service.message(chat.id, 'hang', randomUUID());
    await waitFor(e.store, () => e.store.chat(chat.id).turnId ?? undefined);
    const cancelled = randomUUID(),
      afterFailure = randomUUID();
    await e.service.message(chat.id, 'cancel me', cancelled);
    e.service.cancelQueued(cancelled);
    assert.equal(e.store.entry(`user:${cancelled}`)?.status, 'cancelled');
    assert.throws(() => e.service.cancelQueued(cancelled), /移出队列/);
    await e.service.message(chat.id, 'do not execute after failure', afterFailure);
    await e.service.message(chat.id, 'fail', randomUUID(), 'steer');
    await waitFor(e.store, () =>
      e.store.entry(`user:${afterFailure}`)?.status === 'cancelled' ? true : undefined,
    );
    assert.equal(e.store.chat(chat.id).status, 'failed');
    assert.equal(e.service.queued().length, 0);
  } finally {
    await e.close();
  }
});

test('favorites are host-persisted and constrained to roots; organizing a running chat preserves execution', async () => {
  const e = await setup();
  try {
    assert.deepEqual(await e.service.favorite(e.root, true), [e.root]);
    assert.deepEqual(await e.service.favorite(e.root, true), [e.root]);
    await assert.rejects(() => e.service.favorite('/etc', true), /允许/);
    assert.equal(JSON.parse(e.store.meta('favorites')!)[0], e.root);
    assert.deepEqual(await e.service.favorite(e.root, false), []);
    const c = await e.service.create('Old', e.root, null);
    await e.service.message(c.id, 'hang', randomUUID());
    const turnId = await waitFor(e.store, () => e.store.chat(c.id).turnId ?? undefined);
    const updated = e.service.organize(c.id, { title: ' My project ', pinned: true });
    assert.equal(updated.title, 'My project');
    assert.equal(updated.pinned, true);
    assert.equal(updated.turnId, turnId);
    assert.equal(updated.status, 'running');
    await e.service.stop(c.id);
  } finally {
    await e.close();
  }
});

test('quota keeps multiple buckets, zero usage and Unix reset seconds; never forwards account email', async () => {
  const e = await setup();
  try {
    const usage = await e.service.refreshUsage();
    assert.equal(usage.plan, 'plus');
    assert.equal(usage.buckets.length, 2);
    assert.equal(usage.buckets[0].windows[0].resetsAt, 1900000000);
    assert.equal(usage.buckets[1].windows[0].usedPercent, 0);
    assert.equal(usage.buckets[1].windows[0].resetsAt, null);
    assert(!JSON.stringify(e.service.snapshot()).includes('private@example.test'));
    e.service.notification('account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 30 } },
    });
    assert.equal(e.service.usage.buckets.length, 2);
    assert.equal(e.service.usage.buckets.find((b) => b.id === 'codex')?.windows[0].usedPercent, 30);
    e.service.notification('account/updated', { authMode: 'apikey', planType: null });
    assert.equal(e.service.usage.buckets.length, 0);
  } finally {
    await e.close();
  }
});

test('approval scope obeys provider choices and resolves the original request once', async () => {
  const e = await setup();
  try {
    const c = await e.service.create('Scope', e.root, null);
    const result = e.service.agentRequest('item/commandExecution/requestApproval', {
      threadId: c.nativeId,
      command: 'printf safe',
      availableDecisions: ['accept', 'decline'],
    });
    const r = e.store.requests().find((r) => r.status === 'pending')!;
    assert.equal(r.params.cwd, e.root);
    await assert.rejects(() => e.service.respond(r.id, 'acceptForSession'), /不支持此审批范围/);
    assert.equal(e.store.requests().find((item) => item.id === r.id)?.status, 'pending');
    await e.service.respond(r.id, 'accept');
    assert.deepEqual(await result, { decision: 'accept' });
    const sessionResult = e.service.agentRequest('item/fileChange/requestApproval', {
      threadId: c.nativeId,
      itemId: 'files',
    });
    const sessionRequest = e.store.requests().find((r) => r.status === 'pending')!;
    await e.service.respond(sessionRequest.id, 'acceptForSession');
    assert.deepEqual(await sessionResult, { decision: 'acceptForSession' });
  } finally {
    await e.close();
  }
});

test('new HTTP controls reject unauthenticated calls and validate delivery before mutating', async () => {
  const e = await setup(),
    server = createHttp(e.service);
  await new Promise<void>((r) => server.http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.http.address() as any).port}`;
  const token = server.auth.exchange(server.auth.pairCode(), 'Phone', 'test');
  const headers = {
    Cookie: server.auth.cookieName + '=' + token,
    Origin: base,
    'Content-Type': 'application/json',
    'X-Pocket-Client': 'web',
  };
  try {
    assert.equal((await fetch(base + '/api/usage')).status, 401);
    const c = await e.service.create('HTTP', e.root, null);
    const invalid = await fetch(base + `/api/chats/${c.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: randomUUID(), text: 'hello', delivery: 'draft' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(e.store.entries(c.id).length, 0);
    const renamed = await fetch(base + `/api/chats/${c.id}/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: randomUUID(), title: 'Renamed', pinned: true }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(e.store.chat(c.id).pinned, true);
    await e.service.message(c.id, 'hang', randomUUID());
    const turn = await waitFor(e.store, () => e.store.chat(c.id).turnId ?? undefined);
    const steer = (expectedTurnId?: string) =>
      fetch(base + `/api/chats/${c.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          operationId: randomUUID(),
          text: 'extra HTTP instructions',
          delivery: 'steer',
          expectedTurnId,
        }),
      });
    assert.equal((await steer()).status, 400);
    assert.equal((await steer('previous-turn')).status, 409);
    assert.equal((await steer(turn)).status, 200);
    await e.service.stop(c.id);
    const usage = await (await fetch(base + '/api/usage', { headers })).json();
    assert.equal(usage.buckets.length, 2);
  } finally {
    await server.close();
    await e.close();
  }
});

test('restart turns an interrupted message handoff into uncertain state without replaying it', async () => {
  const e = await setup();
  try {
    const c = await e.service.create('Handoff', e.root, null);
    const id = randomUUID();
    e.store.putEntry({
      id: `user:${id}`,
      chatId: c.id,
      turnId: null,
      kind: 'user',
      title: '你',
      text: 'Unconfirmed send',
      status: 'sending',
      createdAt: Date.now(),
    });
    await e.service.close();
    const { PocketService } = await import('../apps/server/src/service.ts');
    const recovered = new PocketService(e.store, e.service.host);
    assert.equal(e.store.entry(`user:${id}`)?.status, 'uncertain');
    assert.equal(recovered.queued().length, 0);
    assert.equal(recovered.ready, false);
  } finally {
    await e.close();
  }
});
